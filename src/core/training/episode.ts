// エピソード(トレーニング1回分・試合1回分)の共通部分。
// 物理を固定ステップで進め、3ステップに1回 think() を呼ぶ。観戦表示は fighters・target・stage を見て描画する。
import type { World } from '@dimforge/rapier3d-compat';
import { MILESTONE, PHYSICS } from '../config';
import { rotate } from '../math/quat';
import type { Rapier } from '../physics/rapier';
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

export interface Episode {
  readonly world: World;
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
  protected flags: EpisodeFlags = { stood: false, reached: false, crossed: false, survived60: false, won: false };
  protected finished = false;
  private standTime = 0;

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
      this.think();
      if (this.finished) return;
    }
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
