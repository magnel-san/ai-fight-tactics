// トレーニング「目標地点への移動」(仕様書セクション9、メニュー1)。
// 平地で、4〜6m先のランダムな目標に向かう。指令は常に目標の方向、速さ1。
// 学習用Workerでも観戦用のメインスレッドでも同じこのクラスを使うので、同じシードなら同じ動きになる。
import type { World } from '@dimforge/rapier3d-compat';
import { MotorBrain } from '../brain/motor';
import { CREATURE, MOVE_TASK, PHYSICS } from '../config';
import { setJointTargets, spawnCreature, type Creature } from '../creature/assemble';
import { blockPositions, type Blueprint } from '../creature/blueprint';
import { cos, sin } from '../math/fmath';
import { rotate } from '../math/quat';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';

export interface EpisodeResult {
  reward: number;
  reached: boolean;
  /** 終了時刻 [s] */
  time: number;
}

/** キャラの最も低いブロックの底面が床から少し浮く、コアの初期高さ */
export function spawnHeight(bp: Blueprint): number {
  const minY = Math.min(...blockPositions(bp).map((p) => p[1]));
  return (-minY + 0.5) * CREATURE.blockSize + 0.05;
}

export class MoveEpisode {
  readonly world: World;
  readonly creature: Creature;
  readonly target: { x: number; z: number };
  private brain: MotorBrain;
  private step = 0;
  private reward = 0;
  private prevDist: number;
  private _done = false;
  private reached = false;

  /**
   * sector は目標の方向の割り当て。キャラの正面から見た全周を count 等分し、index 番目の範囲の中で
   * ランダムに方向を選ぶ。複数エピソードで評価するとき、正面にある目標だけに偶然到達して
   * 高得点になるのを防ぎ、どの方向にも向かえるかを公平に測るため
   */
  constructor(
    R: Rapier,
    bp: Blueprint,
    genome: Float64Array,
    seed: number,
    sector: { index: number; count: number } = { index: 0, count: 1 },
  ) {
    const rng = new Rng(seed);
    this.world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = PHYSICS.dt;
    const g = MOVE_TASK.groundHalfSize;
    this.world.createCollider(R.ColliderDesc.cuboid(g, 0.1, g).setTranslation(0, -0.1, 0).setFriction(0.8));

    const yaw = rng.range(-Math.PI, Math.PI);
    this.creature = spawnCreature(R, this.world, bp, { position: { x: 0, y: spawnHeight(bp), z: 0 }, yaw });

    // 正面(コアの +z)の方向は、目標の角度の表し方 (cos, sin) で π/2 - yaw にあたる
    const relative = -Math.PI + (2 * Math.PI * (sector.index + rng.next())) / sector.count;
    const angle = Math.PI / 2 - yaw + relative;
    const dist = rng.range(MOVE_TASK.targetDistMin, MOVE_TASK.targetDistMax);
    this.target = { x: cos(angle) * dist, z: sin(angle) * dist };
    this.prevDist = dist;
    this.brain = new MotorBrain(this.creature, genome);
  }

  get done(): boolean {
    return this._done;
  }

  get time(): number {
    return this.step * PHYSICS.dt;
  }

  /** コアから目標までの水平距離 */
  distance(): number {
    const p = this.creature.bodies[0].translation();
    return Math.sqrt((this.target.x - p.x) ** 2 + (this.target.z - p.z) ** 2);
  }

  /** 物理を1ステップ進める。3ステップに1回、脳が考えて報酬を計算する */
  advance(): void {
    if (this._done) return;
    if (this.step % PHYSICS.brainInterval === 0) {
      this.think();
      if (this._done) return;
    }
    this.world.step();
    this.step++;
  }

  run(): EpisodeResult {
    while (!this._done) this.advance();
    return this.result();
  }

  result(): EpisodeResult {
    return { reward: this.reward, reached: this.reached, time: this.time };
  }

  free(): void {
    this.world.free();
  }

  private think(): void {
    const core = this.creature.bodies[0];
    const p = core.translation();
    const t = this.time;
    const brainDt = PHYSICS.dt * PHYSICS.brainInterval;

    // 物理が発散したら、その個体は大きく減点して打ち切る
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      this.reward -= 100;
      this._done = true;
      return;
    }

    const dist = this.distance();
    this.reward += this.prevDist - dist;
    this.prevDist = dist;

    const up = rotate(core.rotation(), 0, 1, 0);
    if (up[1] < 0) this.reward -= MOVE_TASK.flipPenaltyPerSec * brainDt;

    if (dist < MOVE_TASK.arriveRadius) {
      this.reached = true;
      this.reward += MOVE_TASK.arriveBonus + MOVE_TASK.arriveTimeBonus * (1 - t / MOVE_TASK.timeLimit);
      this._done = true;
      return;
    }
    if (t >= MOVE_TASK.timeLimit) {
      this._done = true;
      return;
    }

    const out = this.brain.think({ dirX: this.target.x - p.x, dirZ: this.target.z - p.z, speed: 1 }, t);
    setJointTargets(this.creature, out);
  }
}

/**
 * 1個体を複数のシードで評価する。適応度は報酬の平均。
 * i 番目のエピソードの目標は、正面から見た全周を seeds.length 等分した i 番目の範囲に置く
 */
export function evaluateMove(
  R: Rapier,
  bp: Blueprint,
  genome: Float64Array,
  seeds: readonly number[],
): { fitness: number; reachedCount: number } {
  let sum = 0;
  let reachedCount = 0;
  for (let i = 0; i < seeds.length; i++) {
    const ep = new MoveEpisode(R, bp, genome, seeds[i], { index: i, count: seeds.length });
    const r = ep.run();
    ep.free();
    sum += r.reward;
    if (r.reached) reachedCount++;
  }
  return { fitness: sum / seeds.length, reachedCount };
}
