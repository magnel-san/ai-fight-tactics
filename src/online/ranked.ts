// ランクマッチのサーバー(Supabase)とのやりとりと、計算用Workerの窓口。
// サーバーに置くのは、プレイヤー名・登録モンスター(版ごと)・試合の結果の報告だけ。
// 試合そのものは各ブラウザで計算する(決定論的なので、誰が計算しても同じ結果になる)。
//
// 通信を減らすしくみ(docs/DATA.md)
//   ・取得した一覧はブラウザ(IndexedDB)に保存し、次からは「前回より新しい分」だけを取得する
//     (登録の版とランダムマッチの試合は追記のみなので、id が前回より大きい行だけを取ればよい)
//   ・登録の版のデータ(脳つきのキャラ、最大32KB)は書き換えられないので、一度取得したらブラウザに保存して二度と取得しない
//   ・取得は自動では行わない。画面を開いたとき・トーナメントが始まったとき(出場者を決めるため)・更新ボタンを押したときだけ
//   ・結果の報告はまとめて1回で送り、一度報告した試合はブラウザに記録して送り直さない
import { battleFighter, canEnter, type Character } from '../core/character';
import { characterToJson, parseCharacter } from '../core/codec';
import type { RaceRecord } from '../core/ranked/run';
import { RANKED, SIM_VERSION } from '../core/config';
import {
  computeRatings,
  randomMatchSeed,
  tournamentAt,
  type EntryVersion,
  type MonsterGroups,
  type PlayerStats,
  type RankedOutcome,
  type RankedResultRow,
} from '../core/ranked/tournament';
import type { FighterData } from '../core/training/tasks';
import type { RankedRequest, RankedResponse } from '../workers/ranked.worker';
import { getSetting, setSetting } from '../storage/db';
import { ensureSession, onlineConfigured, serverError, supabaseClient } from './client';

export { onlineConfigured };

/** ランクマッチ用のテーブルがまだ作られていない(schema-ranked.sql を実行していない) */
export class RankedNotReadyError extends Error {
  constructor() {
    super('ランクマッチの準備ができていません(Supabase で supabase/schema-ranked.sql を実行してください)');
  }
}

function check<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T {
  if (res.error) {
    const code = res.error.code ?? '';
    // 列がない(サーバーの SQL が古い)ときは、呼び出し側で前の形に切り替えられるよう、コードをつけたまま投げる
    if (code === '42703' || code === 'PGRST204' || code === '42P10') throw Object.assign(new Error(res.error.message), { code });
    // テーブルがない(schema-ranked.sql を実行していない)
    if (code === '42P01' || code === 'PGRST205' || /relation .* does not exist|Could not find the table/.test(res.error.message))
      throw new RankedNotReadyError();
    throw serverError(res.error);
  }
  return res.data as T;
}

/** Supabase は1回に最大1000行しか返さないので、ページに分けて取得する */
const PAGE = 1000;
async function pages<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const rows = check(await query(from, from + PAGE - 1));
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
}

/** ブラウザに保存するときのキー(Supabase のプロジェクトごとに分ける) */
const scope = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const CACHE_KEY = `ranked-cache:${scope}`;
const REPORTED_KEY = `ranked-reported:${scope}`;
const entryDataKey = (id: number) => `ranked-entry-data:${scope}:${id}`;
/**
 * 結果を取り直す範囲(トーナメントの数)。前回の取得より RESULT_WINDOW 回前のトーナメントから後をすべて取り直す
 * (報告が遅れて届いたり、多数決が変わったりした結果も拾うため)。これより古い結果は確定しているとみなす
 */
const RESULT_WINDOW = 6;
/**
 * 保存の形式。上げると、すべての端末が次の取得で一度だけ全部を取り直す
 * (2:前回の取得から時間があくと、その間のトーナメントの結果を取りこぼしていた不具合を直したので、取りこぼした端末を直す)
 */
const CACHE_VERSION = 2;

export interface Player {
  id: string;
  name: string;
}

export interface RandomMatch {
  id: number;
  /** 挑戦した側(a)と相手(b)の登録の版 */
  a: number;
  b: number;
  aMonster: string;
  bMonster: string;
  createdAt: number;
}

export interface RandomResult {
  matchId: number;
  winner: 0 | 1 | null;
  cause: string | null;
  /** その結果を報告した人数 */
  reports: number;
  /** 計算の版(古い報告は0) */
  sim?: number;
}

/** ブラウザに保存しているランクマッチの情報 */
export interface RankedSnapshot {
  versions: EntryVersion[];
  players: Map<string, string>;
  results: RankedResultRow[];
  randomMatches: RandomMatch[];
  randomResults: RandomResult[];
  /** 最後にサーバーから取得した時刻 [ms](一度も取得していなければ 0) */
  syncedAt: number;
  /** サーバーに、このページより新しい計算の版の結果がある(ページが古い。報告しない) */
  outdated: boolean;
  /** サーバーの設定(SQL)が古く、計算の版を記録できない(fix-ranked-consistency.sql を実行してほしい) */
  needsSql: boolean;
}

interface Cache {
  version: typeof CACHE_VERSION;
  versions: EntryVersion[];
  players: [string, string][];
  /** 取得済みのプレイヤーの更新時刻のうち、いちばん新しいもの */
  playersAt: string;
  results: RankedResultRow[];
  randomMatches: RandomMatch[];
  randomResults: RandomResult[];
  syncedAt: number;
  needsSql?: boolean;
}

const emptyCache = (): Cache => ({
  version: CACHE_VERSION,
  versions: [],
  players: [],
  playersAt: '',
  results: [],
  randomMatches: [],
  randomResults: [],
  syncedAt: 0,
});

let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;

async function loadCache(): Promise<Cache> {
  if (cache) return cache;
  loading ??= getSetting<Cache>(CACHE_KEY).then((c) => {
    cache = c && c.version === CACHE_VERSION ? c : emptyCache();
    return cache;
  });
  return loading;
}

const toSnapshot = (c: Cache): RankedSnapshot => ({
  versions: c.versions,
  players: new Map(c.players),
  results: c.results,
  randomMatches: c.randomMatches,
  randomResults: c.randomResults,
  syncedAt: c.syncedAt,
  outdated: c.results.some((r) => (r.sim ?? 0) > SIM_VERSION) || c.randomResults.some((r) => (r.sim ?? 0) > SIM_VERSION),
  needsSql: !!c.needsSql,
});

const listeners = new Set<(s: RankedSnapshot) => void>();

/** 保存している情報が変わったら呼ばれる。戻り値は登録の解除 */
export function subscribeRanked(f: (s: RankedSnapshot) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

async function commit(c: Cache): Promise<RankedSnapshot> {
  await setSetting(CACHE_KEY, c);
  const s = toSnapshot(c);
  for (const f of listeners) f(s);
  return s;
}

/** ブラウザに保存している情報(通信しない) */
export async function rankedSnapshot(): Promise<RankedSnapshot> {
  return toSnapshot(await loadCache());
}

let syncing: Promise<RankedSnapshot> | null = null;

/** サーバーから、前回より新しい分だけを取得する(同時に呼ばれたら1回にまとめる) */
export function syncRanked(): Promise<RankedSnapshot> {
  syncing ??= doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync(): Promise<RankedSnapshot> {
  await ensureSession();
  const c = await loadCache();
  const sb = supabaseClient();

  // 登録の版(追記のみ):前回より新しい id だけ
  const maxEntry = c.versions.length ? c.versions[c.versions.length - 1].id : 0;
  const entries = await pages<{ id: number; owner: string; name: string; monster: string; tournament: boolean; created_at: string }>((from, to) =>
    sb.from('ranked_entries').select('id, owner, name, monster, tournament, created_at').gt('id', maxEntry).order('id').range(from, to),
  );
  const versions = [
    ...c.versions,
    ...entries.map((r) => ({
      id: Number(r.id),
      owner: r.owner,
      name: r.name,
      monster: r.monster ?? '',
      tournament: r.tournament ?? true,
      createdAt: Date.parse(r.created_at),
    })),
  ];

  // プレイヤー:前回より後に名前を登録・変更した人だけ
  const players = await pages<{ id: string; name: string; updated_at: string }>((from, to) => {
    const q = sb.from('players').select('id, name, updated_at');
    return (c.playersAt ? q.gt('updated_at', c.playersAt) : q).order('updated_at').range(from, to);
  });
  const playerMap = new Map(c.players);
  let playersAt = c.playersAt;
  for (const p of players) {
    playerMap.set(p.id, p.name);
    if (p.updated_at > playersAt) playersAt = p.updated_at;
  }

  // トーナメントの結果:前回の取得の少し前のトーナメントから後を、すべて取り直す(それより古いものは確定済み)。
  // 「いまの少し前から」にすると、前回の取得から時間があいたとき、その間のトーナメントの結果を取りこぼしてしまう
  const since = c.results.length && c.syncedAt ? tournamentAt(Math.min(c.syncedAt, Date.now())) - RESULT_WINDOW : 0;
  // サーバーの SQL が古い(版の列がない)ときは、前の形で取得する
  let needsSql = false;
  const resultQuery = (cols: string) =>
    pages<RankedResultRow>((from, to) =>
      sb.from('ranked_results').select(cols).gte('tournament', since).order('tournament').order('match').range(from, to).returns<RankedResultRow[]>(),
    );
  let results: RankedResultRow[];
  try {
    results = await resultQuery('tournament, match, a, b, winner, advance, cause, sim, reports');
  } catch (e) {
    if (!isMissingColumn(e)) throw e;
    needsSql = true;
    results = await resultQuery('tournament, match, a, b, winner, cause, reports');
  }
  const mergedResults = [
    ...c.results.filter((r) => r.tournament < since),
    ...results.map((r) => ({
      ...r,
      tournament: Number(r.tournament),
      a: Number(r.a),
      b: Number(r.b),
      reports: Number(r.reports ?? 1),
      sim: Number(r.sim ?? 0),
    })),
  ];

  // ランダムマッチの試合(追記のみ):前回より新しい id だけ
  const maxMatch = c.randomMatches.length ? c.randomMatches[c.randomMatches.length - 1].id : 0;
  const matches = await pages<RandomMatchRow>((from, to) =>
    sb.from('random_matches').select('id, a, b, a_monster, b_monster, created_at').gt('id', maxMatch).order('id').range(from, to),
  );
  const randomMatches = [...c.randomMatches, ...matches.map(toMatch)];

  // ランダムマッチの結果:まだ結果を持っていない試合と、前回の取得の少し前より後にできた試合(報告が遅れて結果が変わることがある)のうち、
  // いちばん古いものから後だけ
  const known = new Set(c.randomResults.map((r) => r.matchId));
  const recent = c.syncedAt - RESULT_WINDOW * RANKED.interval * 1000;
  const pendingIds = randomMatches.filter((m) => !known.has(m.id) || m.createdAt >= recent).map((m) => m.id);
  let randomResults = c.randomResults;
  if (pendingIds.length > 0) {
    const fromId = Math.min(...pendingIds);
    type Row = { match_id: number; winner: 0 | 1 | null; cause: string | null; reports: number; sim?: number };
    const randomQuery = (cols: string) =>
      pages<Row>((from, to) => sb.from('random_results').select(cols).gte('match_id', fromId).order('match_id').range(from, to).returns<Row[]>());
    let rows: Row[];
    try {
      rows = await randomQuery(needsSql ? 'match_id, winner, cause, reports' : 'match_id, winner, cause, sim, reports');
    } catch (e) {
      if (!isMissingColumn(e)) throw e;
      needsSql = true;
      rows = await randomQuery('match_id, winner, cause, reports');
    }
    const byId = new Map(randomResults.map((r) => [r.matchId, r]));
    for (const r of rows)
      byId.set(Number(r.match_id), { matchId: Number(r.match_id), winner: r.winner, cause: r.cause, reports: Number(r.reports ?? 1), sim: Number(r.sim ?? 0) });
    randomResults = [...byId.values()].sort((x, y) => x.matchId - y.matchId);
  }

  cache = {
    version: CACHE_VERSION,
    versions,
    players: [...playerMap],
    playersAt,
    results: mergedResults,
    randomMatches,
    randomResults,
    syncedAt: Date.now(),
    needsSql,
  };
  return commit(cache);
}

export async function myPlayer(): Promise<{
  id: string;
  player: Player | null;
}> {
  const id = await ensureSession();
  const c = await loadCache();
  const known = c.players.find(([pid]) => pid === id);
  if (known) return { id, player: { id, name: known[1] } };
  const rows = check(await supabaseClient().from('players').select('id, name').eq('id', id));
  return { id, player: (rows as Player[])[0] ?? null };
}

export async function savePlayerName(name: string): Promise<void> {
  const id = await ensureSession();
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) throw new Error('プレイヤー名を入力してください');
  const res = await supabaseClient().from('players').upsert({ id, name: trimmed });
  if (res.error?.code === '23505') throw new Error('その名前はほかのプレイヤーが使っています');
  check(res);
  // 自分の名前はすぐ反映する(ほかの人の変更は次の取得で)
  const c = await loadCache();
  c.players = [...c.players.filter(([pid]) => pid !== id), [id, trimmed]];
  await commit(c);
}

/** 登録の版を作る。同じモンスターで中身が変わっていなければ、前の版を使い回す(ランダムマッチ用の控え) */
async function insertEntry(c: Character, monster: string, tournament: boolean): Promise<number> {
  if (!canEnter(c)) throw new Error(`トレーニング「2. 対象を追う」に合格したキャラだけ登録できます`);
  await ensureSession();
  const data = characterToJson({ ...c, readOnly: false });
  const json = JSON.stringify(data);
  const key = `ranked-entry:${monster}`;
  if (!tournament) {
    const last = await getSetting<{ id: number; json: string }>(key);
    if (last && last.json === json) return last.id;
  }
  const row = check(await supabaseClient().from('ranked_entries').insert({ name: c.name, monster, tournament, data }).select('id').single()) as { id: number };
  await setSetting(key, { id: row.id, json });
  // 自分で登録したデータは取得し直さなくてよいように保存しておく
  await setSetting(entryDataKey(Number(row.id)), data);
  return Number(row.id);
}

/**
 * トーナメントに自分のモンスターを登録する(1人1体。登録し直すと新しい版になり、次のトーナメントから使われる)。
 * monster はモンスターの識別子(このブラウザのキャラの id)。記録とレートはモンスターごとに残る
 */
export async function registerRankedEntry(c: Character, monster: string): Promise<void> {
  await insertEntry(c, monster, true);
  await syncRanked();
}

// ---- ランダムマッチ ----

interface RandomMatchRow {
  id: number;
  a: number;
  b: number;
  a_monster: string;
  b_monster: string;
  created_at: string;
}

const toMatch = (r: RandomMatchRow): RandomMatch => ({
  id: Number(r.id),
  a: Number(r.a),
  b: Number(r.b),
  aMonster: r.a_monster,
  bMonster: r.b_monster,
  createdAt: Date.parse(r.created_at),
});

/** いまのキャラでランダムマッチを始める(相手はサーバーが選ぶ)。戦っていない相手がいなければ null */
export async function startRandomMatch(c: Character, monster: string): Promise<RandomMatch | null> {
  const entry = await insertEntry(c, monster, false);
  const rows = check(await supabaseClient().rpc('start_random_match', { entry })) as RandomMatchRow[];
  return rows.length ? toMatch(rows[0]) : null;
}

export async function reportRandomResult(matchId: number, o: RankedOutcome): Promise<void> {
  await ensureSession();
  const c = await loadCache();
  if (toSnapshot(c).outdated) return;
  const sb = supabaseClient();
  const res = await sb
    .from('random_reports')
    .upsert({ match_id: matchId, winner: o.winner, cause: o.cause, sim: SIM_VERSION }, { onConflict: 'match_id,reporter,sim', ignoreDuplicates: true });
  if (res.error && isMissingColumn(res.error)) {
    check(
      await sb
        .from('random_reports')
        .upsert({ match_id: matchId, winner: o.winner, cause: o.cause }, { onConflict: 'match_id,reporter', ignoreDuplicates: true }),
    );
    return;
  }
  check(res);
}

/** ランダムマッチのレートと勝敗(試合の順に計算する。正式な結果が出た試合だけ) */
export function randomStats(matches: readonly RandomMatch[], results: readonly RandomResult[], groups: MonsterGroups): Map<string, PlayerStats> {
  const byId = new Map(results.map((r) => [r.matchId, r]));
  const games = [...matches]
    .sort((x, y) => x.id - y.id)
    .flatMap((m) => {
      const r = byId.get(m.id);
      // 試合に記録されたモンスター(サーバーの識別子)を、まとめたモンスターに置き換える
      const a = groups.keyOf.get(m.a) ?? groups.byServerKey.get(m.aMonster);
      const b = groups.keyOf.get(m.b) ?? groups.byServerKey.get(m.bMonster);
      return r ? [{ a, b, winner: r.winner, cause: r.cause }] : [];
    });
  return computeRatings(games);
}

/** ランダムマッチの試合を計算して報告する(試合のシードは id から決まるので、誰が計算しても同じ結果) */
export async function settleRandomMatch(m: RandomMatch): Promise<RankedOutcome | null> {
  const f = await entryFighters([m.a, m.b]);
  const fa = f.get(m.a);
  const fb = f.get(m.b);
  if (!fa || !fb) return null;
  const o = await computeMatch(fa, fb, randomMatchSeed(m.id));
  await reportRandomResult(m.id, o);
  return o;
}

const settled = new Set<number>();

/** 挑戦した人が報告しないまま残った試合を、代わりに計算して報告する(1回に limit 試合まで) */
export async function settlePendingRandomMatches(matches: readonly RandomMatch[], results: readonly RandomResult[], limit = 3): Promise<number> {
  const done = new Set(results.map((r) => r.matchId));
  const old = Date.now() - 2 * 60_000;
  let n = 0;
  for (const m of matches) {
    if (n >= limit) break;
    if (done.has(m.id) || settled.has(m.id) || m.createdAt > old) continue;
    settled.add(m.id);
    await settleRandomMatch(m);
    n++;
  }
  return n;
}

const dataCache = new Map<number, FighterData | null>();

function toFighter(data: unknown): FighterData | null {
  try {
    const c = parseCharacter(data);
    return battleFighter(c);
  } catch {
    return null;
  }
}

/**
 * 登録の版のデータ(脳つきのキャラ)。検証に通らないデータは null。
 * 登録の版は書き換えられないので、一度取得したらブラウザに保存し、二度と取得しない
 */
export async function entryFighters(ids: number[]): Promise<Map<number, FighterData | null>> {
  const unique = [...new Set(ids)].filter((id) => !dataCache.has(id));
  const missing: number[] = [];
  for (const id of unique) {
    const saved = await getSetting<unknown>(entryDataKey(id));
    if (saved !== undefined) dataCache.set(id, toFighter(saved));
    else missing.push(id);
  }
  if (missing.length > 0) {
    const rows = check(await supabaseClient().from('ranked_entries').select('id, data').in('id', missing)) as { id: number; data: unknown }[];
    for (const r of rows) {
      dataCache.set(Number(r.id), toFighter(r.data));
      await setSetting(entryDataKey(Number(r.id)), r.data);
    }
  }
  return new Map(ids.map((id) => [id, dataCache.get(id) ?? null]));
}

export interface PendingReport {
  tournament: number;
  match: number;
  a: number;
  b: number;
  outcome: RankedOutcome;
}

let reportedKeys: Set<string> | null = null;

/**
 * 計算した試合の結果をまとめて報告する。一度報告した試合と、すでに十分な人数(3人以上)が同じ結果を報告した試合は送らない
 */
export async function reportResults(list: readonly PendingReport[]): Promise<number> {
  reportedKeys ??= new Set(((await getSetting<string[]>(REPORTED_KEY)) ?? []).slice(-1000));
  const c = await loadCache();
  // このページより新しい版の結果がサーバーにあるなら、古い計算は報告しない
  if (toSnapshot(c).outdated) return 0;
  const key = (r: { tournament: number; match: number }) => `${SIM_VERSION}:${r.tournament}:${r.match}`;
  // すでに十分な人数(3人以上)が、同じ版で報告した試合は送らない
  const settledKeys = new Set(c.results.filter((r) => (r.reports ?? 1) >= 3 && (r.sim ?? 0) === SIM_VERSION).map(key));
  const rows = list.filter((r) => !reportedKeys!.has(key(r)) && !settledKeys.has(key(r)));
  if (rows.length === 0) return 0;
  await ensureSession();
  const sb = supabaseClient();
  const body = rows.map((r) => ({
    tournament: r.tournament,
    match: r.match,
    a: r.a,
    b: r.b,
    winner: r.outcome.winner,
    advance: r.outcome.advance,
    cause: r.outcome.cause,
    sim: SIM_VERSION,
  }));
  const res = await sb.from('ranked_reports').upsert(body, { onConflict: 'tournament,match,reporter,sim', ignoreDuplicates: true });
  if (res.error && isMissingColumn(res.error)) {
    // サーバーの SQL が古い:前の形で送る
    const old = body.map(({ advance: _a, sim: _s, ...rest }) => rest);
    check(await sb.from('ranked_reports').upsert(old, { onConflict: 'tournament,match,reporter', ignoreDuplicates: true }));
  } else check(res);
  for (const r of rows) reportedKeys.add(key(r));
  await setSetting(REPORTED_KEY, [...reportedKeys].slice(-1000));
  return rows.length;
}

/** サーバーの SQL が古く、列(sim・advance)がない・主キーが合わないときのエラーか */
function isMissingColumn(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  const code = err?.code ?? '';
  const msg = err?.message ?? String(e);
  return (
    code === '42703' ||
    code === 'PGRST204' ||
    code === '42P10' ||
    /column .*(sim|advance)|sim.*does not exist|advance.*does not exist|no unique or exclusion constraint/.test(msg)
  );
}

// ---- 計算用Worker ----

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (r: RankedResponse) => void>();

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

function call(req: WithoutId<RankedRequest>): Promise<RankedResponse> {
  worker ??= (() => {
    const w = new Worker(new URL('../workers/ranked.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<RankedResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    return w;
  })();
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ ...req, id } as RankedRequest);
  });
}

export async function computeMatch(a: FighterData, b: FighterData, seed: number): Promise<RankedOutcome> {
  const r = await call({ type: 'match', a, b, seed });
  if (r.type !== 'match') throw new Error(r.type === 'error' ? r.message : '計算に失敗しました');
  return r.outcome;
}

const raceCache = new Map<number, Promise<RaceRecord>>();

/** かけっこの公式記録(登録の版ごとに1回だけ計算する) */
export function computeRace(entryId: number, f: FighterData): Promise<RaceRecord> {
  let p = raceCache.get(entryId);
  if (!p) {
    p = call({ type: 'race', fighter: f }).then((r) => {
      if (r.type !== 'race') throw new Error(r.type === 'error' ? r.message : '計算に失敗しました');
      return r.record;
    });
    raceCache.set(entryId, p);
  }
  return p;
}
