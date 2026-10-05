import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/math/rng';

describe('Rng', () => {
  it('同じシードなら同じ列になる', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('既知の出力と一致する(実装が変わったら検知する)', () => {
    const r = new Rng(12345);
    const got = Array.from({ length: 4 }, () => r.nextU32());
    expect(got).toMatchSnapshot();
  });

  it('next() は [0, 1) に収まり、平均がおよそ0.5', () => {
    const r = new Rng(1);
    let sum = 0;
    for (let i = 0; i < 100000; i++) {
      const x = r.next();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(sum / 100000).toBeCloseTo(0.5, 2);
  });

  it('gaussian() は平均0・分散1に近い', () => {
    const r = new Rng(7);
    const n = 100000;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const x = r.gaussian();
      s += x;
      s2 += x * x;
    }
    expect(s / n).toBeCloseTo(0, 1);
    expect(s2 / n).toBeCloseTo(1, 1);
  });
});
