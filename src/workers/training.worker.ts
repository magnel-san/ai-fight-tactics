// 学習用Worker。個体(遺伝子)を受け取って評価し、適応度だけを返す。描画はしない。
import { initRapier } from '../core/physics/rapier';
import { evaluateMove } from '../core/training/move';
import type { EvalRequest, WorkerResponse } from './protocol';

const rapier = initRapier();

self.onmessage = async (e: MessageEvent<EvalRequest>) => {
  const req = e.data;
  try {
    const R = await rapier;
    const results = req.genomes.map((g) => evaluateMove(R, req.blueprint, g, req.seeds));
    self.postMessage({ type: 'result', jobId: req.jobId, results } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({ type: 'error', jobId: req.jobId, message: String(err) } satisfies WorkerResponse);
  }
};
