// 学習用Workerのプール。集団を Worker 数で分けて並列に評価し、元の順番に並べ直して返す。
// どの Worker がどの個体を評価しても結果は同じなので、Worker 数によらず学習結果は一致する。
import { TRAINING } from '../core/config';
import type { Blueprint } from '../core/creature/blueprint';
import type { EvalRequest, EvalResult, TaskName, WorkerResponse } from '../workers/protocol';

export function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.min(TRAINING.workersMax, Math.max(TRAINING.workersMin, cores - 2));
}

export class WorkerPool {
  private workers: Worker[];
  private nextJobId = 0;
  private pending = new Map<number, { resolve(r: EvalResult[]): void; reject(e: Error): void }>();

  constructor(readonly size = defaultWorkerCount()) {
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('../workers/training.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        const p = this.pending.get(msg.jobId);
        if (!p) return;
        this.pending.delete(msg.jobId);
        if (msg.type === 'result') p.resolve(msg.results);
        else p.reject(new Error(msg.message));
      };
      w.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message));
        this.pending.clear();
      };
      return w;
    });
  }

  async evaluate(task: TaskName, blueprint: Blueprint, genomes: readonly Float64Array[], seeds: number[]): Promise<EvalResult[]> {
    const chunk = Math.ceil(genomes.length / this.size);
    const jobs = this.workers.map((w, i) => {
      const part = genomes.slice(i * chunk, (i + 1) * chunk).map((g) => Float64Array.from(g));
      if (part.length === 0) return Promise.resolve([]);
      const jobId = this.nextJobId++;
      const req: EvalRequest = { type: 'eval', jobId, task, blueprint, genomes: part, seeds };
      return new Promise<EvalResult[]>((resolve, reject) => {
        this.pending.set(jobId, { resolve, reject });
        w.postMessage(req, part.map((g) => g.buffer));
      });
    });
    return (await Promise.all(jobs)).flat();
  }

  terminate(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Workerを停止しました'));
    this.pending.clear();
  }
}
