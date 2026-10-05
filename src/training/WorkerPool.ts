// 学習用Workerのプール。仕事を小さく分けて空いた Worker から順に渡し、元の番号の位置に結果を入れて返す。
// どの Worker がどの個体を評価しても結果は同じなので、Worker 数によらず学習結果は一致する。
import { TRAINING } from '../core/config';
import type { EpisodeOutcome } from '../core/training/episode';
import type { EvalResult, TaskName, TaskSetup } from '../core/training/tasks';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol';

export function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.min(TRAINING.workersMax, Math.max(TRAINING.workersMin, cores - 2));
}

/** 評価を並列に行うプール(ブラウザでは Web Worker、Node のスクリプトでは worker_threads) */
export interface EvalPool {
  readonly size: number;
  evaluate(task: TaskName, setup: TaskSetup, genomes: readonly Float64Array[], seeds: number[]): Promise<EvalResult[]>;
  confirm(task: TaskName, setup: TaskSetup, genome: Float64Array, seeds: number[]): Promise<EpisodeOutcome[]>;
  terminate(): void;
}

/** 1回の仕事で Worker に渡す個体数 */
export const JOB_GENOMES = 2;

/** 配列を n 個のなるべく同じ大きさの連続した塊に分ける */
export function chunks<T>(items: readonly T[], n: number): T[][] {
  const size = Math.ceil(items.length / n);
  return Array.from({ length: n }, (_, i) => items.slice(i * size, (i + 1) * size));
}

/**
 * 仕事を空いたレーン(Worker)から順に処理する。性能の違うコアが混ざっていても遅いコアを待たずに済む。
 * 結果は元の番号の位置に入れる
 */
export async function schedule<J, R>(lanes: number, jobs: J[], run: (lane: number, job: J) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(lanes, jobs.length) }, async (_, lane) => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await run(lane, jobs[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** WorkerPool と Node 用のプールで共通の、仕事の分け方 */
export abstract class PoolBase implements EvalPool {
  protected nextJobId = 0;
  abstract readonly size: number;
  protected abstract send(lane: number, req: WorkerRequest): Promise<WorkerResponse>;
  abstract terminate(): void;

  async evaluate(task: TaskName, setup: TaskSetup, genomes: readonly Float64Array[], seeds: number[]): Promise<EvalResult[]> {
    const batches = chunks(genomes, Math.ceil(genomes.length / JOB_GENOMES));
    const parts = await schedule(this.size, batches, (lane, part) =>
      this.send(lane, { type: 'eval', jobId: this.nextJobId++, task, setup, genomes: part.map((g) => Float64Array.from(g)), seeds }).then((r) =>
        r.type === 'eval' ? r.results : [],
      ),
    );
    return parts.flat();
  }

  /** 1個体を複数のエピソードで評価する(合格の確認)。エピソードを1つずつ Worker に渡す */
  async confirm(task: TaskName, setup: TaskSetup, genome: Float64Array, seeds: number[]): Promise<EpisodeOutcome[]> {
    const jobs = seeds.map((seed, i) => ({ seed, i }));
    const parts = await schedule(this.size, jobs, (lane, { seed, i }) =>
      this.send(lane, {
        type: 'confirm',
        jobId: this.nextJobId++,
        task,
        setup,
        genome: Float64Array.from(genome),
        seeds: [seed],
        count: seeds.length,
        offset: i,
      }).then((r) => (r.type === 'confirm' ? r.outcomes : [])),
    );
    return parts.flat();
  }
}

type Pending = { resolve(r: WorkerResponse): void; reject(e: Error): void };

export class WorkerPool extends PoolBase {
  private workers: Worker[];
  private pending = new Map<number, Pending>();

  constructor(readonly size = defaultWorkerCount()) {
    super();
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('../workers/training.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.jobId);
        if (!p) return;
        this.pending.delete(e.data.jobId);
        if (e.data.type === 'error') p.reject(new Error(e.data.message));
        else p.resolve(e.data);
      };
      w.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || 'Workerでエラーが起きました'));
        this.pending.clear();
      };
      return w;
    });
  }

  protected send(lane: number, req: WorkerRequest): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.jobId, { resolve, reject });
      this.workers[lane].postMessage(req);
    });
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Workerを停止しました'));
    this.pending.clear();
  }
}
