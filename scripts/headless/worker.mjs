// worker_threads の中では tsx のローダーが自動で効かないので、登録してから TypeScript の本体を読み込む
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
