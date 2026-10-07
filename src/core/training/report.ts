// 成績表:キャラの実力を、決まったシードの試合で測る(合格だけでは分からない「性格」を見えるようにする)。
//   ・突進BOT・標準BOTとのバトルの勝敗(押し出して勝った数・自滅して負けた数)
//   ・崩落ステージ(レベル3)で1体だけで生き残れるか
// シードは固定なので、同じキャラなら何度測っても同じ結果になる(キャラどうしを公平に比べられる)。
import { REPORT, SURVIVE_TASK } from '../config';
import type { Rapier } from '../physics/rapier';
import { MatchEpisode } from '../sim/match';
import { levelPace, type FighterData } from './tasks';

export interface VersusRecord {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** 押し出して勝った数 */
  pushWins: number;
  /** 相手に触れずに自分で落ちて負けた数 */
  selfFalls: number;
}

export interface ReportCard {
  /** 測った時刻 [ms] */
  at: number;
  vsRush: VersusRecord;
  vsStandard: VersusRecord;
  /** 崩落ステージ(レベル3)の生き残り:60秒生き残った数と、平均の生存時間 [s] */
  survive: { games: number; survived: number; meanTime: number };
}

function versus(R: Rapier, me: FighterData, opponent: FighterData, seedBase: number): VersusRecord {
  const rec: VersusRecord = { games: 0, wins: 0, losses: 0, draws: 0, pushWins: 0, selfFalls: 0 };
  for (let i = 0; i < REPORT.matches; i++) {
    // 立ち位置の偏りが出ないよう、半分は相手と入れ替える
    const swap = i % 2 === 1;
    const m = new MatchEpisode(R, { mode: 'battle', seed: seedBase + i, fighters: swap ? [opponent, me] : [me, opponent] });
    m.run();
    const r = m.matchResult()!;
    m.free();
    const mine = swap ? 1 : 0;
    rec.games++;
    if (r.winner === null) rec.draws++;
    else if (r.winner === mine) {
      rec.wins++;
      if (r.causes[1 - mine] === 'pushed') rec.pushWins++;
    } else {
      rec.losses++;
      if (r.causes[mine] === 'fell') rec.selfFalls++;
    }
  }
  return rec;
}

/** 成績表を測る(少し時間がかかるので、Worker で呼ぶ) */
export function measureReport(R: Rapier, me: FighterData, rush: FighterData, standard: FighterData, at: number): ReportCard {
  const vsRush = versus(R, me, rush, REPORT.seed);
  const vsStandard = versus(R, me, standard, REPORT.seed + 1000);
  let survived = 0;
  let total = 0;
  for (let i = 0; i < REPORT.surviveRuns; i++) {
    const m = new MatchEpisode(R, { mode: 'survive', seed: REPORT.seed + 2000 + i, pace: levelPace(SURVIVE_TASK.passLevel), fighters: [me] });
    m.run();
    const r = m.matchResult()!;
    m.free();
    const t = r.outAt[0] ?? SURVIVE_TASK.timeLimit;
    total += t;
    if (r.outAt[0] === null) survived++;
  }
  return { at, vsRush, vsStandard, survive: { games: REPORT.surviveRuns, survived, meanTime: total / REPORT.surviveRuns } };
}
