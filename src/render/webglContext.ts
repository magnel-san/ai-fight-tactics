// WebGL の描画領域(コンテキスト)の後始末と復旧。
// ブラウザが同時に持てる描画領域には上限(Chrome では16個ほど)があり、超えると古いものから捨てられて画面が真っ暗になる。
//   ・閉じるときは renderer.dispose() だけでは描画領域が残るので、canvas が画面から外れていれば forceContextLoss() ですぐに手放す
//   ・それでも描画領域が失われたときは、ブラウザに復旧してもらい(preventDefault)、復旧したら描き直す
import type * as THREE from 'three';

export interface ContextGuard {
  /** 描画領域を手放す(閉じるときに、renderer.dispose() のあとで呼ぶ) */
  release(): void;
}

export function guardContext(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement, onRestored: () => void): ContextGuard {
  const lost = (e: Event) => e.preventDefault();
  const restored = () => onRestored();
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return {
    release() {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      // 画面から取り外された canvas の描画領域だけを手放す。
      // 同じ canvas にもう一度表示を作ることがある(開発時の React の StrictMode など)ので、付いたままの canvas では手放さない
      // (一度手放した描画領域は、同じ canvas では二度と使えない)
      if (!canvas.isConnected) renderer.forceContextLoss();
    },
  };
}
