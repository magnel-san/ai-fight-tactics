// キャラ1体分のデータ(仕様書セクション12):設計図 + 2つの脳 + 育成状況。
import type { Blueprint } from './creature/blueprint';
import type { TaskName } from './training/tasks';

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
