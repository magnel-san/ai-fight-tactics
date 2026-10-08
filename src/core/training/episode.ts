// エピソード(トレーニング1回分・試合1回分)の共通部分。
// 物理を固定ステップで進め、3ステップに1回 think() を呼ぶ。観戦表示は fighters・target・stage を見て描画する。
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import { MILESTONE, PHYSICS, POSTURE, SENSOR } from '../config';
import { cos } from '../math/fmath';
import { rotate } from '../math/quat';
import type { Rapier } from '../physics/rapier';
import { applyBlockForces } from '../creature/assemble';
import { cylinderAxis, shapeOf } from '../creature/blueprint';
import type { Fighter } from '../sim/fighter';
import type { Stage } from '../stage/stage';

/** マイルストーン(仕様書セクション10)の判定に使う、エピソード中に起きたこと */
export interface EpisodeFlags {
  /** コアを起こした姿勢で一定時間保った */
  stood: boolean;
  reached: boolean;
  crossed: boolean;
  survived60: boolean;
  won: boolean;
  jumped: boolean;
}

export interface EpisodeOutcome {
  reward: number;
  /** 課題ごとの成功(目標に到達した、60秒生き残った、勝った など) */
  success: boolean;
  /** 課題ごとの指標(追跡の一致度など。なければ 0) */
  metric: number;
  time: number;
  flags: EpisodeFlags;
}

/** キャラ以外の表示物(種目のボールや壁など) */
export interface EpisodeProps {
  /** 動く球(ボール) */
  spheres: { body: RigidBody; radius: number; color: number }[];
  /** 動かない箱(壁・ゴール)。中心と半分の大きさ [m] */
  boxes: {
    x: number;
    y: number;
    z: number;
    hx: number;
    hy: number;
    hz: number;
    color: number;
    opacity?: number;
    /** 鉛直軸まわりの回転 [rad] */
    yaw?: number;
    /** 色が変わる箱(チェックポイントなど):毎フレームこの関数で色を決める */
    colorOf?: () => number;
  }[];
}

export interface Episode {
  readonly world: World;
  /** キャラ以外の表示物(省略可) */
  readonly props?: EpisodeProps;
  /** キャラごとのチーム(0 / 1)。省略時は2体ならそれぞれ別チーム */
  readonly teams?: readonly number[];
  /** カメラの注視点と距離の目安(省略時は自動) */
  readonly view?: { x: number; z: number; distance: number };
  readonly fighters: readonly Fighter[];
  /** 目標地点(移動・追跡の課題のみ) */
  readonly target: { x: number; z: number } | null;
  readonly stage: Stage | null;
  readonly done: boolean;
  readonly time: number;
  advance(): void;
  outcome(): EpisodeOutcome;
  free(): void;
}

export const BRAIN_DT = PHYSICS.dt * PHYSICS.brainInterval;

export abstract class EpisodeBase implements Episode {
  readonly world: World;
  fighters: Fighter[] = [];
  target: { x: number; z: number } | null = null;
  stage: Stage | null = null;
  protected step = 0;
  protected reward = 0;
  protected success = false;
  protected metric = 0;
  protected flags: EpisodeFlags = { stood: false, reached: false, crossed: false, survived60: false, won: false, jumped: false };
  protected finished = false;
  private standTime = 0;
  /** 姿勢の報酬を使うか(運動脳のトレーニングで true にする) */
  protected posture = false;

  constructor(R: Rapier) {
    this.world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = PHYSICS.dt;
  }

  get done(): boolean {
    return this.finished;
  }

  get time(): number {
    return this.step * PHYSICS.dt;
  }

  advance(): void {
    if (this.finished) return;
    if (this.step % PHYSICS.brainInterval === 0) {
      this.trackStanding();
      // センサーブロックが地面に触れていたら減点(トレーニング用。バトルの勝敗には関係しない)
      if (this.fighters[0] && !this.fighters[0].out && this.fighters[0].sensorTouching()) this.reward -= SENSOR.penaltyPerSec * BRAIN_DT;
      if (this.posture && this.fighters[0] && !this.fighters[0].out) this.applyPosture();
      this.think();
      if (this.finished) return;
    }
    // 浮力ブロックなど、ブロックごとの力は毎ステップかけ直す
    for (const f of this.fighters) applyBlockForces(f.creature);
    this.world.step();
    this.step++;
  }

  run(): EpisodeOutcome {
    while (!this.finished) this.advance();
    return this.outcome();
  }

  outcome(): EpisodeOutcome {
    return { reward: this.reward, success: this.success, metric: this.metric, time: this.time, flags: { ...this.flags } };
  }

  free(): void {
    this.world.free();
  }

  /** 3ステップに1回呼ばれる。指令の更新・報酬の計算・終了判定を行う */
  protected abstract think(): void;

  protected finish(): void {
    this.finished = true;
  }

  /**
   * 姿勢の報酬:コアの傾きと、前後・左右に転がる回転の速さで減点する(向きを変える回転は減点しない)。
   * コアが球なら転がって進んでよいので減点しない。コアが横向きの円柱なら、円柱の軸まわりに転がるのは減点せず、
   * 傾きは「円柱の軸が水平からずれた量」で測る
   */
  private applyPosture(): void {
    const fighter = this.fighters[0];
    const coreSpec = fighter.creature.blueprint.blocks[0];
    const shape = shapeOf(coreSpec);
    if (shape === 'sphere') return;
    const core = fighter.core;
    const q = core.rotation();
    const w = core.angvel();
    let wx = w.x;
    let wz = w.z;
    let tilt: number;
    const axis = shape === 'cylinder' ? cylinderAxis(coreSpec) : 'y';
    if (axis !== 'y') {
      // 円柱の軸(ワールド座標)。軸まわりの回転は転がりとして許す
      const a = rotate(q, axis === 'x' ? 1 : 0, 0, axis === 'z' ? 1 : 0);
      const along = w.x * a[0] + w.y * a[1] + w.z * a[2];
      wx -= along * a[0];
      wz -= along * a[2];
      // 軸が水平なら傾き0。cos θ = 軸の水平成分の長さ
      tilt = 1 - Math.sqrt(Math.max(0, 1 - a[1] * a[1]));
    } else {
      const up = rotate(q, 0, 1, 0);
      tilt = 1 - Math.max(-1, Math.min(1, up[1]));
    }
    const roll = Math.sqrt(wx * wx + wz * wz);
    // 傾き(1 − cos θ)と転がる回転の速さのうち、許容範囲を超えた分だけを 0〜1 にして減点する
    const tiltFree = 1 - cos(POSTURE.tiltFree);
    const tiltOver = Math.max(0, Math.min(1, (tilt - tiltFree) / (1 - tiltFree)));
    const rollOver = Math.max(0, Math.min(1, (roll - POSTURE.rollFree) / (POSTURE.rollScale - POSTURE.rollFree)));
    this.reward -= (POSTURE.tiltWeight * tiltOver + POSTURE.rollWeight * rollOver) * BRAIN_DT;
  }

  /** 「初めて立った」の判定:コアが上を向き、一定の高さを一定時間保ったか */
  private trackStanding(): void {
    const f = this.fighters[0];
    if (!f || this.flags.stood) return;
    const up = rotate(f.core.rotation(), 0, 1, 0);
    if (up[1] > MILESTONE.standUpright && f.position().y >= MILESTONE.standHeight) {
      this.standTime += BRAIN_DT;
      if (this.standTime >= MILESTONE.standSeconds) this.flags.stood = true;
    } else {
      this.standTime = 0;
    }
  }
}
