// シード付き乱数(xoshiro128**)。core/ では Math.random の代わりに必ずこれを使う。
// 32bit整数演算(Math.imul、ビット演算)だけで実装しているので、どの環境でも同じ列になる。

import { log } from './fmath';

/** 32bitシードを4ワードの状態に広げるためのsplitmix32 */
function splitmix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) | 0;
  let z = state.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const st = { s: seed | 0 };
    this.a = splitmix32(st);
    this.b = splitmix32(st);
    this.c = splitmix32(st);
    this.d = splitmix32(st);
    // 全ワード0の状態は周期1になるので避ける
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 1;
  }

  /** 符号なし32bit整数 */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.b, 5), 7), 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    this.d = rotl(this.d, 11);
    return result;
  }

  /** [0, 1) の一様乱数 */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** [min, max) の一様乱数 */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** [0, n) の整数 */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** 配列から1要素を選ぶ */
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** 標準正規分布。Marsaglia の極座標法(sin/cos 不要。log は core/math の自前実装) */
  gaussian(): number {
    for (;;) {
      const u = 2 * this.next() - 1;
      const v = 2 * this.next() - 1;
      const s = u * u + v * v;
      if (s > 0 && s < 1) return u * Math.sqrt((-2 * log(s)) / s);
    }
  }

  /** 子の乱数列を作る(エピソードごとの独立したシードなどに使う) */
  fork(): Rng {
    return new Rng(this.nextU32() | 0);
  }
}
