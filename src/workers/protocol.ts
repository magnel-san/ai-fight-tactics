// メインスレッドと学習用Workerの間のメッセージ形式
import type { EpisodeOutcome } from '../core/training/episode';
import type { EvalResult, TaskName, TaskSetup } from '../core/training/tasks';

export type WorkerRequest =
  | {
      /** 集団の評価:各遺伝子を同じシードのエピソードで評価し、適応度を返す */
      type: 'eval';
      jobId: number;
      task: TaskName;
      setup: TaskSetup;
      genomes: Float64Array[];
      seeds: number[];
    }
  | {
      /** 合格の確認:1つの遺伝子を複数のエピソードで評価し、各エピソードの結果を返す */
      type: 'confirm';
      jobId: number;
      task: TaskName;
      setup: TaskSetup;
      genome: Float64Array;
      seeds: number[];
      /** 方向の割り当てに使う、全体のエピソード数と、このジョブの最初の番号 */
      count: number;
      offset: number;
    };

export type WorkerResponse =
  | { type: 'eval'; jobId: number; results: EvalResult[] }
  | { type: 'confirm'; jobId: number; outcomes: EpisodeOutcome[] }
  | { type: 'error'; jobId: number; message: string };
