// キャラ1体分のデータ(仕様書セクション12):設計図 + 2つの脳 + 育成状況。
import type { Blueprint } from './creature/blueprint';
import type { FighterData, TaskName } from './training/tasks';

export interface Progress {
  /** 合格したメニュー */
  passed: TaskName[];
  /** メニューごとの学習世代数 */
  generations: Partial<Record<TaskName, number>>;
  /** 生き残りの現在のレベル */
  surviveLevel?: number;
  /** 達成したマイルストーン */
  milestones?: string[];
}

export interface Character {
  name: string;
  blueprint: Blueprint;
  motor: Float64Array | null;
  decision: Float64Array | null;
  progress: Progress;
  /** 体を組み直した後で、判断脳の再トレーニングを勧める */
  decisionStale?: boolean;
  /** 受け取ったキャラ(編集・トレーニング不可) */
  readOnly?: boolean;
}

/** 運動脳を鍛えるメニュー(体を組み直すと合格が取り消される) */
export const MOTOR_TASKS: readonly TaskName[] = ['move', 'chase', 'jump', 'holes'];

/**
 * 種目・トーナメント・ランダムマッチに出るために合格が必要なトレーニング(「2. 対象を追う」)。
 * 指令の方向へまっすぐ進めないと、競技にならないため
 */
export const ENTRY_REQUIRED_TASK: TaskName = 'chase';

/** 種目・トーナメント・ランダムマッチに出られるか */
export function canEnter(c: Character): boolean {
  return !!c.motor && c.progress.passed.includes(ENTRY_REQUIRED_TASK);
}

/**
 * バトルに出すときのデータ。判断脳があればそれで戦い、なければ相手に向かって突進する(突進BOTと同じ作戦)。
 * 運動脳がなければ出られない(null)
 */
export function battleFighter(c: Pick<Character, 'blueprint' | 'motor' | 'decision'>): FighterData | null {
  if (!c.motor) return null;
  return c.decision
    ? { blueprint: c.blueprint, motor: c.motor, decision: c.decision, controller: 'brain' }
    : { blueprint: c.blueprint, motor: c.motor, decision: null, controller: 'rush' };
}

export function newCharacter(name: string, blueprint: Blueprint): Character {
  return { name, blueprint, motor: null, decision: null, progress: { passed: [], generations: {} } };
}

/**
 * 体を組み直したときの変更(仕様書セクション4):運動脳はリセットし、判断脳は体に依存しないので保持する。
 * 運動脳のメニューの合格は取り消し、判断脳を持っていれば再トレーニングを勧める
 */
export function rebuildBody(c: Character, blueprint: Blueprint): Character {
  const generations = { ...c.progress.generations };
  for (const t of MOTOR_TASKS) delete generations[t];
  return {
    ...c,
    blueprint,
    motor: null,
    progress: { ...c.progress, passed: c.progress.passed.filter((t) => !MOTOR_TASKS.includes(t)), generations },
    decisionStale: c.decision !== null,
  };
}
