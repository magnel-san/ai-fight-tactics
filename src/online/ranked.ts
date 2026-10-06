// ランクマッチのサーバー(Supabase)とのやりとりと、計算用Workerの窓口。
// サーバーに置くのは、プレイヤー名・登録モンスター(版ごと)・試合の結果の報告だけ。
// 試合そのものは各ブラウザで計算する(決定論的なので、誰が計算しても同じ結果になる)。
import type { Character } from '../core/character';
import { characterToJson, parseCharacter } from '../core/codec';
import type { RaceRecord } from '../core/ranked/run';
import type { EntryVersion, RankedOutcome, RankedResultRow } from '../core/ranked/tournament';
import type { FighterData } from '../core/training/tasks';
import type { RankedRequest, RankedResponse } from '../workers/ranked.worker';
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

/** ランクマッチに自分のモンスターを登録する(1人1体。登録し直すと新しい版になり、次のトーナメントから使われる) */
export async function registerRankedEntry(c: Character): Promise<void> {
  if (!c.motor || !c.decision) throw new Error('運動脳と判断脳を鍛えたキャラだけ登録できます');
  await ensureSession();
  check(
    await supabaseClient()
      .from('ranked_entries')
      .insert({
        name: c.name,
        data: characterToJson({ ...c, readOnly: false }),
      }),
  );
}

export async function listEntryVersions(): Promise<EntryVersion[]> {
  const rows = check(await supabaseClient().from('ranked_entries').select('id, owner, name, created_at').order('id').limit(5000)) as {
    id: number;
    owner: string;
    name: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    owner: r.owner,
    name: r.name,
    createdAt: Date.parse(r.created_at),
  }));
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
