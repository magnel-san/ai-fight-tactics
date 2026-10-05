// 仮のトップ画面。今は決定性の確認だけを行う。
// Node(npm test)で記録したハッシュと、このブラウザで計算したハッシュが一致するかを表示する。
import { useEffect, useState } from 'react';
import { initRapier } from '../core/physics/rapier';
import { runSmokeSim } from '../core/sim/smoke';

/** tests/__snapshots__/determinism.test.ts.snap に記録された seed=1 のハッシュ */
const EXPECTED_SEED1 = 'b95852cb';

export function App() {
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initRapier()
      .then((R) => setHash(runSmokeSim(R, 1)))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  const ok = hash === EXPECTED_SEED1;
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.7 }}>
      <h1>AI Fight Tactics</h1>
      <h2>物理の決定性チェック</h2>
      {error && <p style={{ color: 'crimson' }}>エラー: {error}</p>}
      {!hash && !error && <p>計算中…</p>}
      {hash && (
        <p>
          このブラウザ: <code>{hash}</code> / Node: <code>{EXPECTED_SEED1}</code>{' '}
          <strong style={{ color: ok ? 'green' : 'crimson' }}>{ok ? '一致' : '不一致'}</strong>
        </p>
      )}
      <p style={{ color: '#666' }}>{navigator.userAgent}</p>
    </main>
  );
}
