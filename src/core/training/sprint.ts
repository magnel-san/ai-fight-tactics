// トレーニング「かけっこ」(全力疾走):平らな地面を、まっすぐ RACE.distance [m] 先まで走る。運動脳を鍛える。
// 進んだ距離がそのまま報酬になり、ゴールしたら残り時間に応じて加点する。姿勢の報酬も入れる(転がって進まないように)。
import type { Blueprint } from '../creature/blueprint';
import { RACE, SPRINT_TASK } from '../config';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { EpisodeBase } from './episode';
import { addFlatGround, spawnHeight } from './move';

export class SprintEpisode extends EpisodeBase {
  readonly target: { x: number; z: number };
  private startZ: number;
  private prevZ: number;

  constructor(R: Rapier, bp: Blueprint, motorGenome: Float64Array, seed: number) {
    super(R);
    this.posture = true;
    const rng = new Rng(seed);
    addFlatGround(R, this.world);
    const f = new Fighter(R, this.world, bp, motorGenome, { position: { x: 0, y: spawnHeight(bp), z: 0 }, yaw: rng.range(-0.1, 0.1) });
    this.fighters = [f];
    this.startZ = f.position().z;
    this.prevZ = this.startZ;
    this.target = { x: 0, z: this.startZ + RACE.distance };
    this.metric = SPRINT_TASK.timeLimit;
  }

  protected think(): void {
    const f = this.fighters[0];
    const t = this.time;
    if (!f.isFinite()) {
      this.finish();
      return;
    }
    const z = f.position().z;
    this.reward += z - this.prevZ;
    this.prevZ = z;
    if (z >= this.target.z) {
      this.reward += SPRINT_TASK.finishBonus * (1 - t / SPRINT_TASK.timeLimit);
      this.metric = t;
      this.success = t <= SPRINT_TASK.passTime;
      this.flags.reached = true;
      this.finish();
      return;
    }
    if (t >= SPRINT_TASK.timeLimit) {
      this.finish();
      return;
    }
    f.command = { dirX: 0, dirZ: 1, speed: 1 };
    f.drive(t);
  }
}
