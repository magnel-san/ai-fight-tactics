// Node 用の評価プール(worker_threads)。仕事の分け方はブラウザの WorkerPool と共通(PoolBase)。
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { PoolBase } from '../../src/training/WorkerPool';
import type { WorkerRequest, WorkerResponse } from '../../src/workers/protocol';

export class NodePool extends PoolBase {
  private workers: Worker[];
  private pending = new Map<number, { resolve(r: WorkerResponse): void; reject(e: Error): void }>();

  constructor(readonly size = Math.max(1, availableParallelism() - 2)) {
    super();
    this.workers = Array.from({ length: size }, () => {
      const w = new Worker(new URL('./worker.mjs', import.meta.url));
      w.on('message', (msg: WorkerResponse) => {
        const p = this.pending.get(msg.jobId);
        if (!p) return;
        this.pending.delete(msg.jobId);
        if (msg.type === 'error') p.reject(new Error(msg.message));
        else p.resolve(msg);
      });
      w.on('error', (e: Error) => {
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      });
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
    for (const w of this.workers) void w.terminate();
  }
}
