// ランクマッチの自動トーナメント。日程・出場者・組み合わせ・試合のシードは、時刻と登録内容だけから決まるので、
// どのブラウザで計算しても同じになる(ライブ配信のように、全員が同じ試合を同じ時刻に見られる)。
//   ・トーナメントは RANKED.interval 秒ごとに始まる(番号 = 開始時刻[s] / interval)
//   ・出場者は、開始時刻より前に登録された各プレイヤーの最新の版。多ければシードで抽選する
//   ・組み合わせはシードで並べた勝ち抜き戦。人数が2の累乗でなければ不戦勝をつくる
//   ・試合は1つずつ、RANKED.slot 秒ごとの枠で行う。引き分けは、勝ち上がりを決めるためだけに判定する
//   ・記録とレートはモンスターごと(monsterKey)。出場するモンスターを替えても、前のモンスターの記録は残る
import { BATTLE, RANKED } from '../config';
import { exp, log } from '../math/fmath';
import { Rng } from '../math/rng';
import type { MatchResult } from '../sim/match';
import { hexToWorld } from '../stage/hex';
import type { MatchEpisode } from '../sim/match';

/** 登録モンスターの版(サーバーの ranked_entries の1行。データ本体は含めない) */
export interface EntryVersion {
  id: number;
  owner: string;
  name: string;
  /** モンスターの識別子(同じモンスターの版は同じ値。古い登録では空) */
  monster: string;
  /** true = トーナメントへの出場登録、false = ランダムマッチ用の控え */
  tournament: boolean;
  /** 登録した時刻 [ms] */
  createdAt: number;
}

/** モンスターの識別子(レートの単位)。サーバーの monster_key() と同じ */
export function monsterKey(v: Pick<EntryVersion, 'owner' | 'monster' | 'name'>): string {
  return `${v.owner}:${v.monster || v.name}`;
}

/** ランダムマッチの試合のシード(試合の id から決まる) */
export function randomMatchSeed(id: number): number {
  return (Math.imul(id, 2654435761 | 0) + 97) | 0;
}

export function tournamentAt(timeMs: number): number {
  return Math.floor(timeMs / 1000 / RANKED.interval);
}

export function tournamentStart(t: number): number {
  return t * RANKED.interval * 1000;
}

/** トーナメント t の出場者(登録の版)。プレイヤーごとに開始時刻より前の最新の版を選び、多ければ抽選する */
export function entrantsFor(t: number, versions: readonly EntryVersion[]): EntryVersion[] {
  const start = tournamentStart(t);
  const latest = new Map<string, EntryVersion>();
  for (const v of versions) {
    if (!v.tournament || v.createdAt >= start) continue;
    const cur = latest.get(v.owner);
    if (!cur || v.createdAt > cur.createdAt || (v.createdAt === cur.createdAt && v.id > cur.id)) latest.set(v.owner, v);
  }
  // 並び順を決めてから(登録の版の番号順)、シードで並べ替える
  const all = [...latest.values()].sort((a, b) => a.id - b.id);
  const rng = new Rng(t * 7919 + 17);
  for (let i = all.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, RANKED.maxEntrants);
}

/** 試合のシード */
export function matchSeed(t: number, match: number): number {
  return (t * 104729 + match * 7883 + 12345) | 0;
}

export interface BracketMatch {
  /** 試合の番号(行う順) */
  index: number;
  round: number;
  /** 出場者(entrants の添字)。前の試合の勝者が決まるまでは null */
  a: number | null;
  b: number | null;
  /** 前の試合から勝ち上がる場合、その試合の番号 */
  fromA: number | null;
  fromB: number | null;
}

/**
 * 組み合わせ。entrants を2の累乗の枠に入れ、空き枠は不戦勝にする。
 * 不戦勝の試合は作らず、勝ち上がりだけを反映する。試合は1回戦から順に番号をつける
 */
export function bracketFor(count: number): BracketMatch[] {
  if (count < 2) return [];
  let size = 1;
  while (size < count) size *= 2;
  // 枠 i に入る出場者(空き枠は null)。不戦勝が偏らないよう、空き枠は2つの枠の後ろ側に置く
  const slots: (number | null)[] = new Array(size).fill(null);
  const byes = size - count;
  let next = 0;
  for (let i = 0; i < size / 2; i++) {
    slots[2 * i] = next++;
    slots[2 * i + 1] = i < size / 2 - byes ? next++ : null;
  }
  const matches: BracketMatch[] = [];
  // 各枠の「勝ち上がり元」:出場者 or 試合
  type Src = { entrant: number } | { match: number };
  let current: Src[] = [];
  for (let i = 0; i < size; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (a !== null && b !== null) {
      matches.push({
        index: matches.length,
        round: 0,
        a,
        b,
        fromA: null,
        fromB: null,
      });
      current.push({ match: matches.length - 1 });
    } else current.push({ entrant: (a ?? b)! });
  }
  let round = 1;
  while (current.length > 1) {
    const nextRound: Src[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const x = current[i];
      const y = current[i + 1];
      matches.push({
        index: matches.length,
        round,
        a: 'entrant' in x ? x.entrant : null,
        b: 'entrant' in y ? y.entrant : null,
        fromA: 'match' in x ? x.match : null,
        fromB: 'match' in y ? y.match : null,
      });
      nextRound.push({ match: matches.length - 1 });
    }
    current = nextRound;
    round++;
  }
  return matches;
}

/** 試合 m の開始時刻 [ms](紹介の時間を含む枠の始まり) */
export function matchSlotStart(t: number, match: number): number {
  return tournamentStart(t) + match * RANKED.slot * 1000;
}

/** 試合の結果(引き分けでも、勝ち上がる側 advance は必ず決まる) */
export interface RankedOutcome {
  /** 0 = a の勝ち、1 = b の勝ち、null = 引き分け(レートの計算では0.5ずつ) */
  winner: 0 | 1 | null;
  /** 勝ち上がる側(引き分けのときは判定で決める) */
  advance: 0 | 1;
  cause: 'pushed' | 'fell' | 'timeout' | 'both';
  /** 試合が終わった時刻 [s] */
  time: number;
}

/**
 * 試合の結果から、勝ち上がる側を決める。時間切れなら最終地点に近い方、同時に脱落したらシードの抽選
 */
export function decideOutcome(m: MatchEpisode, r: MatchResult, seed: number): RankedOutcome {
  if (r.winner !== null) {
    const loser = 1 - r.winner;
    return {
      winner: r.winner as 0 | 1,
      advance: r.winner as 0 | 1,
      cause: r.causes[loser] === 'pushed' ? 'pushed' : 'fell',
      time: r.time,
    };
  }
  if (r.outAt.every((x) => x !== null)) {
    const coin = new Rng(seed ^ 0x5bd1e995).int(2) as 0 | 1;
    return { winner: null, advance: coin, cause: 'both', time: r.time };
  }
  const stage = m.stage!;
  const fp = hexToWorld(stage.finalPoint, stage.size);
  const d = m.fighters.map((f) => {
    const p = f.position();
    return Math.sqrt((p.x - fp.x) ** 2 + (p.z - fp.z) ** 2);
  });
  return {
    winner: null,
    advance: d[0] <= d[1] ? 0 : 1,
    cause: 'timeout',
    time: Math.min(r.time, BATTLE.timeLimit),
  };
}

// ---- レート(Elo) ----

export interface RankedResultRow {
  tournament: number;
  match: number;
  /** 登録の版の id */
  a: number;
  b: number;
  winner: 0 | 1 | null;
  cause: string | null;
}

export interface PlayerStats {
  /** モンスターの識別子 */
  key: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  /** 押し出して勝った回数 */
  pushWins: number;
}

/**
 * トーナメントの正式な結果から、モンスターごとのレートと勝敗を計算する(トーナメント・試合の順に1試合ずつ反映する)。
 * keyOf は登録の版の id からモンスターの識別子を引く
 */
export function computeStats(results: readonly RankedResultRow[], keyOf: (entryId: number) => string | undefined): Map<string, PlayerStats> {
  const ordered = [...results].sort((x, y) => x.tournament - y.tournament || x.match - y.match);
  return computeRatings(ordered.map((r) => ({ a: keyOf(r.a), b: keyOf(r.b), winner: r.winner, cause: r.cause })));
}

export interface RatedGame {
  /** モンスターの識別子 */
  a: string | undefined;
  b: string | undefined;
  winner: 0 | 1 | null;
  cause: string | null;
}

/** 試合の順に並んだ結果から、レート(Elo)と勝敗を計算する */
export function computeRatings(games: readonly RatedGame[]): Map<string, PlayerStats> {
  const stats = new Map<string, PlayerStats>();
  const get = (key: string) => {
    let s = stats.get(key);
    if (!s) {
      s = { key, rating: RANKED.initialRating, wins: 0, losses: 0, draws: 0, pushWins: 0 };
      stats.set(key, s);
    }
    return s;
  };
  const ln10 = log(10);
  for (const r of games) {
    const oa = r.a;
    const ob = r.b;
    if (!oa || !ob || oa === ob) continue;
    const A = get(oa);
    const B = get(ob);
    // 期待勝率 = 1 / (1 + 10^((Rb - Ra) / 400))
    const ea = 1 / (1 + exp(((B.rating - A.rating) / 400) * ln10));
    const sa = r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5;
    A.rating += RANKED.kFactor * (sa - ea);
    B.rating += RANKED.kFactor * (1 - sa - (1 - ea));
    if (r.winner === 0) {
      A.wins++;
      B.losses++;
      if (r.cause === 'pushed') A.pushWins++;
    } else if (r.winner === 1) {
      B.wins++;
      A.losses++;
      if (r.cause === 'pushed') B.pushWins++;
    } else {
      A.draws++;
      B.draws++;
    }
  }
  return stats;
}
