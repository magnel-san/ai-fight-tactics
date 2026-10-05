// 隠れ層1層の全結合ネットワーク(仕様書セクション7)。活性化関数は決定論的な tanh。
// パラメータは1本の配列に [W1(隠れ×入力), b1(隠れ), W2(出力×隠れ), b2(出力)] の順で並べる。
import { tanh } from '../math/fmath';
import type { Rng } from '../math/rng';
import { roundF16 } from './f16';

export interface MlpShape {
  inputs: number;
  hidden: number;
  outputs: number;
}

export function mlpParamCount(s: MlpShape): number {
  return s.hidden * s.inputs + s.hidden + s.outputs * s.hidden + s.outputs;
}

/**
 * 順伝播。params の offset 番目から読む。
 * hidden と out は呼び出し側で確保した作業領域(毎回の確保を避けるため)。
 */
export function mlpForward(
  s: MlpShape,
  params: Float64Array,
  offset: number,
  input: ArrayLike<number>,
  hidden: Float64Array,
  out: Float64Array,
): void {
  let p = offset;
  for (let h = 0; h < s.hidden; h++) {
    let sum = 0;
    for (let i = 0; i < s.inputs; i++) sum += params[p++] * input[i];
    hidden[h] = sum;
  }
  for (let h = 0; h < s.hidden; h++) hidden[h] = tanh(hidden[h] + params[p++]);
  for (let o = 0; o < s.outputs; o++) {
    let sum = 0;
    for (let h = 0; h < s.hidden; h++) sum += params[p++] * hidden[h];
    out[o] = sum;
  }
  for (let o = 0; o < s.outputs; o++) out[o] = tanh(out[o] + params[p++]);
}

/**
 * 初期の重み。各層の重みを標準偏差 1/√(入力数) の正規分布で、バイアスを0で初期化する。
 * 結果は float16 の精度に丸めて、params の offset 番目から書き込む。
 */
export function mlpInit(s: MlpShape, rng: Rng, params: Float64Array, offset: number): void {
  let p = offset;
  const s1 = 1 / Math.sqrt(s.inputs);
  for (let i = 0; i < s.hidden * s.inputs; i++) params[p++] = roundF16(rng.gaussian() * s1);
  for (let i = 0; i < s.hidden; i++) params[p++] = 0;
  const s2 = 1 / Math.sqrt(s.hidden);
  for (let i = 0; i < s.outputs * s.hidden; i++) params[p++] = roundF16(rng.gaussian() * s2);
  for (let i = 0; i < s.outputs; i++) params[p++] = 0;
}
