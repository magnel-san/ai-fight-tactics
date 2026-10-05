// クォータニオンによるベクトルの回転(core/ 用。Rapier の {x,y,z,w} 形式をそのまま受け取る)

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** q でベクトル (x, y, z) を回転する(ローカル → ワールド) */
export function rotate(q: Quat, x: number, y: number, z: number): [number, number, number] {
  // v' = v + 2w (u×v) + 2 u×(u×v)、u = (q.x, q.y, q.z)
  const cx = q.y * z - q.z * y;
  const cy = q.z * x - q.x * z;
  const cz = q.x * y - q.y * x;
  return [
    x + 2 * (q.w * cx + q.y * cz - q.z * cy),
    y + 2 * (q.w * cy + q.z * cx - q.x * cz),
    z + 2 * (q.w * cz + q.x * cy - q.y * cx),
  ];
}

/** q の逆回転でベクトルを回転する(ワールド → ローカル) */
export function rotateInv(q: Quat, x: number, y: number, z: number): [number, number, number] {
  return rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z);
}
