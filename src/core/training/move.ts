// トレーニング「目標地点への移動」(仕様書セクション9、メニュー1)。
// 平地で、4〜6m先のランダムな目標に向かう。指令は常に目標の方向、速さ1。
// 学習用Workerでも観戦用のメインスレッドでも同じこのクラスを使うので、同じシードなら同じ動きになる。
import { CREATURE, MOVE_TASK } from '../config';
import { blockPositions, type Blueprint } from '../creature/blueprint';
import { cos, sin } from '../math/fmath';
import { rotate } from '../math/quat';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { BRAIN_DT, EpisodeBase } from './episode';

/** キャラの最も低いブロックの底面が床から少し浮く、コアの初期高さ */
export function spawnHeight(bp: Blueprint): number {
  const minY = Math.min(...blockPositions(bp).map((p) => p[1]));
  return (-minY + 0.5) * CREATURE.blockSize + 0.05;
}

/** 目標の方向の割り当て。正面から見た全周を count 等分し、index 番目の範囲の中でランダムに選ぶ */
export interface Sector {
  index: number;
  count: number;
}

/** 正面からの相対角 [rad](-π〜π) */
export function sectorAngle(rng: Rng, sector: Sector): number {
  return -Math.PI + (2 * Math.PI * (sector.index + rng.next())) / sector.count;
}

/** 平らな床を作る */
export function addFlatGround(R: Rapier, world: InstanceType<Rapier['World']>): void {
  const g = MOVE_TASK.groundHalfSize;
  world.createCollider(R.ColliderDesc.cuboid(g, 0.1, g).setTranslation(0, -0.1, 0).setFriction(0.8));
}

export class MoveEpisode extends EpisodeBase {
  private prevDist: number;
  readonly fighter: Fighter;

  /**
   * sector は目標の方向の割り当て。複数エピソードで評価するとき、正面にある目標だけに偶然到達して
   * 高得点になるのを防ぎ、どの方向にも向かえるかを公平に測るため
   */
  constructor(R: Rapier, bp: Blueprint, motorGenome: Float64Array, seed: number, sector: Sector = { index: 0, count: 1 }) {
    super(R);
    const rng = new Rng(seed);
    addFlatGround(R, this.world);
    const yaw = rng.range(-Math.PI, Math.PI);
    this.fighter = new Fighter(R, this.world, bp, motorGenome, { position: { x: 0, y: spawnHeight(bp), z: 0 }, yaw });
    this.fighters = [this.fighter];

    // 正面(コアの +z)の方向は、目標の角度の表し方 (cos, sin) で π/2 - yaw にあたる
    const angle = Math.PI / 2 - yaw + sectorAngle(rng, sector);
    const dist = rng.range(MOVE_TASK.targetDistMin, MOVE_TASK.targetDistMax);
    this.target = { x: cos(angle) * dist, z: sin(angle) * dist };
    this.prevDist = dist;
  }

  /** コアから目標までの水平距離 */
  distance(): number {
    const p = this.fighter.position();
    return Math.sqrt((this.target!.x - p.x) ** 2 + (this.target!.z - p.z) ** 2);
  }

  protected think(): void {
    const f = this.fighter;
    const t = this.time;
    // 物理が発散したら、その個体は大きく減点して打ち切る
    if (!f.isFinite()) {
      this.reward -= 100;
      this.finish();
      return;
    }

    const dist = this.distance();
    this.reward += this.prevDist - dist;
    this.prevDist = dist;

    const up = rotate(f.core.rotation(), 0, 1, 0);
    if (up[1] < 0) this.reward -= MOVE_TASK.flipPenaltyPerSec * BRAIN_DT;

    if (dist < MOVE_TASK.arriveRadius) {
      this.success = true;
      this.flags.reached = true;
      this.reward += MOVE_TASK.arriveBonus + MOVE_TASK.arriveTimeBonus * (1 - t / MOVE_TASK.timeLimit);
      this.finish();
      return;
    }
    if (t >= MOVE_TASK.timeLimit) {
      this.finish();
      return;
    }

    const p = f.position();
    f.command = { dirX: this.target!.x - p.x, dirZ: this.target!.z - p.z, speed: 1 };
    f.drive(t);
  }
}
