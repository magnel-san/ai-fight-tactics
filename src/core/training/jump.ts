// トレーニング「ジャンプ」(任意。運動脳)。
// 平地でその場に立ち、一定間隔でジャンプ指令を出す。指令から一定時間のあいだにコアが上がった高さで報酬を与え、
// 指令がないのに跳ねたら減点する。関節だけでもピストンでも跳べる。
import { JUMP_TASK } from '../config';
import type { Blueprint } from '../creature/blueprint';
import { rotate } from '../math/quat';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { BRAIN_DT, EpisodeBase } from './episode';
import { addFlatGround, spawnHeight } from './move';

export class JumpEpisode extends EpisodeBase {
  readonly fighter: Fighter;
  private nextJumpAt = JUMP_TASK.firstAt;
  /** 測定中のジャンプ(指令を出した時刻・跳ぶ前の高さ・最高到達点) */
  private current: { at: number; base: number; top: number } | null = null;
  /** 跳ぶ前の高さを測るための、直近の高さの記録 */
  private recent: number[] = [];
  private heights: number[] = [];

  constructor(R: Rapier, bp: Blueprint, motorGenome: Float64Array, seed: number) {
    super(R);
    this.posture = true;
    const rng = new Rng(seed);
    addFlatGround(R, this.world);
    this.fighter = new Fighter(R, this.world, bp, motorGenome, { position: { x: 0, y: spawnHeight(bp), z: 0 }, yaw: rng.range(-Math.PI, Math.PI) });
    this.fighters = [this.fighter];
  }

  /** ジャンプごとの上がり幅 [m] */
  jumpHeights(): number[] {
    return [...this.heights];
  }

  protected think(): void {
    const f = this.fighter;
    const t = this.time;
    if (!f.isFinite()) {
      this.reward -= 100;
      this.finish();
      return;
    }
    const y = f.position().y;
    const up = rotate(f.core.rotation(), 0, 1, 0);
    if (up[1] < 0) this.reward -= BRAIN_DT;

    // ジャンプ指令を出す
    if (!this.current && t >= this.nextJumpAt) {
      const base = this.recent.length ? this.recent.reduce((s, v) => s + v, 0) / this.recent.length : y;
      this.current = { at: t, base, top: y };
      this.nextJumpAt += JUMP_TASK.interval;
    }
    if (this.current) {
      this.current.top = Math.max(this.current.top, y);
      if (t - this.current.at >= JUMP_TASK.window) {
        const h = Math.max(0, this.current.top - this.current.base);
        this.heights.push(h);
        this.reward += JUMP_TASK.heightWeight * h;
        this.current = null;
        this.recent = [];
      }
    } else {
      // 指令がないのに跳ねたら減点
      if (f.core.linvel().y > JUMP_TASK.idleVelocity) this.reward -= JUMP_TASK.idlePenalty * BRAIN_DT;
      this.recent.push(y);
      const keep = Math.round(JUMP_TASK.baseline / BRAIN_DT);
      if (this.recent.length > keep) this.recent.shift();
    }

    const n = this.heights.length;
    this.metric = n ? this.heights.reduce((s, v) => s + v, 0) / n : 0;
    if (t >= JUMP_TASK.timeLimit) {
      this.success = this.metric >= JUMP_TASK.passHeight;
      if (this.heights.some((h) => h >= JUMP_TASK.passHeight)) this.flags.jumped = true;
      this.finish();
      return;
    }

    const jumping = this.current !== null && t - this.current.at < JUMP_TASK.pulse;
    const h = f.heading();
    f.command = { dirX: h.fx, dirZ: h.fz, speed: 0, jump: jumping ? 1 : 0 };
    f.drive(t);
  }
}
