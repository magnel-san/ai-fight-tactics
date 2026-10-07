// サッカーのトレーニング(役割ごとの練習)。サッカー脳を鍛える(運動脳はそのまま使う)。
//   シューター:ボールを取りに行き、相手のブロッカー(自分と同じ体のBOT。お手本の動き)が守るゴールにシュートを決める
//   ブロッカー:自分のゴールの前で待ち、相手陣から飛んでくるシュートを止める。ボールが遠いときはゴール前に戻る
//   キャリアー:ボールを拾い、追いかけてくるBOTに取られないように、前へ運ぶ(ドリブル)
// フィールドは種目のサッカーと同じ(arena.ts)。鍛えるキャラはチーム0で、+z 側のゴールを攻める。
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { SoccerBrain } from '../brain/soccer';
import { SOCCER, SOCCER_DRILL, type SoccerRole } from '../config';
import { atan2, log } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { ballOut, buildArena, clampBallSpeed, createBall, dropBall, goalAt } from '../events/arena';
import { ruleCommand } from '../events/soccerRules';
import { BRAIN_DT, EpisodeBase, type EpisodeProps } from './episode';
import { spawnHeight } from './move';
import type { Blueprint } from '../creature/blueprint';

/** 役割の名前と説明(画面に出す) */
export const SOCCER_ROLE_LIST: { role: SoccerRole; label: string; note: string }[] = [
  { role: 'shooter', label: 'シューター', note: 'ボールを取りに行き、相手のゴールにシュートする' },
  { role: 'carrier', label: 'キャリアー', note: 'ボールを拾い、取られないようにドリブルで前へ運ぶ' },
  { role: 'blocker', label: 'ブロッカー', note: '自分のゴールの前で待ち、飛んでくるボールを止めて、ゴール前に戻る' },
];

function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export class SoccerDrillEpisode extends EpisodeBase {
  readonly ball: RigidBody;
  readonly props: EpisodeProps;
  readonly teams: number[];
  readonly view = { x: 0, z: -3, distance: 30 };
  private brain: SoccerBrain;
  private trainee: Fighter;
  private bot: Fighter | null;
  private rng: Rng;
  private prevBallDist: number | null = null;
  private prevGoalDist: number | null = null;
  private prevBallZ: number | null = null;
  /** ブロッカー:次のシュートの時刻・打ったシュートの数・決められた数・止めた数 */
  private nextShotAt = 1;
  private shotsFired = 0;
  private conceded = 0;
  private blocked = 0;
  private shotOpen = false;
  /** キャリアー:ボールを持って前へ運んだ距離 [m] */
  private carried = 0;

  constructor(
    R: Rapier,
    readonly role: SoccerRole,
    body: { blueprint: Blueprint; motor: Float64Array },
    genome: Float64Array,
    seed: number,
  ) {
    super(R);
    this.rng = new Rng(seed);
    const rng = this.rng;
    const boxes = buildArena(R, this.world);
    const L = SOCCER.halfLength;
    const spawn = (x: number, z: number, faceZ: number) =>
      new Fighter(R, this.world, body.blueprint, body.motor, { position: { x, y: spawnHeight(body.blueprint), z }, yaw: atan2(0, faceZ) });

    if (role === 'shooter') {
      const x = rng.range(-3, 3);
      const z = L - SOCCER_DRILL.shooterStart;
      this.trainee = spawn(x, z, 1);
      this.ball = createBall(R, this.world, x + rng.range(-1.5, 1.5), 1, z + SOCCER_DRILL.ballAhead + rng.range(-0.5, 0.5));
      // 相手のブロッカー(+z 側のゴールの前)
      this.bot = spawn(0, L - SOCCER.blockerLine, -1);
    } else if (role === 'blocker') {
      this.trainee = spawn(rng.range(-1, 1), -(L - SOCCER.blockerLine), 1);
      // ボールは最初のシュートまで相手陣に置いておく
      this.ball = createBall(R, this.world, 0, 1, 6);
      this.bot = null;
    } else {
      const x = rng.range(-3, 3);
      this.trainee = spawn(x, -8, 1);
      this.ball = createBall(R, this.world, x + rng.range(-1, 1), 1, -8 + SOCCER_DRILL.ballAhead);
      // 追いかけてくるBOT(前から)
      this.bot = spawn(rng.range(-2, 2), -8 + SOCCER_DRILL.chaserDistance, -1);
    }
    this.fighters = this.bot ? [this.trainee, this.bot] : [this.trainee];
    this.teams = this.bot ? [0, 1] : [0];
    this.brain = new SoccerBrain(genome);
    this.props = { spheres: [{ body: this.ball, radius: SOCCER.ballRadius, color: 0xf5f5f5 }], boxes };
  }

  advance(): void {
    super.advance();
    clampBallSpeed(this.ball);
  }

  /**
   * ブロッカー:自分のゴールへ向けてシュートを打つ。ボールは転がりで少しずつ遅くなるので、それを見込んで速さと上向きの速さを決める
   * (遅くなりかたを見込まないと、ほとんど届かずにゴールの手前で止まってしまう)
   */
  private shoot(): void {
    const rng = this.rng;
    const L = SOCCER.halfLength;
    const x = rng.range(-5, 5);
    const z = rng.range(-L + 7, -L + 10);
    const y = 1.2;
    const tx = rng.range(-SOCCER.goalWidth * 0.4, SOCCER.goalWidth * 0.4);
    const tz = -L - SOCCER.wallThickness - 1;
    const speed = rng.range(SOCCER_DRILL.shotSpeedMin, SOCCER_DRILL.shotSpeedMax);
    const dx = tx - x;
    const dz = tz - z;
    const d = len(dx, dz);
    // 速さが e^(-c t) で落ちるときに、距離 d を進むまでの時間
    const c = SOCCER.ballDamping;
    const flight = d * c < speed * 0.95 ? -log(1 - (d * c) / speed) / c : (2 * d) / speed;
    const g = 9.81 * SOCCER.ballGravityScale;
    const vy = (1.2 - y) / flight + 0.5 * g * flight;
    this.ball.setTranslation({ x, y, z }, true);
    this.ball.setLinvel({ x: (dx / d) * speed, y: vy, z: (dz / d) * speed }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.shotsFired++;
    this.shotOpen = true;
  }

  protected think(): void {
    const t = this.time;
    const p = this.ball.translation();
    const bv = this.ball.linvel();
    const me = this.trainee.position();
    const ballDist = len(p.x - me.x, p.z - me.z);
    const g = goalAt(p);

    if (this.role === 'shooter') {
      if (g > 0) {
        this.reward += SOCCER_DRILL.goalBonus;
        this.success = true;
        this.metric = 1;
        this.finish();
        return;
      }
      if (g < 0) {
        this.reward -= SOCCER_DRILL.ownGoalPenalty;
        this.finish();
        return;
      }
      if (ballOut(p)) dropBall(this.ball);
      // ボールに近づく・ボールを相手のゴールへ近づける
      const goalDist = len(p.x, SOCCER.halfLength - p.z);
      if (this.prevBallDist !== null && ballDist > 1.5) this.reward += SOCCER_DRILL.approachWeight * (this.prevBallDist - ballDist);
      if (this.prevGoalDist !== null) this.reward += SOCCER_DRILL.ballProgressWeight * (this.prevGoalDist - goalDist);
      this.prevGoalDist = goalDist;
    } else if (this.role === 'blocker') {
      if (g < 0) {
        this.reward -= SOCCER_DRILL.concedePenalty;
        this.conceded++;
        this.shotOpen = false;
        dropBall(this.ball, 0, 6);
      } else if (g > 0 || ballOut(p)) dropBall(this.ball, 0, 6);
      // 次のシュートの時刻になったら、前のシュートは止めたことにする
      if (t >= this.nextShotAt && this.shotsFired < SOCCER_DRILL.shots) {
        if (this.shotOpen) {
          this.reward += SOCCER_DRILL.blockBonus;
          this.blocked++;
        }
        this.shoot();
        this.nextShotAt += SOCCER_DRILL.shotInterval;
      }
      // ボールが遠いときはゴール前に戻る。ボールが自陣の近くにあるときは、ボールに触れると加点
      const homeZ = -(SOCCER.halfLength - SOCCER.blockerLine);
      if (p.z > -SOCCER.halfLength + SOCCER.blockerReach) this.reward -= (SOCCER_DRILL.homeWeight * len(me.x, me.z - homeZ) * BRAIN_DT) / 5;
      else if (ballDist < 1.5) this.reward += SOCCER_DRILL.touchBonus * BRAIN_DT;
    } else {
      if (g > 0) {
        this.reward += SOCCER_DRILL.goalBonus / 2;
        this.success = true;
        this.metric = this.carried;
        this.finish();
        return;
      }
      if (ballOut(p) || g < 0) dropBall(this.ball, me.x, me.z + 2);
      // ボールを持っている(近くにある)間は加点し、前へ運んだ距離でさらに加点する
      if (ballDist < SOCCER_DRILL.dribbleRadius) {
        this.reward += SOCCER_DRILL.closeBonus * BRAIN_DT;
        if (this.prevBallZ !== null) {
          const dz = Math.max(0, p.z - this.prevBallZ);
          this.reward += SOCCER_DRILL.carryWeight * dz;
          this.carried += dz;
        }
      } else {
        this.reward -= SOCCER_DRILL.farPenalty * BRAIN_DT;
        if (this.prevBallDist !== null) this.reward += SOCCER_DRILL.approachWeight * (this.prevBallDist - ballDist);
      }
      this.prevBallZ = p.z;
      if (this.carried >= SOCCER_DRILL.carryGoal) {
        this.reward += 5;
        this.success = true;
        this.metric = this.carried;
        this.finish();
        return;
      }
    }
    this.prevBallDist = ballDist;

    if (t >= SOCCER_DRILL.time) {
      if (this.role === 'blocker') {
        if (this.shotOpen) {
          this.reward += SOCCER_DRILL.blockBonus;
          this.blocked++;
        }
        this.success = this.conceded <= SOCCER_DRILL.allowedGoals;
        this.metric = this.blocked;
      } else if (this.role === 'carrier') this.metric = this.carried;
      this.finish();
      return;
    }

    // 鍛えているキャラはサッカー脳、BOTはお手本の動き
    if (this.trainee.isFinite()) {
      this.trainee.command = this.brain.think({
        self: this.trainee,
        ball: p,
        ballVel: bv,
        enemyGoalZ: SOCCER.halfLength,
        ownGoalZ: -SOCCER.halfLength,
        opponent: this.bot,
        timeRatio: t / SOCCER_DRILL.time,
        rule: ruleCommand(this.role, this.trainee, 0, p),
      });
      this.trainee.drive(t);
    }
    if (this.bot && this.bot.isFinite()) {
      const b = this.bot.position();
      this.bot.command =
        this.role === 'shooter'
          ? ruleCommand('blocker', this.bot, 1, p)
          : { dirX: p.x - b.x, dirZ: p.z - b.z, speed: SOCCER_DRILL.chaserSpeed };
      this.bot.drive(t);
    }
  }
}
