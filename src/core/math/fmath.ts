// 決定論的な数学関数。
// Math.sin / exp / tanh / log などは実装依存でブラウザ間の結果一致が保証されないため、
// IEEE 754で結果が一意に決まる演算(四則演算、Math.sqrt、Math.round など)だけで組み立てる。
// 精度は倍精度で1e-14程度。ゲーム用途には十分で、何より全環境で同じビット列を返すことを優先する。

/** 2^k の表(k = -1074 〜 1023)。2倍・半分の繰り返しで作るので誤差なしで全環境一致する */
const POW2_MIN = -1074;
const POW2 = (() => {
  const t = new Float64Array(1023 - POW2_MIN + 1);
  let v = 1;
  for (let k = 0; k <= 1023; k++, v *= 2) t[k - POW2_MIN] = v;
  v = 1;
  for (let k = 0; k >= POW2_MIN; k--, v *= 0.5) t[k - POW2_MIN] = v;
  return t;
})();

/** 2^k(k は整数) */
function pow2i(k: number): number {
  if (k > 1023) return Infinity;
  if (k < POW2_MIN) return 0;
  return POW2[k - POW2_MIN];
}

/** m * 2^k。2^k 単体が表の範囲外でも、2段階に分けて掛けることで途中のオーバー/アンダーフローを避ける */
function mulPow2(m: number, k: number): number {
  if (k > 1000) return m * pow2i(1000) * pow2i(k - 1000);
  if (k < -1000) return m * pow2i(-1000) * pow2i(k + 1000);
  return m * pow2i(k);
}

// ln2 を上位(下位ビットが0)と下位に分けた定数(fdlibm と同じ値)。k*LN2_HI が誤差なしで計算できる
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.44269504088896338700;

/** 1/n! の表 */
const INV_FACT = (() => {
  const t: number[] = [1];
  for (let n = 1; n <= 20; n++) t.push(t[n - 1] / n);
  return t;
})();

export function exp(x: number): number {
  if (x !== x) return NaN;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019412) return 0;
  // x = k*ln2 + r, |r| <= ln2/2
  const k = Math.round(x * INV_LN2);
  const r = x - k * LN2_HI - k * LN2_LO;
  // e^r をテイラー展開(13次まで)。Horner法で評価する
  let p = INV_FACT[13];
  for (let n = 12; n >= 0; n--) p = p * r + INV_FACT[n];
  return mulPow2(p, k);
}

const SQRT1_2 = 0.7071067811865476;
const LOG_COEF = (() => {
  // 2/(2n+1) の表(atanh の級数)
  const t: number[] = [];
  for (let n = 0; n <= 10; n++) t.push(2 / (2 * n + 1));
  return t;
})();

export function log(x: number): number {
  if (x !== x || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;
  // x = m * 2^e、m ∈ [√½, √2) に正規化する(二分探索で指数を求める)
  let e = 0;
  let m = x;
  if (m < SQRT1_2) {
    let lo = 1;
    let hi = -POW2_MIN;
    // m * 2^lo >= √½ となる最小の lo を探す
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mulPow2(m, mid) >= SQRT1_2) hi = mid;
      else lo = mid + 1;
    }
    m = mulPow2(m, lo);
    e = -lo;
  } else if (m >= 2 * SQRT1_2) {
    let lo = 1;
    let hi = 1024;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mulPow2(m, -mid) < 2 * SQRT1_2) hi = mid;
      else lo = mid + 1;
    }
    m = mulPow2(m, -lo);
    e = lo;
  }
  // log(m) = 2 atanh(s), s = (m-1)/(m+1), |s| <= 0.1716
  const f = m - 1;
  const s = f / (2 + f);
  const s2 = s * s;
  let p = LOG_COEF[10];
  for (let n = 9; n >= 0; n--) p = p * s2 + LOG_COEF[n];
  return e * LN2_HI + (s * p + e * LN2_LO);
}

export function tanh(x: number): number {
  if (x !== x) return NaN;
  const ax = x < 0 ? -x : x;
  if (ax > 20) return x < 0 ? -1 : 1;
  const t = 1 - 2 / (exp(2 * ax) + 1);
  return x < 0 ? -t : t;
}

// π/2 を上位と下位に分けた定数(fdlibm の pio2_1, pio2_1t)
const PIO2_HI = 1.57079632673412561417;
const PIO2_LO = 6.07710050650619224932e-11;
const TWO_OVER_PI = 0.63661977236758134308;

/** |r| <= π/4 での sin(テイラー展開 17次まで) */
function sinKernel(r: number): number {
  const r2 = r * r;
  let p = INV_FACT[17];
  for (let n = 15; n >= 1; n -= 2) p = -p * r2 + INV_FACT[n];
  return p * r;
}

/** |r| <= π/4 での cos(テイラー展開 18次まで) */
function cosKernel(r: number): number {
  const r2 = r * r;
  let p = INV_FACT[18];
  for (let n = 16; n >= 0; n -= 2) p = -p * r2 + INV_FACT[n];
  return p;
}

/** x = k*(π/2) + r に分解し、k の下位2bit(象限)と r を返す */
function reduce(x: number): [number, number] {
  const k = Math.round(x * TWO_OVER_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO;
  return [((k % 4) + 4) % 4, r];
}

export function sin(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const [q, r] = reduce(x);
  switch (q) {
    case 0:
      return sinKernel(r);
    case 1:
      return cosKernel(r);
    case 2:
      return -sinKernel(r);
    default:
      return -cosKernel(r);
  }
}

export function cos(x: number): number {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  const [q, r] = reduce(x);
  switch (q) {
    case 0:
      return cosKernel(r);
    case 1:
      return -sinKernel(r);
    case 2:
      return -cosKernel(r);
    default:
      return sinKernel(r);
  }
}

const PI_HALF = 1.5707963267948966;
const PI_SIXTH = 0.52359877559829887;
const SQRT3 = 1.7320508075688772;
const TAN_PI_12 = 0.26794919243112270;
const ATAN_COEF = (() => {
  // (-1)^n / (2n+1) の表
  const t: number[] = [];
  for (let n = 0; n <= 13; n++) t.push((n % 2 === 0 ? 1 : -1) / (2 * n + 1));
  return t;
})();

export function atan(x: number): number {
  if (x !== x) return NaN;
  const neg = x < 0;
  let t = neg ? -x : x;
  let base = 0;
  let invert = false;
  if (t > 1) {
    // atan(t) = π/2 - atan(1/t)
    t = 1 / t;
    invert = true;
  }
  if (t > TAN_PI_12) {
    // atan(t) = π/6 + atan((√3 t - 1) / (t + √3))
    t = (SQRT3 * t - 1) / (t + SQRT3);
    base = PI_SIXTH;
  }
  // |t| <= tan(π/12) ≈ 0.268 でテイラー展開
  const t2 = t * t;
  let p = ATAN_COEF[13];
  for (let n = 12; n >= 0; n--) p = p * t2 + ATAN_COEF[n];
  let r = base + t * p;
  if (invert) r = PI_HALF - r;
  return neg ? -r : r;
}

export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return NaN;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + 2 * PI_HALF : atan(y / x) - 2 * PI_HALF;
  if (y > 0) return PI_HALF;
  if (y < 0) return -PI_HALF;
  return 0;
}
