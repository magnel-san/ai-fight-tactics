// 成績表を Worker で測る(画面を止めないように)
import type { ReportCard } from '../core/training/report';
import type { FighterData } from '../core/training/tasks';
import type { RankedRequest, RankedResponse } from '../workers/ranked.worker';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (r: RankedResponse) => void>();

export function measureReportInWorker(fighter: FighterData, rush: FighterData, standard: FighterData): Promise<ReportCard> {
  worker ??= (() => {
    const w = new Worker(new URL('../workers/ranked.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<RankedResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    return w;
  })();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (r) => {
      if (r.type === 'report') resolve(r.report);
      else reject(new Error(r.type === 'error' ? r.message : '成績表を測れませんでした'));
    });
    worker!.postMessage({ id, type: 'report', fighter, rush, standard, at: Date.now() } satisfies RankedRequest);
  });
}
