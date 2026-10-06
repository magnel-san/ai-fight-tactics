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

/**
 * 入力の数や並びが変わったときに、重みを新しい形に移す(データ形式の移行用)。
 * inputMap[i] は古い入力 i が新しい形で何番目になるか。新しく増えた入力の重みは0にするので、
 * 増えた入力は出力に影響せず、古い脳とまったく同じ動きになる。隠れ層と出力の数は同じであること
 */
export function remapInputs(old: Float64Array, from: MlpShape, to: MlpShape, inputMap: readonly number[]): Float64Array {
  if (from.hidden !== to.hidden || from.outputs !== to.outputs) throw new Error('隠れ層と出力の数が違う脳は移行できません');
  if (old.length !== mlpParamCount(from)) throw new Error(`重みの数が違います:${old.length}`);
  const out = new Float64Array(mlpParamCount(to));
  for (let h = 0; h < from.hidden; h++) {
    for (let i = 0; i < from.inputs; i++) out[h * to.inputs + inputMap[i]] = old[h * from.inputs + i];
  }
  // 隠れ層のバイアス・出力層の重みとバイアスはそのまま
  out.set(old.subarray(from.hidden * from.inputs), to.hidden * to.inputs);
  return out;
}

/**
 * 出力を後ろに増やす(データ形式の移行用)。増えた出力の重みとバイアスは0にするので、
 * 増えた出力は常に tanh(0) = 0 になり、もとの出力は変わらない
 */
export function appendOutputs(old: Float64Array, from: MlpShape, to: MlpShape): Float64Array {
  if (from.inputs !== to.inputs || from.hidden !== to.hidden || to.outputs < from.outputs) throw new Error('出力を増やす移行しかできません');
  if (old.length !== mlpParamCount(from)) throw new Error(`重みの数が違います:${old.length}`);
  const out = new Float64Array(mlpParamCount(to));
  const hiddenPart = from.hidden * from.inputs + from.hidden;
  out.set(old.subarray(0, hiddenPart), 0);
  out.set(old.subarray(hiddenPart, hiddenPart + from.outputs * from.hidden), hiddenPart);
  out.set(old.subarray(hiddenPart + from.outputs * from.hidden), hiddenPart + to.outputs * to.hidden);
  return out;
}
