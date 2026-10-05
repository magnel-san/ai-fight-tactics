// 六角グリッドの計算(仕様書セクション6)。アキシャル座標 (q, r)、とがった頂点が ±z を向く配置。

export interface Hex {
  q: number;
  r: number;
}

export const SQRT3 = Math.sqrt(3);

/** 2つのタイルの六角距離 */
export function hexDistance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

/** タイル中心のワールド座標(外接半径 size) */
export function hexToWorld(h: Hex, size: number): { x: number; z: number } {
  return { x: size * SQRT3 * (h.q + h.r / 2), z: size * 1.5 * h.r };
}

/** ワールド座標を含むタイル */
export function worldToHex(x: number, z: number, size: number): Hex {
  const fq = ((SQRT3 / 3) * x - z / 3) / size;
  const fr = ((2 / 3) * z) / size;
  // キューブ座標で丸める
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  // -0 を 0 にそろえる
  return { q: q + 0, r: r + 0 };
}

/** 中心から radius 以内のすべてのタイル(並び順は固定:q の昇順、同じ q なら r の昇順) */
export function hexesWithin(radius: number, center: Hex = { q: 0, r: 0 }): Hex[] {
  const out: Hex[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

/** 6方向の隣接オフセット(+q 方向から反時計回り) */
export const HEX_DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** 中心のまわりを60°× k 回転したタイル */
export function rotateHex(h: Hex, k: number): Hex {
  let x = h.q;
  let z = h.r;
  let y = -x - z;
  for (let i = 0; i < ((k % 6) + 6) % 6; i++) {
    // キューブ座標の60°回転:(x, y, z) → (-z, -x, -y)
    const nx = -z;
    const ny = -x;
    const nz = -y;
    x = nx;
    y = ny;
    z = nz;
  }
  return { q: x + 0, r: z + 0 };
}

export function hexKey(h: Hex): string {
  return `${h.q},${h.r}`;
}
