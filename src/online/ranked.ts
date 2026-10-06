// ランクマッチのサーバー(Supabase)とのやりとりと、計算用Workerの窓口。
// サーバーに置くのは、プレイヤー名・登録モンスター(版ごと)・試合の結果の報告だけ。
// 試合そのものは各ブラウザで計算する(決定論的なので、誰が計算しても同じ結果になる)。
import type { Character } from '../core/character';
import { characterToJson, parseCharacter } from '../core/codec';
import type { RaceRecord } from '../core/ranked/run';
import { computeRatings, randomMatchSeed, type EntryVersion, type PlayerStats, type RankedOutcome, type RankedResultRow } from '../core/ranked/tournament';
import type { FighterData } from '../core/training/tasks';
import type { RankedRequest, RankedResponse } from '../workers/ranked.worker';
import { getSetting, setSetting } from '../storage/db';
import { ensureSession, onlineConfigured, supabaseClient } from './client';

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
    if (code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/.test(res.error.message)) throw new RankedNotReadyError();
    throw new Error(res.error.message);
  }
  return res.data as T;
}

export interface Player {
  id: string;
  name: string;
}

export async function myPlayer(): Promise<{
  id: string;
  player: Player | null;
}> {
  const id = await ensureSession();
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
}

export async function listPlayers(): Promise<Player[]> {
  return check(await supabaseClient().from('players').select('id, name').limit(5000)) as Player[];
}

/** 登録の版を作る。同じモンスターで中身が変わっていなければ、前の版を使い回す(ランダムマッチ用の控え) */
async function insertEntry(c: Character, monster: string, tournament: boolean): Promise<number> {
  if (!c.motor || !c.decision) throw new Error('運動脳と判断脳を鍛えたキャラだけ登録できます');
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
  return row.id;
}

/**
 * トーナメントに自分のモンスターを登録する(1人1体。登録し直すと新しい版になり、次のトーナメントから使われる)。
 * monster はモンスターの識別子(このブラウザのキャラの id)。記録とレートはモンスターごとに残る
 */
export async function registerRankedEntry(c: Character, monster: string): Promise<void> {
  await insertEntry(c, monster, true);
}

export async function listEntryVersions(): Promise<EntryVersion[]> {
  const rows = check(await supabaseClient().from('ranked_entries').select('id, owner, name, monster, tournament, created_at').order('id').limit(10000)) as {
    id: number;
    owner: string;
    name: string;
    monster: string;
    tournament: boolean;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    owner: r.owner,
    name: r.name,
    monster: r.monster ?? '',
    tournament: r.tournament ?? true,
    createdAt: Date.parse(r.created_at),
  }));
}

// ---- ランダムマッチ ----

export interface RandomMatch {
  id: number;
  /** 挑戦した側(a)と相手(b)の登録の版 */
  a: number;
  b: number;
  aMonster: string;
  bMonster: string;
  createdAt: number;
}

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

export async function listRandomMatches(): Promise<RandomMatch[]> {
  const rows = check(
    await supabaseClient().from('random_matches').select('id, a, b, a_monster, b_monster, created_at').order('id').limit(20000),
  ) as RandomMatchRow[];
  return rows.map(toMatch);
}

export interface RandomResult {
  matchId: number;
  winner: 0 | 1 | null;
  cause: string | null;
}

export async function fetchRandomResults(): Promise<RandomResult[]> {
  const rows = check(await supabaseClient().from('random_results').select('match_id, winner, cause').limit(20000)) as {
    match_id: number;
    winner: 0 | 1 | null;
    cause: string | null;
  }[];
  return rows.map((r) => ({ matchId: Number(r.match_id), winner: r.winner, cause: r.cause }));
}

export async function reportRandomResult(matchId: number, o: RankedOutcome): Promise<void> {
  await ensureSession();
  const res = await supabaseClient()
    .from('random_reports')
    .upsert({ match_id: matchId, winner: o.winner, cause: o.cause }, { onConflict: 'match_id,reporter', ignoreDuplicates: true });
  check(res);
}

/** ランダムマッチのレートと勝敗(試合の順に計算する。正式な結果が出た試合だけ) */
export function randomStats(matches: readonly RandomMatch[], results: readonly RandomResult[]): Map<string, PlayerStats> {
  const byId = new Map(results.map((r) => [r.matchId, r]));
  const games = [...matches]
    .sort((x, y) => x.id - y.id)
    .flatMap((m) => {
      const r = byId.get(m.id);
      return r ? [{ a: m.aMonster, b: m.bMonster, winner: r.winner, cause: r.cause }] : [];
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

/** 登録の版のデータ(脳つきのキャラ)。検証に通らないデータは null */
export async function entryFighters(ids: number[]): Promise<Map<number, FighterData | null>> {
  const missing = [...new Set(ids)].filter((id) => !dataCache.has(id));
  if (missing.length > 0) {
    const rows = check(await supabaseClient().from('ranked_entries').select('id, data').in('id', missing)) as { id: number; data: unknown }[];
    for (const r of rows) {
      try {
        const c = parseCharacter(r.data);
        dataCache.set(
          r.id,
          c.motor && c.decision
            ? {
                blueprint: c.blueprint,
                motor: c.motor,
                decision: c.decision,
                controller: 'brain',
              }
            : null,
        );
      } catch {
        dataCache.set(r.id, null);
      }
    }
  }
  return new Map(ids.map((id) => [id, dataCache.get(id) ?? null]));
}

/** 計算した試合の結果を報告する(同じ試合を2回報告しても1回分) */
export async function reportResult(tournament: number, match: number, a: number, b: number, o: RankedOutcome): Promise<void> {
  await ensureSession();
  const res = await supabaseClient()
    .from('ranked_reports')
    .upsert({ tournament, match, a, b, winner: o.winner, cause: o.cause }, { onConflict: 'tournament,match,reporter', ignoreDuplicates: true });
  check(res);
}

export async function fetchResults(): Promise<RankedResultRow[]> {
  const rows = check(await supabaseClient().from('ranked_results').select('tournament, match, a, b, winner, cause').limit(20000)) as RankedResultRow[];
  return rows.map((r) => ({ ...r, tournament: Number(r.tournament) }));
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
