// トレーニング「対象を追う」(仕様書セクション9、メニュー2)。
// 目標が一定速度で逃げ、ときどき曲がる。指令は常に目標の方向。
// 報酬は距離が縮んだ量と、指令方向と実際の移動方向の一致度。
import { CHASE_TASK } from '../config';
import type { Blueprint } from '../creature/blueprint';
import { cos, sin } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { BRAIN_DT, EpisodeBase } from './episode';
import { addFlatGround, sectorAngle, spawnHeight, type Sector } from './move';

export class ChaseEpisode extends EpisodeBase {
  readonly fighter: Fighter;
  private rng: Rng;
  /** 目標の進行方向 [rad]((cos, sin) で表す) */
  private heading: number;
  private nextTurnAt: number;
  private prevDist: number;
  private alignSum = 0;
  private alignCount = 0;
  /** 直近の位置と指令方向(単位ベクトル)の記録。移動方向は一定時間の変位で測る */
  private trail: { x: number; z: number; cx: number; cz: number }[] = [];

  constructor(R: Rapier, bp: Blueprint, motorGenome: Float64Array, seed: number, sector: Sector = { index: 0, count: 1 }) {
    super(R);
    this.rng = new Rng(seed);
    addFlatGround(R, this.world);
    const yaw = this.rng.range(-Math.PI, Math.PI);
    this.fighter = new Fighter(R, this.world, bp, motorGenome, { position: { x: 0, y: spawnHeight(bp), z: 0 }, yaw });
    this.fighters = [this.fighter];

    const angle = Math.PI / 2 - yaw + sectorAngle(this.rng, sector);
    this.target = { x: cos(angle) * CHASE_TASK.startDist, z: sin(angle) * CHASE_TASK.startDist };
    this.prevDist = CHASE_TASK.startDist;
    // 最初はキャラから離れる向きに逃げる(少しばらつかせる)
    this.heading = angle + this.rng.range(-0.5, 0.5);
    this.nextTurnAt = this.rng.range(CHASE_TASK.turnIntervalMin, CHASE_TASK.turnIntervalMax);
  }

  /** 一致度の平均(-1〜1) */
  alignment(): number {
    return this.alignCount > 0 ? this.alignSum / this.alignCount : 0;
  }

  protected think(): void {
    const f = this.fighter;
    const t = this.time;
    if (!f.isFinite()) {
      this.reward -= 100;
      this.finish();
      return;
    }

    // 目標を動かす
    if (t >= this.nextTurnAt) {
      this.heading += this.rng.range(-CHASE_TASK.turnAngleMax, CHASE_TASK.turnAngleMax);
      this.nextTurnAt += this.rng.range(CHASE_TASK.turnIntervalMin, CHASE_TASK.turnIntervalMax);
    }
    const target = this.target!;
    target.x += cos(this.heading) * CHASE_TASK.targetSpeed * BRAIN_DT;
    target.z += sin(this.heading) * CHASE_TASK.targetSpeed * BRAIN_DT;

    const p = f.position();
    const tx = target.x - p.x;
    const tz = target.z - p.z;
    const dist = Math.sqrt(tx * tx + tz * tz);
    this.reward += this.prevDist - dist;
    this.prevDist = dist;

    // 一致度:直近の一定時間の指令方向の平均と、同じ時間の変位(実際の移動方向)の内積。
    // 歩くと体は左右に揺れるので、瞬間の速度ではなく一定時間の変位で移動方向を測る。遅いときは小さくなる
    const c = f.command;
    const cl = Math.sqrt(c.dirX * c.dirX + c.dirZ * c.dirZ);
    this.trail.push({ x: p.x, z: p.z, cx: cl > 1e-9 ? c.dirX / cl : 0, cz: cl > 1e-9 ? c.dirZ / cl : 0 });
    const window = Math.round(CHASE_TASK.alignWindow / BRAIN_DT);
    if (this.trail.length > window + 1) this.trail.shift();
    if (t >= CHASE_TASK.warmup && this.trail.length === window + 1) {
      const first = this.trail[0];
      const dx = p.x - first.x;
      const dz = p.z - first.z;
      let ax = 0;
      let az = 0;
      for (let i = 0; i < window; i++) {
        ax += this.trail[i].cx;
        az += this.trail[i].cz;
      }
      const al = Math.sqrt(ax * ax + az * az);
      const moved = Math.sqrt(dx * dx + dz * dz);
      if (al > 1e-9) {
        const a = (ax * dx + az * dz) / al / Math.max(moved, CHASE_TASK.alignMinSpeed * CHASE_TASK.alignWindow);
        const align = Math.max(-1, Math.min(1, a));
        this.alignSum += align;
        this.alignCount++;
        this.reward += CHASE_TASK.alignWeight * align * BRAIN_DT;
      }
    }

    if (t >= CHASE_TASK.timeLimit) {
      this.metric = this.alignment();
      this.success = this.metric >= CHASE_TASK.passAlignment;
      this.finish();
      return;
    }

    f.command = { dirX: tx, dirZ: tz, speed: 1 };
    f.drive(t);
  }
}
