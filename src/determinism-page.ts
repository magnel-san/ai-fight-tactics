// 決定性チェック用のページ(Playwright のブラウザ間テストで使う)。結果を JSON で表示する。
import { initRapier } from './core/physics/rapier';
import { determinismReport } from './core/sim/determinism';

const el = document.getElementById('result')!;
initRapier()
  .then((R) => {
    el.textContent = JSON.stringify(determinismReport(R));
    el.dataset.done = '1';
  })
  .catch((e: unknown) => {
    el.textContent = `ERROR ${String(e)}`;
    el.dataset.done = '1';
  });
