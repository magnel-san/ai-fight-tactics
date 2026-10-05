import { beforeAll, describe, expect, it } from 'vitest';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { runSmokeSim } from '../src/core/sim/smoke';

describe('物理の決定性', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  it('同じシードで2回実行すると状態ハッシュが一致する', () => {
    expect(runSmokeSim(R, 1)).toBe(runSmokeSim(R, 1));
    expect(runSmokeSim(R, 999)).toBe(runSmokeSim(R, 999));
  });

  it('シードが違えば結果も変わる', () => {
    expect(runSmokeSim(R, 1)).not.toBe(runSmokeSim(R, 2));
  });

  it('既知のハッシュと一致する(ブラウザの確認画面と同じ値になるはず)', () => {
    expect(runSmokeSim(R, 1)).toMatchSnapshot();
  });
});
