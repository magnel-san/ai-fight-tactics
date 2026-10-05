// シミュレーション状態のハッシュ。浮動小数点数をビット列のまま混ぜるので、
// 1ビットでも違えば別の値になる(決定性テスト用)。

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class StateHasher {
  private h = 0x811c9dc5;

  private mix(word: number): void {
    // FNV-1a を32bitワード単位で適用
    for (let i = 0; i < 4; i++) {
      this.h ^= (word >>> (i * 8)) & 0xff;
      this.h = Math.imul(this.h, 0x01000193);
    }
  }

  add(x: number): this {
    f64[0] = x;
    this.mix(u32[0]);
    this.mix(u32[1]);
    return this;
  }

  addAll(xs: ArrayLike<number>): this {
    for (let i = 0; i < xs.length; i++) this.add(xs[i]);
    return this;
  }

  digest(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
