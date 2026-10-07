// 種目「サッカー」(3対3)。ロケットリーグ風の、角の丸い半透明の柵で囲まれた大きなフィールド(arena.ts)。
// 各キャラは自分の運動脳で動き、どこへ向かうかは役割(シューター・ブロッカー・キャリアー)で決まる。
// その役割のサッカー脳を鍛えていればサッカー脳が、なければ手書きの動き(soccerRules.ts)が決める。
// ゴールが決まったら、ボールを上空から落とし直して続ける。時間切れで得点の多い方が勝ち。
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { SoccerBrain } from '../brain/soccer';
import { SOCCER, type SoccerRole } from '../config';
import { atan2 } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { EpisodeBase, type EpisodeProps } from '../training/episode';
import { spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';
import { ballOut, buildArena, clampBallSpeed, createBall, dropBall, enemyGoalZ, goalAt } from './arena';
import { ruleCommand } from './soccerRules';

export interface SoccerResult {
  /** チーム0・チーム1の得点 */
  score: [number, number];
  /** 勝ったチーム(引き分けは null) */
  winner: number | null;
  /** ゴールの記録(時刻と、決めたチーム) */
  goals: { time: number; team: number }[];
}

/** 試合に出る選手:キャラのデータと役割 */
export interface SoccerPlayer {
  data: FighterData;
  role: SoccerRole;
}

/** 既定の役割の並び(チームの1人目・2人目・3人目) */
export const DEFAULT_ROLES: readonly SoccerRole[] = ['shooter', 'carrier', 'blocker'];

/** 役割ごとの、チーム0から見たスタート位置(-z 側が自陣) */
const SPOTS: Record<SoccerRole, { x: number; z: number }> = {
  shooter: { x: 0, z: -4 },
  carrier: { x: -4, z: -6 },
  blocker: { x: 0, z: -(SOCCER.halfLength - SOCCER.blockerLine) },
};

export class SoccerEpisode extends EpisodeBase {
  readonly ball: RigidBody;
  readonly props: EpisodeProps;
  readonly teams: number[];
  readonly roles: SoccerRole[];
  readonly view = { x: 0, z: 0, distance: 34 };
  private score: [number, number] = [0, 0];
  private goals: { time: number; team: number }[] = [];
  private brains: (SoccerBrain | null)[];

  constructor(R: Rapier, teamA: SoccerPlayer[], teamB: SoccerPlayer[], seed: number) {
    super(R);
    const rng = new Rng(seed);
    const boxes = buildArena(R, this.world);
    // ボールは中央の少し上から落とす
    this.ball = createBall(R, this.world, rng.range(-0.3, 0.3), 2, rng.range(-0.3, 0.3));

    this.teams = [];
    this.roles = [];
    this.fighters = [];
    this.brains = [];
    [teamA, teamB].forEach((team, ti) => {
      team.slice(0, SOCCER.teamSize).forEach((pl) => {
        const s = SPOTS[pl.role];
        // 同じ役割が2人いても重ならないよう、少しずらす
        const dup = team.filter((o) => o.role === pl.role).indexOf(pl);
        const x = (ti === 0 ? s.x : -s.x) + dup * 3 + rng.range(-0.2, 0.2);
        const z = ti === 0 ? s.z : -s.z;
        this.fighters.push(
          new Fighter(R, this.world, pl.data.blueprint, pl.data.motor, {
            position: { x, y: spawnHeight(pl.data.blueprint), z },
            yaw: atan2(0, ti === 0 ? 1 : -1),
          }),
        );
        this.teams.push(ti);
        this.roles.push(pl.role);
        const g = pl.data.soccer?.[pl.role];
        this.brains.push(g ? new SoccerBrain(g) : null);
      });
    });

    this.props = { spheres: [{ body: this.ball, radius: SOCCER.ballRadius, color: 0xf5f5f5 }], boxes };
  }

  /** サッカー脳で動いているか(画面の表示用) */
  usesBrain(i: number): boolean {
    return this.brains[i] !== null;
  }

  result(): SoccerResult {
    const [a, b] = this.score;
    return { score: [a, b], winner: a === b ? null : a > b ? 0 : 1, goals: [...this.goals] };
  }

  advance(): void {
    super.advance();
    clampBallSpeed(this.ball);
  }

  protected think(): void {
    const t = this.time;
    const p = this.ball.translation();
    const bv = this.ball.linvel();

    // ゴール:+z 側に入ったらチーム0の得点。決まったら上空からボールを落とし直す
    const g = goalAt(p);
    if (g !== 0) {
      const team = g > 0 ? 0 : 1;
      this.score[team]++;
      this.goals.push({ time: t, team });
      dropBall(this.ball);
    } else if (ballOut(p)) dropBall(this.ball);

    if (t >= SOCCER.timeLimit) {
      const r = this.result();
      this.success = r.winner === 0;
      this.flags.won = r.winner === 0;
      this.metric = this.score[0] - this.score[1];
      this.reward = this.metric;
      this.finish();
      return;
    }

    this.fighters.forEach((f, i) => {
      if (!f.isFinite()) return;
      const team = this.teams[i];
      const brain = this.brains[i];
      if (brain) {
        f.command = brain.think({
          self: f,
          ball: p,
          ballVel: bv,
          enemyGoalZ: enemyGoalZ(team),
          ownGoalZ: enemyGoalZ(1 - team),
          opponent: this.nearestOpponent(i),
          timeRatio: t / SOCCER.timeLimit,
          rule: ruleCommand(this.roles[i], f, team, p),
        });
      } else f.command = ruleCommand(this.roles[i], f, team, p);
      f.drive(t);
    });
  }

  private nearestOpponent(i: number): Fighter | null {
    const me = this.fighters[i].position();
    let best: Fighter | null = null;
    let bestD = Infinity;
    this.fighters.forEach((f, j) => {
      if (this.teams[j] === this.teams[i] || !f.isFinite()) return;
      const q = f.position();
      const d = (q.x - me.x) ** 2 + (q.z - me.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    });
    return best;
  }
}
