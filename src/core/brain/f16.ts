// float16(半精度)への丸め(仕様書セクション8「重みの精度」)。
// 共有コードを小さくするため、重みは常に float16 で表せる値に丸めて保持する。
// ビット演算だけで実装しているので、どの環境でも同じ結果になる。

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** float16 で表せる最大の有限値 */
export const F16_MAX = 65504;

/** 2^k(k = -24 〜 15)。2倍・半分の繰り返しで作るので誤差はない */
const POW2 = (() => {
  const t = new Map<number, number>();
  let v = 1;
  for (let k = 0; k <= 15; k++, v *= 2) t.set(k, v);
  v = 1;
  for (let k = 0; k >= -24; k--, v *= 0.5) t.set(k, v);
  return t;
})();

/** 数値を float16 のビット列にする(最近接偶数丸め。範囲外は ±最大値に飽和させる) */
export function toF16Bits(x: number): number {
  if (x !== x) return 0x7e00;
  if (x > F16_MAX) x = F16_MAX;
  if (x < -F16_MAX) x = -F16_MAX;
  f32[0] = x;
  const b = u32[0];
  const sign = (b >>> 16) & 0x8000;
  const exp = (b >>> 23) & 0xff;
  let mant = b & 0x7fffff;
  const e = exp - 127 + 15;
  if (e <= 0) {
    // float16 の非正規化数(またはゼロ)
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (half & 1) === 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  // 繰り上がりで指数部に溢れても、そのまま正しい次の値になる
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1) === 1)) half++;
  return sign | half;
}

/** float16 のビット列を数値に戻す */
export function fromF16Bits(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return sign * m * POW2.get(-24)!;
  if (e === 0x1f) return m === 0 ? sign * Infinity : NaN;
  return sign * (1 + m / 1024) * POW2.get(e - 15)!;
}

/** float16 の精度に丸める */
export function roundF16(x: number): number {
  return fromF16Bits(toF16Bits(x));
}

/** 配列の全要素をその場で float16 の精度に丸める */
export function roundF16Array(a: Float64Array): Float64Array {
  for (let i = 0; i < a.length; i++) a[i] = roundF16(a[i]);
  return a;
}
