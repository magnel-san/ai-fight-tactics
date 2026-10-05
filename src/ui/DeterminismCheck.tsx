// 物理の決定性チェック。Node(npm test)で記録したハッシュと、このブラウザで計算したハッシュを比べる。
import { useEffect, useState } from 'react';
import { initRapier } from '../core/physics/rapier';
import { runSmokeSim } from '../core/sim/smoke';

/** tests/__snapshots__/determinism.test.ts.snap に記録された seed=1 のハッシュ */
const EXPECTED_SEED1 = 'b95852cb';

export function DeterminismCheck() {
  const [hash, setHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initRapier()
      .then((R) => setHash(runSmokeSim(R, 1)))
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) return <span className="determinism ng">決定性チェック:エラー {error}</span>;
  if (!hash) return <span className="determinism">決定性チェック:計算中…</span>;
  const ok = hash === EXPECTED_SEED1;
  return (
    <span className={`determinism ${ok ? 'ok' : 'ng'}`} title={`このブラウザ ${hash} / Node ${EXPECTED_SEED1}`}>
      決定性チェック:{ok ? 'Nodeと一致' : `不一致(${hash})`}
    </span>
  );
}
