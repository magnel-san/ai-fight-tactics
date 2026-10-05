// 崩落ステージでの試合(仕様書セクション6・11)。
// 本番のバトル、トレーニング「生き残り」(1体)、「押し合い」(2体)で共通に使う。
// 報酬はトレーニング用で、0番のキャラ(鍛えている側)から見た値。
import { DecisionBrain, footing, rushCommand } from '../brain/decision';
import { BATTLE, PHYSICS, PUSH_TASK, STAGE, SURVIVE_TASK } from '../config';
import { atan2 } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { hexDistance, hexToWorld, rotateHex, worldToHex } from '../stage/hex';
import { Stage } from '../stage/stage';
import { BRAIN_DT, EpisodeBase } from '../training/episode';
import { spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';
import { Fighter } from './fighter';

export type MatchMode = 'battle' | 'survive' | 'push';

export interface MatchOptions {
  mode: MatchMode;
  seed: number;
  /** 1体(生き残り)または2体(バトル・押し合い) */
  fighters: FighterData[];
  /** 崩落ペース(レベル) */
  pace?: number;
  /** 時間制限 [s](省略時はモードごとの既定値) */
  timeLimit?: number;
}

export interface MatchResult {
  /** 勝者の番号。引き分けは null */
  winner: number | null;
  /** 脱落した時刻 [s](脱落していなければ null) */
  outAt: (number | null)[];
  time: number;
}

export class MatchEpisode extends EpisodeBase {
  readonly options: MatchOptions;
  readonly timeLimit: number;
  private brains: (DecisionBrain | null)[];
  private result: MatchResult | null = null;
  private outAt: (number | null)[];
  private prevPush = 0;

  constructor(R: Rapier, opts: MatchOptions) {
    super(R);
    this.options = opts;
    this.timeLimit = opts.timeLimit ?? (opts.mode === 'battle' ? BATTLE.timeLimit : opts.mode === 'push' ? PUSH_TASK.timeLimit : SURVIVE_TASK.timeLimit);
    const rng = new Rng(opts.seed);
    this.stage = new Stage(R, this.world, rng.nextU32(), { rules: true, pace: opts.pace ?? 1 });

    // スポーン:中心を挟んで反対側、中心を向いて、タイル上面から一定の高さに置く。並びの向きはシードで決める
    const rot = rng.int(6);
    const spots = [rotateHex({ q: -STAGE.spawnDistance, r: 0 }, rot), rotateHex({ q: STAGE.spawnDistance, r: 0 }, rot)];
    this.fighters = opts.fighters.map((data, i) => {
      const { x, z } = hexToWorld(spots[i], STAGE.tileCircumradius);
      const yaw = atan2(-x, -z);
      return new Fighter(R, this.world, data.blueprint, data.motor, {
        position: { x, y: spawnHeight(data.blueprint) + STAGE.spawnHeight, z },
        yaw,
      });
    });
    this.brains = opts.fighters.map((d) => (d.controller === 'brain' && d.decision ? new DecisionBrain(d.decision) : null));
    this.outAt = opts.fighters.map(() => null);
  }

  get stageOrThrow(): Stage {
    return this.stage!;
  }

  matchResult(): MatchResult | null {
    return this.result;
  }

  advance(): void {
    super.advance();
    if (!this.finished) this.checkFalls();
  }

  /** 毎ステップ、脱落を判定する(同じステップで両者が脱落したら引き分け) */
  private checkFalls(): void {
    let anyOut = false;
    this.fighters.forEach((f, i) => {
      if (f.out) return;
      const p = f.position();
      if (!f.isFinite() || p.y < -PHYSICS.fallDepth) {
        f.out = true;
        this.outAt[i] = this.time;
        anyOut = true;
      }
    });
    if (!anyOut) return;
    const alive = this.fighters.map((f, i) => (f.out ? -1 : i)).filter((i) => i >= 0);
    if (this.fighters.length === 1 || alive.length <= 1) {
      this.end(this.fighters.length === 2 && alive.length === 1 ? alive[0] : null);
    }
  }

  private end(winner: number | null): void {
    this.result = { winner, outAt: [...this.outAt], time: this.time };
    const me = this.fighters[0];
    if (this.options.mode === 'survive') {
      if (me.out) this.reward -= SURVIVE_TASK.fallPenalty;
    } else if (this.options.mode === 'push') {
      if (winner === 0) this.reward += PUSH_TASK.winBonus;
      else if (winner === 1) this.reward -= PUSH_TASK.losePenalty;
    }
    if (this.options.mode === 'battle' || this.options.mode === 'push') {
      this.success = winner === 0;
      this.flags.won = winner === 0;
    } else {
      this.success = !me.out;
    }
    if (!me.out && this.time >= 60 - 1e-9) this.flags.survived60 = true;
    this.finish();
  }

  /** 相手がどれだけ危険な場所にいるか(押し合いの報酬に使う) */
  private dangerOf(f: Fighter): number {
    const stage = this.stage!;
    const p = f.position();
    const d = stage.dangerAt(p.x, p.z);
    let score = d < 0 ? 1 : d;
    const h = worldToHex(p.x, p.z, stage.size);
    const beyond = hexDistance(h, stage.finalPoint) - stage.safeRadius;
    if (beyond > 0) score += 0.5 + 0.1 * beyond;
    return score;
  }

  protected think(): void {
    const stage = this.stage!;
    const t = this.time;

    // ステージを進める(脱落していないキャラのコアの位置で滞在タイマーを溜める)
    stage.update(
      BRAIN_DT,
      this.fighters.filter((f) => !f.out).map((f) => f.position()),
    );

    // 報酬(0番から見た値)
    const me = this.fighters[0];
    if (!me.out && this.options.mode !== 'battle') {
      const p = me.position();
      const d = stage.dangerAt(p.x, p.z);
      if (this.options.mode === 'survive') {
        this.reward += SURVIVE_TASK.aliveBonus * BRAIN_DT;
        if (d === 0) this.reward += SURVIVE_TASK.safeBonus * BRAIN_DT;
        else this.reward -= SURVIVE_TASK.dangerPenalty * BRAIN_DT;
      } else {
        this.reward += PUSH_TASK.aliveBonus * BRAIN_DT;
        const opp = this.fighters[1];
        if (opp && !opp.out) {
          const push = this.dangerOf(opp);
          if (t > 0) this.reward += PUSH_TASK.pushWeight * (push - this.prevPush);
          this.prevPush = push;
        }
      }
    }

    if (t >= this.timeLimit) {
      this.end(null);
      return;
    }

    // 各キャラの判断と運動
    this.fighters.forEach((f, i) => {
      if (f.out) return;
      const opponent = this.fighters.length === 2 ? this.fighters[1 - i] : null;
      const brain = this.brains[i];
      if (brain) f.command = brain.think({ self: f, opponent, stage, time: t });
      else if (this.options.fighters[i].controller === 'rush') f.command = rushCommand(f, opponent);
      f.drive(t, footing(stage, f));
    });
  }
}
