// メインスレッドと学習用Workerの間のメッセージ形式
import type { Blueprint } from '../core/creature/blueprint';

export type TaskName = 'move';

export interface EvalRequest {
  type: 'eval';
  jobId: number;
  task: TaskName;
  blueprint: Blueprint;
  genomes: Float64Array[];
  seeds: number[];
}

export interface EvalResult {
  fitness: number;
  /** 評価エピソードのうち目標に到達した回数 */
  reachedCount: number;
}

export type WorkerResponse =
  | { type: 'result'; jobId: number; results: EvalResult[] }
  | { type: 'error'; jobId: number; message: string };
