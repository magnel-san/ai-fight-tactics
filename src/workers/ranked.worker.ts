// ランクマッチ用のWorker。トーナメントの試合とかけっこの記録、成績表を、画面を止めずに計算する
import { initRapier } from '../core/physics/rapier';
import { raceRecord, runRankedMatch, type RaceRecord } from '../core/ranked/run';
import type { RankedOutcome } from '../core/ranked/tournament';
import { measureReport, type ReportCard } from '../core/training/report';
import type { FighterData } from '../core/training/tasks';

export type RankedRequest =
  | { id: number; type: 'match'; a: FighterData; b: FighterData; seed: number }
  | { id: number; type: 'race'; fighter: FighterData }
  | { id: number; type: 'report'; fighter: FighterData; rush: FighterData; standard: FighterData; at: number };

export type RankedResponse =
  | { id: number; type: 'match'; outcome: RankedOutcome }
  | { id: number; type: 'race'; record: RaceRecord }
  | { id: number; type: 'report'; report: ReportCard }
  | { id: number; type: 'error'; message: string };

const rapier = initRapier();

self.onmessage = async (e: MessageEvent<RankedRequest>) => {
  const req = e.data;
  try {
    const R = await rapier;
    const res: RankedResponse =
      req.type === 'match'
        ? { id: req.id, type: 'match', outcome: runRankedMatch(R, req.a, req.b, req.seed) }
        : req.type === 'race'
          ? { id: req.id, type: 'race', record: raceRecord(R, req.fighter) }
          : { id: req.id, type: 'report', report: measureReport(R, req.fighter, req.rush, req.standard, req.at) };
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ id: req.id, type: 'error', message: String(err) } satisfies RankedResponse);
  }
};
