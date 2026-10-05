// 崩落していく六角タイルのステージ(仕様書セクション6)。
// タイルの状態は「安全 → 危険マーク(2秒) → 崩落」。崩落したタイルはコライダーを取り除く。
// 3つの崩落ルールはすべてステージのシードから決まる。
//   A:安全円の収縮  B:滞在による崩落  C:ランダム崩落
import type { Collider, World } from '@dimforge/rapier3d-compat';
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
  collider: Collider | null;
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
  private index = new Map<string, number>();
  private rng: Rng;
  private pace: number;
  private nextRandomAt: number;

  constructor(
    R: Rapier,
    private world: World,
    seed: number,
    private opts: StageOptions,
  ) {
    this.rng = new Rng(seed);
    this.pace = opts.pace ?? 1;

    const body = world.createRigidBody(R.RigidBodyDesc.fixed());
    const holes = new Set((opts.holes ?? []).map(hexKey));
    const shape = hexPrismPoints(this.size, STAGE.tileHeight);
    for (const h of hexesWithin(STAGE.radius)) {
      const { x, z } = hexToWorld(h, this.size);
      const hole = holes.has(hexKey(h));
      let collider: Collider | null = null;
      if (!hole) {
        const desc = R.ColliderDesc.convexHull(shape)!.setTranslation(x, 0, z).setFriction(STAGE.tileFriction);
        collider = world.createCollider(desc, body);
      }
      this.index.set(hexKey(h), this.tiles.length);
      this.tiles.push({ ...h, x, z, state: hole ? 'collapsed' : 'safe', warnTime: 0, stay: 0, collapsedAt: hole ? -Infinity : 0, collider });
    }

    // ルールA:最終地点は中心から一定距離以内のタイルからランダムに選ぶ
    const candidates = hexesWithin(STAGE.finalPointMaxDist);
    this.finalPoint = candidates[this.rng.int(candidates.length)];
    this.initialSafeRadius = Math.max(...this.tiles.map((t) => hexDistance(t, this.finalPoint)));
    this.safeRadius = this.initialSafeRadius;
    this.nextRandomAt = STAGE.randomStart;
  }

  tileAt(x: number, z: number): Tile | undefined {
    const i = this.index.get(hexKey(worldToHex(x, z, this.size)));
    return i === undefined ? undefined : this.tiles[i];
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
  }

  private warn(t: Tile): void {
    if (t.state !== 'safe') return;
    t.state = 'warning';
    t.warnTime = 0;
  }

  private collapse(t: Tile): void {
    t.state = 'collapsed';
    t.collapsedAt = this.time;
    if (t.collider) {
      this.world.removeCollider(t.collider, false);
      t.collider = null;
    }
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

/** 六角柱の頂点(上面が y = 0)。とがった頂点が ±z を向く */
function hexPrismPoints(size: number, height: number): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    const x = size * cos(a);
    const z = size * sin(a);
    pts.push(x, 0, z, x, -height, z);
  }
  return new Float32Array(pts);
}
