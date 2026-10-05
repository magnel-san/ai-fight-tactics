// Rapier(WASM)の初期化。メインスレッドでもWorkerでも、最初に一度だけ await する。
import RAPIER from '@dimforge/rapier3d-compat';

let ready: Promise<typeof RAPIER> | null = null;

export function initRapier(): Promise<typeof RAPIER> {
  if (!ready) ready = RAPIER.init().then(() => RAPIER);
  return ready;
}

export type Rapier = typeof RAPIER;
