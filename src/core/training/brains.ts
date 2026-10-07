// メニューごとに「どの脳を鍛えるか」の取り出しと保存(運動脳・判断脳・サッカー脳(役割ごと))
import { createDecisionGenome } from '../brain/decision';
import { createMotorGenome } from '../brain/motor';
import { createSoccerGenome } from '../brain/soccer';
import type { Character } from '../character';
import { actuatorCount } from '../creature/blueprint';
import type { Rng } from '../math/rng';
import { TASKS, type TaskName } from './tasks';

/** 鍛える脳の名前(画面に出す) */
export const BRAIN_LABELS = { motor: '運動脳', decision: '判断脳', soccer: 'サッカー脳' } as const;

/** そのメニューで鍛える脳の、いまの遺伝子(まだなければ null) */
export function trainedGenome(c: Character, task: TaskName): Float64Array | null {
  const d = TASKS[task];
  if (d.brain === 'motor') return c.motor;
  if (d.brain === 'decision') return c.decision;
  return c.soccer?.[d.role!] ?? null;
}

/** そのメニューで鍛える脳の、新しい遺伝子 */
export function freshGenome(c: Character, task: TaskName, rng: Rng): Float64Array {
  const d = TASKS[task];
  if (d.brain === 'motor') return createMotorGenome(actuatorCount(c.blueprint), rng);
  if (d.brain === 'decision') return createDecisionGenome(rng);
  return createSoccerGenome(rng);
}

/** 鍛えた遺伝子を、そのメニューの脳としてキャラに入れる */
export function withTrained(c: Character, task: TaskName, genome: Float64Array): Character {
  const d = TASKS[task];
  if (d.brain === 'motor') return { ...c, motor: genome };
  if (d.brain === 'decision') return { ...c, decision: genome, decisionStale: false };
  return { ...c, soccer: { ...c.soccer, [d.role!]: genome } };
}
