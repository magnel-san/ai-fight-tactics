// サッカーのフィールド(ロケットリーグ風)。種目のサッカーと、サッカーのトレーニングで共通に使う。
//   ・角の丸い柵:まっすぐな柵と、角は円弧に沿って並べた板(cornerSegments 枚)で囲む。表示は半透明
//   ・ゴール:両端の柵の真ん中に、幅 goalWidth・高さ goalHeight の口をあけ、奥に箱(後ろ・横・屋根)を置く
//   ・ボール:少し低重力で、速さに上限がある。ゴールしたら上空から落ちてくる
// チーム0は -z 側のゴールを守り、+z 側のゴールを狙う(チーム1は逆)。
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import { SOCCER } from '../config';
import { atan2, cos, sin } from '../math/fmath';
import type { Rapier } from '../physics/rapier';
import type { EpisodeProps } from '../training/episode';

const FIELD = 0x3f6b46;
const LINE = 0xe8f1e8;
const WALL = 0xbfd7ff;
export const GOAL_COLORS = [0x56ccf2, 0xff8a3d];

type Box = EpisodeProps['boxes'][number];

/** フィールド・柵・ゴールの当たり判定を作り、表示用の箱を返す */
export function buildArena(R: Rapier, world: World): Box[] {
  const { halfWidth: W, halfLength: L, cornerRadius: C, goalWidth: G, goalHeight: GH, goalDepth: D, wallHeight: H, wallThickness: T } = SOCCER;
  const boxes: Box[] = [];
  /** 動かない箱。yaw は鉛直軸まわりの回転 [rad]。collide = false なら表示だけ(線など) */
  const fixed = (x: number, y: number, z: number, hx: number, hy: number, hz: number, color: number, opacity?: number, yaw = 0, collide = true) => {
    if (collide) {
      world.createCollider(
        R.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setRotation({ x: 0, y: sin(yaw / 2), z: 0, w: cos(yaw / 2) })
          .setFriction(0.8)
          .setRestitution(0.3),
      );
    }
    boxes.push({ x, y, z, hx, hy, hz, color, opacity, yaw });
  };

  // 床(ゴールの中まで続ける)
  fixed(0, -0.1, 0, W + T, 0.1, L + D + T, FIELD);
  // 線(表示だけ):中央の線とセンターサークルの代わりの四角、ゴールの前の線
  fixed(0, 0.005, 0, W - 0.2, 0.004, 0.06, LINE, 0.6, 0, false);
  for (const sz of [-1, 1]) fixed(0, 0.005, sz * (L - 3), G / 2 + 1, 0.004, 0.06, LINE, 0.6, 0, false);

  // まっすぐな柵:左右(x = ±W)と、両端(z = ±L)のゴールの口の左右
  for (const sx of [-1, 1]) fixed(sx * (W + T / 2), H / 2, 0, T / 2, H / 2, L - C, WALL, SOCCER.wallOpacity);
  const endHalf = (W - C - G / 2) / 2;
  for (const sz of [-1, 1]) {
    const z = sz * (L + T / 2);
    for (const sx of [-1, 1]) fixed(sx * (G / 2 + endHalf), H / 2, z, endHalf, H / 2, T / 2, WALL, SOCCER.wallOpacity);
    // ゴールの口の上(クロスバーから柵の高さまで)
    fixed(0, (GH + H) / 2, z, G / 2, (H - GH) / 2, T / 2, WALL, SOCCER.wallOpacity);
  }

  // 角:円弧に沿って板を並べる(角の中心から半径 C の外側)
  const corners = [
    { cx: W - C, cz: L - C, from: 0 },
    { cx: -(W - C), cz: L - C, from: Math.PI / 2 },
    { cx: -(W - C), cz: -(L - C), from: Math.PI },
    { cx: W - C, cz: -(L - C), from: (3 * Math.PI) / 2 },
  ];
  const n = SOCCER.cornerSegments;
  const step = Math.PI / 2 / n;
  // 板の長さは、となりの板とすき間ができないよう少し長めにする
  const half = (C + T) * sin(step / 2) + 0.05;
  for (const c of corners) {
    for (let k = 0; k < n; k++) {
      const phi = c.from + (k + 0.5) * step;
      const r = C + T / 2;
      const x = c.cx + r * cos(phi);
      const z = c.cz + r * sin(phi);
      // 板の長さの向き(ローカルの x)を、円の接線 (-sin φ, cos φ) に合わせる
      const yaw = atan2(-cos(phi), -sin(phi));
      fixed(x, H / 2, z, half, H / 2, T / 2, WALL, SOCCER.wallOpacity, yaw);
    }
  }

  // ゴールの箱(後ろ・左右・屋根)。チーム0のゴールは -z 側
  for (const sz of [-1, 1]) {
    const color = GOAL_COLORS[sz < 0 ? 0 : 1];
    fixed(0, GH / 2, sz * (L + T + D + T / 2), G / 2 + T, GH / 2, T / 2, color, 0.35);
    for (const sx of [-1, 1]) fixed(sx * (G / 2 + T / 2), GH / 2, sz * (L + T + D / 2), T / 2, GH / 2, D / 2 + T / 2, color, 0.35);
    fixed(0, GH + T / 2, sz * (L + T + D / 2), G / 2 + T, T / 2, D / 2 + T, color, 0.25);
  }
  return boxes;
}

/** ボールを作る(少し低重力。眠らせない) */
export function createBall(R: Rapier, world: World, x: number, y: number, z: number): RigidBody {
  const ball = world.createRigidBody(
    R.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setGravityScale(SOCCER.ballGravityScale)
      .setLinearDamping(SOCCER.ballDamping)
      .setAngularDamping(SOCCER.ballDamping)
      .setCanSleep(false),
  );
  world.createCollider(
    R.ColliderDesc.ball(SOCCER.ballRadius).setMass(SOCCER.ballMass).setRestitution(SOCCER.ballRestitution).setFriction(SOCCER.ballFriction),
    ball,
  );
  return ball;
}

/** ボールの速さを上限までにおさえる(物理ステップのあとに毎回呼ぶ) */
export function clampBallSpeed(ball: RigidBody): void {
  const v = ball.linvel();
  const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (s > SOCCER.ballMaxSpeed) {
    const k = SOCCER.ballMaxSpeed / s;
    ball.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
  }
}

/** ボールをフィールドの真ん中の上空から落とし直す */
export function dropBall(ball: RigidBody, x = 0, z = 0): void {
  ball.setTranslation({ x, y: SOCCER.ballDropHeight, z }, true);
  ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
}

/** ボールがゴールに入ったか:+1 = +z 側のゴール(チーム0の得点)、-1 = -z 側のゴール(チーム1の得点)、0 = 入っていない */
export function goalAt(p: { x: number; y: number; z: number }): -1 | 0 | 1 {
  if (Math.abs(p.x) < SOCCER.goalWidth / 2 && p.y < SOCCER.goalHeight && Math.abs(p.z) > SOCCER.halfLength + SOCCER.wallThickness + SOCCER.ballRadius) {
    return p.z > 0 ? 1 : -1;
  }
  return 0;
}

/** ボールがフィールドの外に出てしまったか(柵を越えた・落ちた・計算が壊れた) */
export function ballOut(p: { x: number; y: number; z: number }): boolean {
  return (
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    !Number.isFinite(p.z) ||
    p.y < -2 ||
    Math.abs(p.x) > SOCCER.halfWidth + 2 ||
    Math.abs(p.z) > SOCCER.halfLength + SOCCER.goalDepth + 3
  );
}

/** チームが攻めるゴールの z(チーム0は +z、チーム1は -z) */
export function enemyGoalZ(team: number): number {
  return team === 0 ? SOCCER.halfLength : -SOCCER.halfLength;
}
