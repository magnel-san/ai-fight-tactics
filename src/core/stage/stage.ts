// 崩落していく六角タイルのステージ(仕様書セクション6)。
// タイルの状態は「安全 → 危険マーク(2秒) → 崩落」。
// 物理では、残っているタイルの上面と穴の縁の壁を1つの三角形メッシュにまとめる(タイルが崩れたら作り直す)。
// タイルごとに別のコライダーにすると、境目の辺に体が引っかかる(ゴースト衝突)ため、
// 頂点を共有した1枚のメッシュにして Rapier の FIX_INTERNAL_EDGES で境目を滑らかにしている。
// 3つの崩落ルールはすべてステージのシードから決まる。
//   A:安全円の収縮  B:滞在による崩落  C:ランダム崩落
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';
import { STAGE } from '../config';
import { cos, sin } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { hexDistance, hexesWithin, hexKey, hexToWorld, worldToHex, type Hex } from './hex';

export type TileState = 'safe' | 'warning' | 'collapsed';

export interface Tile extends Hex {
  x: number;
  z: number;
  state: TileState;
  /** 危険マークがついてからの時間 [s] */
  warnTime: number;
  /** 滞在タイマー [s] */
  stay: number;
  /** 崩落した時刻 [s](描画で落ちていく演出に使う) */
  collapsedAt: number;
}

export interface StageOptions {
  /** 崩落ルールを使うか(穴をまたぐ課題では使わない) */
  rules: boolean;
  /** 安全円の縮小とランダム崩落の進み方の倍率(レベル) */
  pace?: number;
  /** 最初から穴にしておくタイル */
  holes?: Hex[];
}

export class Stage {
  readonly tiles: Tile[] = [];
  readonly size = STAGE.tileCircumradius;
  /** 安全円の中心(最終地点) */
  readonly finalPoint: Hex;
  readonly initialSafeRadius: number;
  safeRadius: number;
  /** ステージの経過時間 [s] */
  time = 0;
  /** (q, r) → タイル番号の表(文字列のキーを作らずに引けるよう、整数の添字で持つ。なければ -1) */
  private index: Int16Array;
  private rng: Rng;
  private pace: number;
  private nextRandomAt: number;
  private body: RigidBody;
  private collider: Collider | null = null;
  /** タイルが崩れて、物理のメッシュを作り直す必要がある */
  private dirty = false;

  constructor(
    private R: Rapier,
    private world: World,
    seed: number,
    private opts: StageOptions,
  ) {
    this.rng = new Rng(seed);
    this.pace = opts.pace ?? 1;

    const span = 2 * STAGE.radius + 1;
    this.index = new Int16Array(span * span).fill(-1);
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const holes = new Set((opts.holes ?? []).map(hexKey));
    for (const h of hexesWithin(STAGE.radius)) {
      const { x, z } = hexToWorld(h, this.size);
      const hole = holes.has(hexKey(h));
      this.index[this.slot(h.q, h.r)] = this.tiles.length;
      this.tiles.push({ ...h, x, z, state: hole ? 'collapsed' : 'safe', warnTime: 0, stay: 0, collapsedAt: hole ? -Infinity : 0 });
    }
    this.rebuildCollider();

    // ルールA:最終地点は中心から一定距離以内のタイルからランダムに選ぶ
    const candidates = hexesWithin(STAGE.finalPointMaxDist);
    this.finalPoint = candidates[this.rng.int(candidates.length)];
    this.initialSafeRadius = Math.max(...this.tiles.map((t) => hexDistance(t, this.finalPoint)));
    this.safeRadius = this.initialSafeRadius;
    this.nextRandomAt = STAGE.randomStart;
  }

  private slot(q: number, r: number): number {
    const R = STAGE.radius;
    if (q < -R || q > R || r < -R || r > R) return -1;
    return (q + R) * (2 * R + 1) + (r + R);
  }

  tileAt(x: number, z: number): Tile | undefined {
    const h = worldToHex(x, z, this.size);
    const s = this.slot(h.q, h.r);
    const i = s < 0 ? -1 : this.index[s];
    return i < 0 ? undefined : this.tiles[i];
  }

  /** その位置に足場がないか(ステージの外・崩落したタイル) */
  isHole(x: number, z: number): boolean {
    const t = this.tileAt(x, z);
    return !t || t.state === 'collapsed';
  }

  /**
   * 判断脳の「目」が読む値。安全 = 0、危険 = 0.5〜1(崩落が近いほど1)、穴 = -1
   */
  dangerAt(x: number, z: number): number {
    const t = this.tileAt(x, z);
    if (!t || t.state === 'collapsed') return -1;
    if (t.state === 'warning') return 0.5 + 0.5 * Math.min(1, t.warnTime / STAGE.warningTime);
    return 0;
  }

  /** 安全円の外にあるか */
  isOutsideSafe(h: Hex): boolean {
    return hexDistance(h, this.finalPoint) > this.safeRadius;
  }

  /** 崩落ルールで使う時計(ペースの倍率をかけた経過時間) */
  get ruleClock(): number {
    return this.time * this.pace;
  }

  /**
   * dt 秒進める。occupants は各キャラのコアの位置(脱落したキャラは含めない)
   */
  update(dt: number, occupants: readonly { x: number; z: number }[]): void {
    this.time += dt;
    if (this.opts.rules) {
      this.updateSafeCircle();
      this.updateStay(dt, occupants);
      this.updateRandom();
    }
    // 危険マークの時間経過と崩落(ペースによらず一定)
    for (const t of this.tiles) {
      if (t.state !== 'warning') continue;
      t.warnTime += dt;
      if (t.warnTime >= STAGE.warningTime) this.collapse(t);
    }
    if (this.dirty) this.rebuildCollider();
  }

  /** 残っているタイルから、物理の三角形メッシュを作り直す */
  private rebuildCollider(): void {
    this.dirty = false;
    if (this.collider) {
      this.world.removeCollider(this.collider, false);
      this.collider = null;
    }
    const mesh = buildStageMesh(this.tiles, this.size, STAGE.tileHeight, (x, z) => !this.isHole(x, z));
    if (mesh.indices.length === 0) return;
    const desc = this.R.ColliderDesc.trimesh(mesh.vertices, mesh.indices, this.R.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(STAGE.tileFriction);
    this.collider = this.world.createCollider(desc, this.body);
  }

  private warn(t: Tile): void {
    if (t.state !== 'safe') return;
    t.state = 'warning';
    t.warnTime = 0;
  }

  private collapse(t: Tile): void {
    t.state = 'collapsed';
    t.collapsedAt = this.time;
    this.dirty = true;
  }

  /** ルールA:開始から一定時間後、一定間隔で安全半径が1ずつ縮み、円の外のタイルに危険マークがつく */
  private updateSafeCircle(): void {
    const clock = this.ruleClock;
    if (clock < STAGE.shrinkStart) return;
    const shrinks = 1 + Math.floor((clock - STAGE.shrinkStart) / STAGE.shrinkInterval);
    const radius = Math.max(STAGE.minSafeRadius, this.initialSafeRadius - shrinks);
    if (radius === this.safeRadius) return;
    this.safeRadius = radius;
    for (const t of this.tiles) if (this.isOutsideSafe(t)) this.warn(t);
  }

  /** ルールB:コアの真下のタイルに滞在タイマーが溜まり、離れると半分の速さで減る */
  private updateStay(dt: number, occupants: readonly { x: number; z: number }[]): void {
    const under = new Set<Tile>();
    for (const p of occupants) {
      const t = this.tileAt(p.x, p.z);
      if (t && t.state !== 'collapsed') under.add(t);
    }
    for (const t of this.tiles) {
      if (t.state === 'collapsed') continue;
      if (under.has(t)) {
        t.stay += dt;
        if (t.stay >= STAGE.stayLimit) this.warn(t);
      } else if (t.stay > 0) {
        t.stay = Math.max(0, t.stay - dt * STAGE.stayDecayRatio);
      }
    }
  }

  /** ルールC:開始から一定時間後、安全円の内側の安全なタイルをランダムに選んで危険マークをつける */
  private updateRandom(): void {
    const clock = this.ruleClock;
    while (clock >= this.nextRandomAt) {
      const candidates = this.tiles.filter((t) => t.state === 'safe' && !this.isOutsideSafe(t));
      if (candidates.length > 0) this.warn(candidates[this.rng.int(candidates.length)]);
      this.nextRandomAt += randomInterval(this.nextRandomAt);
    }
  }
}

/** ランダム崩落の間隔:開始時は最初の間隔で、最終間隔に達する時刻まで直線的に短くなる */
export function randomInterval(clock: number): number {
  const a = STAGE.randomIntervalStart;
  const b = STAGE.randomIntervalEnd;
  const t = (clock - STAGE.randomStart) / (STAGE.randomIntervalEndTime - STAGE.randomStart);
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/**
 * 残っているタイルの上面(y = 0)と、穴やステージの外に面した縁の壁(高さ height)の三角形メッシュ。
 * 隣り合うタイルの角は同じ頂点を共有させる(内部の辺として扱われ、引っかかりがなくなる)。
 * 三角形は外側(上面は +y、壁は穴の側)を向くように並べる
 */
export function buildStageMesh(
  tiles: readonly Tile[],
  size: number,
  height: number,
  solid: (x: number, z: number) => boolean,
): { vertices: Float32Array; indices: Uint32Array } {
  const vertices: number[] = [];
  const indices: number[] = [];
  const welded = new Map<string, number>();
  // 角の位置は丸めたキーで同じ頂点にまとめる(タイルごとの計算の誤差を吸収する)
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let i = welded.get(key);
    if (i === undefined) {
      i = vertices.length / 3;
      vertices.push(x, y, z);
      welded.set(key, i);
    }
    return i;
  };
  // 角の方向(とがった頂点が ±z を向く:30°, 90°, …)
  const corners = Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k + Math.PI / 6;
    return { x: size * cos(a), z: size * sin(a) };
  });
  for (const t of tiles) {
    if (t.state === 'collapsed') continue;
    const c = vertex(t.x, 0, t.z);
    const top = corners.map((o) => vertex(t.x + o.x, 0, t.z + o.z));
    for (let k = 0; k < 6; k++) {
      const k1 = (k + 1) % 6;
      // 上面(+y を向く並び)
      indices.push(c, top[k1], top[k]);
      // 隣が穴なら、その辺に壁を立てる
      const mx = t.x + ((corners[k].x + corners[k1].x) / 2) * 1.2;
      const mz = t.z + ((corners[k].z + corners[k1].z) / 2) * 1.2;
      if (solid(mx, mz)) continue;
      const b0 = vertex(t.x + corners[k].x, -height, t.z + corners[k].z);
      const b1 = vertex(t.x + corners[k1].x, -height, t.z + corners[k1].z);
      indices.push(top[k], top[k1], b1, top[k], b1, b0);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
