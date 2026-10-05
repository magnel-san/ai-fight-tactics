// Node 用の学習Worker(worker_threads)。ブラウザの training.worker.ts と同じ処理をする。
import { parentPort } from 'node:worker_threads';
import { initRapier } from '../../src/core/physics/rapier';
import { TASKS, evaluate } from '../../src/core/training/tasks';
import type { WorkerRequest, WorkerResponse } from '../../src/workers/protocol';

const rapier = initRapier();

parentPort!.on('message', async (req: WorkerRequest) => {
  try {
    const R = await rapier;
    const task = TASKS[req.task];
    let res: WorkerResponse;
    if (req.type === 'eval') {
      res = { type: 'eval', jobId: req.jobId, results: req.genomes.map((g) => evaluate(R, task, req.setup, g, req.seeds)) };
    } else {
      const outcomes = req.seeds.map((seed, i) => {
        const ep = task.createEpisode(R, req.setup, req.genome, seed, { index: req.offset + i, count: req.count }, 'confirm');
        const o = ep.run();
        ep.free();
        return o;
      });
      res = { type: 'confirm', jobId: req.jobId, outcomes };
    }
    parentPort!.postMessage(res);
  } catch (err) {
    parentPort!.postMessage({ type: 'error', jobId: req.jobId, message: String(err) } satisfies WorkerResponse);
  }
});
