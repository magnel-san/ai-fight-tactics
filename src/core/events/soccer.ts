// 種目「サッカー」(3対3)。壁で囲まれた平らなフィールドで、ボールを相手のゴールへ押し込む。
// 各キャラは自分の運動脳で動き、どこへ向かうかはチームのルール(手書きのAI)が決める:
//   ボールにいちばん近い1体がボールの後ろへ回り込んでゴールへ押し込み、1体が自陣のゴール前で守り、もう1体は横で支える。
// ゴールが決まったらボールだけ中央に戻して続ける。時間切れで得点の多い方が勝ち。
import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { MotorCommand } from '../brain/motor';
import { SOCCER } from '../config';
import { atan2 } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { EpisodeBase, type EpisodeProps } from '../training/episode';
import { spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';

export interface SoccerResult {
  /** チーム0・チーム1の得点 */
  score: [number, number];
  /** 勝ったチーム(引き分けは null) */
  winner: number | null;
  /** ゴールの記録(時刻と、決めたチーム) */
  goals: { time: number; team: number }[];
}

const FIELD = 0x3f6b46;
const WALL = 0x9aa5b1;
const GOAL = [0x56ccf2, 0xff8a3d];

/** 水平距離(Math.hypot は環境によって結果がずれる可能性があるので使わない) */
function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export class SoccerEpisode extends EpisodeBase {
  readonly ball: RigidBody;
  readonly props: EpisodeProps;
  readonly teams: number[];
  readonly view = { x: 0, z: 0, distance: 18 };
  private score: [number, number] = [0, 0];
  private goals: { time: number; team: number }[] = [];

  constructor(R: Rapier, teamA: FighterData[], teamB: FighterData[], seed: number) {
    super(R);
    const rng = new Rng(seed);
    const { halfWidth: W, halfLength: L, goalWidth: G, wallHeight: H, wallThickness: T } = SOCCER;

    // フィールドと壁(ゴールの部分は壁をあけ、奥に箱を置いてボールを受け止める)
    const boxes: EpisodeProps['boxes'] = [];
    const fixed = (x: number, y: number, z: number, hx: number, hy: number, hz: number, color: number, opacity?: number) => {
      this.world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(0.8));
      boxes.push({ x, y, z, hx, hy, hz, color, opacity });
    };
    fixed(0, -0.1, 0, W + 2, 0.1, L + 2, FIELD);
    fixed(-W - T / 2, H / 2, 0, T / 2, H / 2, L + T, WALL);
    fixed(W + T / 2, H / 2, 0, T / 2, H / 2, L + T, WALL);
    const side = (W - G / 2) / 2;
    for (const sz of [-1, 1]) {
      fixed(-(G / 2 + side), H / 2, sz * (L + T / 2), side, H / 2, T / 2, WALL);
      fixed(G / 2 + side, H / 2, sz * (L + T / 2), side, H / 2, T / 2, WALL);
      // ゴールの奥(ネット)
      fixed(0, H / 2, sz * (L + 1.2), G / 2 + T, H / 2, T / 2, GOAL[sz < 0 ? 0 : 1], 0.5);
      fixed(-(G / 2 + T / 2), H / 2, sz * (L + 0.6), T / 2, H / 2, 0.6, GOAL[sz < 0 ? 0 : 1], 0.5);
      fixed(G / 2 + T / 2, H / 2, sz * (L + 0.6), T / 2, H / 2, 0.6, GOAL[sz < 0 ? 0 : 1], 0.5);
    }

    // ボール
    this.ball = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, SOCCER.ballRadius + 0.2, 0).setLinearDamping(SOCCER.ballDamping).setAngularDamping(SOCCER.ballDamping).setCanSleep(false),
    );
    this.world.createCollider(
      R.ColliderDesc.ball(SOCCER.ballRadius).setMass(SOCCER.ballMass).setRestitution(SOCCER.ballRestitution).setFriction(SOCCER.ballFriction),
      this.ball,
    );

    // 選手:チーム0は手前(-z)、チーム1は奥(+z)。相手のゴールの方を向く
    const spots = [
      { x: 0, z: 2.5 },
      { x: -2.5, z: 5 },
      { x: 2.5, z: 5 },
    ];
    this.teams = [];
    this.fighters = [];
    [teamA, teamB].forEach((team, ti) => {
      team.slice(0, SOCCER.teamSize).forEach((d, i) => {
        const s = spots[i];
        const z = ti === 0 ? -s.z : s.z;
        const x = (ti === 0 ? s.x : -s.x) + rng.range(-0.2, 0.2);
        this.fighters.push(
          new Fighter(R, this.world, d.blueprint, d.motor, { position: { x, y: spawnHeight(d.blueprint), z }, yaw: atan2(0, ti === 0 ? 1 : -1) }),
        );
        this.teams.push(ti);
      });
    });

    this.props = { spheres: [{ body: this.ball, radius: SOCCER.ballRadius, color: 0xf5f5f5 }], boxes };
  }

  result(): SoccerResult {
    const [a, b] = this.score;
    return { score: [a, b], winner: a === b ? null : a > b ? 0 : 1, goals: [...this.goals] };
  }

  protected think(): void {
    const t = this.time;
    const p = this.ball.translation();

    // ゴール判定:ボールがゴールの線を越えた
    if (Math.abs(p.x) < SOCCER.goalWidth / 2 && Math.abs(p.z) > SOCCER.halfLength + SOCCER.ballRadius) {
      const team = p.z > 0 ? 0 : 1; // +z 側のゴールに入ったらチーム0の得点
      this.score[team]++;
      this.goals.push({ time: t, team });
      this.ball.setTranslation({ x: 0, y: SOCCER.ballRadius + 0.2, z: 0 }, true);
      this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    // フィールドの外へ飛び出したボールも中央に戻す
    if (!Number.isFinite(p.x) || p.y < -2 || Math.abs(p.x) > SOCCER.halfWidth + 2 || Math.abs(p.z) > SOCCER.halfLength + 3) {
      this.ball.setTranslation({ x: 0, y: SOCCER.ballRadius + 0.2, z: 0 }, true);
      this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }

    if (t >= SOCCER.timeLimit) {
      const r = this.result();
      this.success = r.winner === 0;
      this.flags.won = r.winner === 0;
      this.metric = this.score[0] - this.score[1];
      this.reward = this.metric;
      this.finish();
      return;
    }

    // チームごとに、ボールにいちばん近い選手を「攻め」、ゴールにいちばん近い残りを「守り」、残りを「支え」にする
    for (const team of [0, 1]) {
      const members = this.fighters.map((f, i) => ({ f, i })).filter((m) => this.teams[m.i] === team && m.f.isFinite());
      if (members.length === 0) continue;
      const dist = (f: Fighter, x: number, z: number) => {
        const q = f.position();
        return len(q.x - x, q.z - z);
      };
      const ownGoalZ = team === 0 ? -SOCCER.halfLength : SOCCER.halfLength;
      const attacker = members.reduce((a, b) => (dist(b.f, p.x, p.z) < dist(a.f, p.x, p.z) ? b : a));
      const rest = members.filter((m) => m !== attacker);
      const defender = rest.length ? rest.reduce((a, b) => (dist(b.f, 0, ownGoalZ) < dist(a.f, 0, ownGoalZ) ? b : a)) : null;
      for (const m of members) {
        const role = m === attacker ? 'attack' : m === defender ? 'defend' : 'support';
        m.f.command = this.command(m.f, team, role, p);
        m.f.drive(t);
      }
    }
  }

  /** 役割ごとの指令(ワールドの水平方向と速さ) */
  private command(f: Fighter, team: number, role: 'attack' | 'defend' | 'support', ball: { x: number; z: number }): MotorCommand {
    const me = f.position();
    const goalZ = team === 0 ? SOCCER.halfLength : -SOCCER.halfLength;
    const ownGoalZ = -goalZ;
    const to = (x: number, z: number): MotorCommand => ({ dirX: x - me.x, dirZ: z - me.z, speed: 1 });
    if (role === 'attack') {
      // ボールから見て相手のゴールの反対側(ボールの後ろ)に回り込み、近づいたらゴールの方へ押す
      const gx = 0 - ball.x;
      const gz = goalZ - ball.z;
      const gl = len(gx, gz) || 1;
      const bx = ball.x - (gx / gl) * SOCCER.approachOffset;
      const bz = ball.z - (gz / gl) * SOCCER.approachOffset;
      if (len(me.x - bx, me.z - bz) < SOCCER.pushStartDist) return { dirX: gx, dirZ: gz, speed: 1 };
      return to(bx, bz);
    }
    if (role === 'defend') {
      return to(ball.x * SOCCER.defendRatio, ownGoalZ + (ball.z - ownGoalZ) * SOCCER.defendRatio);
    }
    // 支え:ボールの横、少し相手のゴール寄り
    const sideX = ball.x > 0 ? ball.x - 2.5 : ball.x + 2.5;
    return to(Math.max(-SOCCER.halfWidth + 1, Math.min(SOCCER.halfWidth - 1, sideX)), ball.z + Math.sign(goalZ) * 1.5);
  }
}

