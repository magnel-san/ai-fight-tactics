import { describe, expect, it } from 'vitest';
import { cos, exp, log, sin, tanh } from '../src/core/math/fmath';
import { Rng } from '../src/core/math/rng';

// 自前実装がネイティブ実装に十分近いことを確認する(一致までは求めない)
function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(b));
}

describe('fmath', () => {
  const rng = new Rng(2026);
  const samples = (lo: number, hi: number, n = 20000) => Array.from({ length: n }, () => rng.range(lo, hi));

  it('exp', () => {
    for (const x of samples(-700, 700)) expect(Math.abs(exp(x) / Math.exp(x) - 1)).toBeLessThan(1e-13);
    expect(exp(0)).toBe(1);
    expect(exp(1000)).toBe(Infinity);
    expect(exp(-1000)).toBe(0);
    expect(exp(-740)).toBeGreaterThan(0); // 非正規化数の範囲
  });

  it('log', () => {
    for (const x of samples(1e-300, 1e300)) expect(relErr(log(x), Math.log(x))).toBeLessThan(1e-13);
    for (const x of samples(1e-6, 10)) expect(relErr(log(x), Math.log(x))).toBeLessThan(1e-13);
    expect(log(1)).toBe(0);
    expect(log(0)).toBe(-Infinity);
    expect(log(-1)).toBeNaN();
    expect(relErr(log(5e-324), Math.log(5e-324))).toBeLessThan(1e-13);
  });

  it('tanh', () => {
    for (const x of samples(-25, 25)) expect(Math.abs(tanh(x) - Math.tanh(x))).toBeLessThan(1e-14);
    expect(tanh(0)).toBe(0);
    expect(tanh(100)).toBe(1);
    expect(tanh(-100)).toBe(-1);
  });

  it('sin / cos', () => {
    for (const x of samples(-1000, 1000)) {
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-13);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-13);
    }
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
  });

  it('既知の出力とビット単位で一致する(実装が変わったら検知する)', () => {
    const xs = [-3.7, -0.5, 0.001, 0.3, 1, 2.5, 10];
    expect(xs.map((x) => [exp(x), log(Math.abs(x)), tanh(x), sin(x), cos(x)])).toMatchSnapshot();
  });
});
