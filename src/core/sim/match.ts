// 崩落ステージでの試合(仕様書セクション6・11)。
// 本番のバトル、トレーニング「生き残り」(1体)、「押し合い」(2体)で共通に使う。
// 報酬はトレーニング用で、0番のキャラ(鍛えている側)から見た値。
import { DecisionBrain, footing, rushCommand } from '../brain/decision';
import type { MotorCommand } from '../brain/motor';
import { AVOID_TASK, BATTLE, PHYSICS, PUSH_TASK, STAGE, STYLES, SURVIVE_TASK, type TrainStyle } from '../config';
import { atan2 } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { hexDistance, hexToWorld, rotateHex, worldToHex } from '../stage/hex';
import { Stage } from '../stage/stage';
import { BRAIN_DT, EpisodeBase } from '../training/episode';
import { spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';
import { Fighter } from './fighter';

/** avoid:崩れないステージで危険なタイルを避ける練習(崩れたタイルは踏んではいけない床として残る) */
export type MatchMode = 'battle' | 'survive' | 'push' | 'avoid';

export interface MatchOptions {
  mode: MatchMode;
  seed: number;
  /** 1体(生き残り)または2体(バトル・押し合い) */
  fighters: FighterData[];
  /** 崩落ペース(レベル) */
  pace?: number;
  /** 時間制限 [s](省略時はモードごとの既定値) */
  timeLimit?: number;
  /** 作戦タイプ(押し合いの報酬の重み。省略時はバランス) */
  style?: TrainStyle;
}

/** 脱落の原因:相手と接触した直後に落ちたら「押し出された」、そうでなければ「自分で落ちた」 */
export type FallCause = 'pushed' | 'fell';

export interface MatchResult {
  /** 勝者の番号。引き分けは null */
  winner: number | null;
  /** 脱落した時刻 [s](脱落していなければ null) */
  outAt: (number | null)[];
  /** 脱落の原因(脱落していなければ null) */
  causes: (FallCause | null)[];
  time: number;
}

/** 接触からこの時間以内に落ちたら「押し出された」とみなす [s] */
const PUSHED_WINDOW = 2;

export class MatchEpisode extends EpisodeBase {
  readonly options: MatchOptions;
  readonly timeLimit: number;
  private brains: (DecisionBrain | null)[];
  private result: MatchResult | null = null;
  private outAt: (number | null)[];
  private causes: (FallCause | null)[];
  private lastContact = -Infinity;
  private prevPush = 0;
  private prevOpponentDist: number | null = null;
  /** 踏んではいけないタイル(崩れたはずのタイル)に触れていた時間 [s](avoid のみ) */
  private forbiddenTime = 0;
  /** 外から指令を与える(手書きのルールのBOTや検証用)。null を返したキャラは通常どおり判断する */
  externalCommand: ((i: number, f: Fighter) => MotorCommand | null) | null = null;

  constructor(R: Rapier, opts: MatchOptions) {
    super(R);
    this.options = opts;
    this.timeLimit =
      opts.timeLimit ??
      (opts.mode === 'battle'
        ? BATTLE.timeLimit
        : opts.mode === 'push'
          ? PUSH_TASK.timeLimit
          : opts.mode === 'avoid'
            ? AVOID_TASK.timeLimit
            : SURVIVE_TASK.timeLimit);
    const rng = new Rng(opts.seed);
    this.stage = new Stage(R, this.world, rng.nextU32(), {
      rules: true,
      pace: opts.mode === 'avoid' ? AVOID_TASK.pace : (opts.pace ?? 1),
      solid: opts.mode === 'avoid',
    });

    // スポーン:中心を挟んで反対側、中心を向いて、タイル上面から一定の高さに置く。並びの向きはシードで決める
    const rot = rng.int(6);
    // 2体の間が spawnDistance マスになるよう、中心から半分ずつ離す(1体のときも同じ位置の片方を使う)
    const half = STAGE.spawnDistance / 2;
    const spots = [rotateHex({ q: -half, r: 0 }, rot), rotateHex({ q: half, r: 0 }, rot)];
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
    this.causes = opts.fighters.map(() => null);
  }

  get stageOrThrow(): Stage {
    return this.stage!;
  }

  /** i 番目のキャラの判断脳(ルールベースのBOTなら null) */
  decisionBrain(i: number): DecisionBrain | null {
    return this.brains[i] ?? null;
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
        this.causes[i] = this.fighters.length === 2 && this.time - this.lastContact < PUSHED_WINDOW ? 'pushed' : 'fell';
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
    this.result = { winner, outAt: [...this.outAt], causes: [...this.causes], time: this.time };
    const me = this.fighters[0];
    if (this.options.mode === 'survive') {
      if (me.out) this.reward -= SURVIVE_TASK.fallPenalty;
    } else if (this.options.mode === 'avoid') {
      if (me.out) this.reward -= AVOID_TASK.fallPenalty;
    } else if (this.options.mode === 'push') {
      // 押し出して勝つと大きく、相手の自滅で勝つと小さく加点。押し出されて負けると大きく減点
      const st = STYLES[this.options.style ?? 'balanced'];
      if (winner === 0) this.reward += this.causes[1] === 'pushed' ? PUSH_TASK.winPushBonus * st.winPush : PUSH_TASK.winFallBonus * st.winFall;
      else if (winner === 1) this.reward -= this.causes[0] === 'pushed' ? PUSH_TASK.losePushedPenalty * st.losePushed : PUSH_TASK.loseFellPenalty * st.loseFell;
    }
    if (this.options.mode === 'battle' || this.options.mode === 'push') {
      this.success = winner === 0;
      this.flags.won = winner === 0;
    } else if (this.options.mode === 'avoid') {
      this.metric = this.forbiddenTime;
      this.success = !me.out && this.forbiddenTime < AVOID_TASK.passForbiddenTime;
    } else {
      this.success = !me.out;
    }
    if (!me.out && this.time >= 60 - 1e-9) this.flags.survived60 = true;
    this.finish();
  }

  /** 2体の体が触れているか */
  private touching(): boolean {
    const other = this.fighters[1].bodyHandles();
    for (const c of this.fighters[0].colliders()) {
      let hit = false;
      this.world.contactPairsWith(c, (c2) => {
        if (hit) return;
        const parent = c2.parent();
        if (!parent || !other.has(parent.handle)) return;
        this.world.contactPair(c, c2, (manifold) => {
          if (manifold.numContacts() > 0) hit = true;
        });
      });
      if (hit) return true;
    }
    return false;
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

    // ステージを進める(脱落していないキャラの、地面に触れているすべてのブロックの位置で滞在タイマーを溜める)
    const contacts = this.fighters.map((f) => (f.out ? [] : f.groundContacts()));
    stage.update(BRAIN_DT, contacts.flat());

    // 接触の記録(2体のブロック同士が実際に触れているか)
    const touchingNow = this.fighters.length === 2 && !this.fighters[0].out && !this.fighters[1].out && this.touching();
    if (touchingNow) this.lastContact = t;

    // 報酬(0番から見た値)
    const me = this.fighters[0];
    if (!me.out && this.options.mode !== 'battle') {
      const p = me.position();
      const d = stage.dangerAt(p.x, p.z);
      if (this.options.mode === 'avoid') {
        // 触れているブロックの下のタイルのうち、いちばん悪い状態で加点・減点する
        let worst = 0;
        for (const c of contacts[0]) {
          const tile = stage.tileAt(c.x, c.z);
          if (!tile) continue;
          worst = Math.max(worst, tile.state === 'collapsed' ? 2 : tile.state === 'warning' ? 1 : 0);
        }
        if (worst === 2) {
          this.forbiddenTime += BRAIN_DT;
          this.reward -= AVOID_TASK.forbiddenPenalty * BRAIN_DT;
        } else if (worst === 1) this.reward -= AVOID_TASK.warningPenalty * BRAIN_DT;
        else this.reward += AVOID_TASK.safeBonus * BRAIN_DT;
      } else if (this.options.mode === 'survive') {
        this.reward += SURVIVE_TASK.aliveBonus * BRAIN_DT;
        if (d === 0) this.reward += SURVIVE_TASK.safeBonus * BRAIN_DT;
        else this.reward -= SURVIVE_TASK.dangerPenalty * BRAIN_DT;
      } else {
        const st = STYLES[this.options.style ?? 'balanced'];
        this.reward += PUSH_TASK.aliveBonus * st.alive * BRAIN_DT;
        if (st.danger > 0 && d !== 0) this.reward -= SURVIVE_TASK.dangerPenalty * st.danger * BRAIN_DT;
        const opp = this.fighters[1];
        if (opp && !opp.out) {
          const push = this.dangerOf(opp);
          if (t > 0) this.reward += PUSH_TASK.pushWeight * st.push * (push - this.prevPush);
          this.prevPush = push;
          // 相手を追いかける:離れているときは近づいた距離、触れている間は時間で加点
          const a = me.position();
          const b = opp.position();
          const dist = Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
          if (this.prevOpponentDist !== null && dist > PUSH_TASK.approachRange) {
            this.reward += PUSH_TASK.approachWeight * st.approach * (this.prevOpponentDist - dist);
          }
          this.prevOpponentDist = dist;
          if (touchingNow) this.reward += PUSH_TASK.contactBonus * st.contact * BRAIN_DT;
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
      const external = this.externalCommand?.(i, f) ?? null;
      if (external) f.command = external;
      else if (brain) f.command = brain.think({ self: f, opponent, stage, time: t, touching: touchingNow });
      else if (this.options.fighters[i].controller === 'rush') f.command = rushCommand(f, opponent);
      f.drive(t, footing(stage, f));
    });
  }
}
