// ランクマッチの試合と、かけっこの公式記録の計算(Worker でもメインスレッドでも同じ結果になる)
import { RANKED } from '../config';
import { jumpRecord } from '../events/highjump';
import { RaceEpisode } from '../events/race';
import { trackRecord, type TrackRecord } from '../events/track';
import type { Rapier } from '../physics/rapier';
import { MatchEpisode } from '../sim/match';
import type { FighterData } from '../training/tasks';
import { decideOutcome, type RankedOutcome } from './tournament';

/** ランクマッチの1試合を最後まで計算する */
export function runRankedMatch(R: Rapier, a: FighterData, b: FighterData, seed: number): RankedOutcome {
  const m = new MatchEpisode(R, { mode: 'battle', seed, fighters: [a, b] });
  m.run();
  const out = decideOutcome(m, m.matchResult()!, seed);
  m.free();
  return out;
}

export interface RaceRecord {
  /** ゴールまでの最速タイム [s](一度もゴールしなければ null) */
  best: number | null;
  /** ゴールしなかったときの、いちばん長く進んだ距離 [m] */
  distance: number;
  /** ジャンプの公式記録:いちばん高く跳んだ上がり幅 [m] */
  jump: number;
  /** 長距離(トラック3周)の公式記録 */
  track: TrackRecord;
}

/** かけっこ・ジャンプ・長距離の公式記録:決まったシードで1体ずつ走らせ(跳ばせ)、最速のタイム・最高の高さを記録にする */
export function raceRecord(R: Rapier, c: FighterData): RaceRecord {
  let best: number | null = null;
  let distance = 0;
  for (const seed of RANKED.raceSeeds) {
    const ep = new RaceEpisode(R, [c], seed);
    ep.run();
    const r = ep.result();
    ep.free();
    const t = r.finishAt[0];
    if (t !== null && (best === null || t < best)) best = t;
    distance = Math.max(distance, r.distance[0]);
  }
  return { best, distance, jump: jumpRecord(R, c), track: trackRecord(R, c) };
}
