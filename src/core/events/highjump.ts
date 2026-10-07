// 種目「ジャンプ」。最大4体が別々のレーンで、決まった間隔のジャンプ指令に合わせて跳び、
// コアがどれだけ高く上がったか(跳ぶ前の高さからの上がり幅)の最高記録を競う。
// 跳ぶ人どうしがぶつからないよう、レーンごとに別の物理ワールドで計算する(表示は横に並べる)。
import type { World } from '@dimforge/rapier3d-compat';
import { HIGH_JUMP, PHYSICS } from '../config';
import { applyBlockForces } from '../creature/assemble';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { BRAIN_DT, type Episode, type EpisodeOutcome } from '../training/episode';
import { addFlatGround, spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';

export interface HighJumpResult {
  /** ジャンプごとの上がり幅 [m](レーンごと) */
  heights: number[][];
  /** いちばん高かった記録 [m] */
  best: number[];
  /** 順位(0 = 1位)。最高記録の高い順 */
  rank: number[];
}

/** ジャンプ指令を出し続ける時間 [s](運動脳がジャンプ指令に反応できるよう、少しの間だけ出す) */
const PULSE = 0.3;
/** 跳ぶ前の高さを測る時間 [s] */
const BASELINE = 0.5;

export class HighJumpEpisode implements Episode {
  readonly fighters: Fighter[];
  readonly stage = null;
  readonly target = null;
  readonly view = { x: 0, z: 0, distance: 12 };
  private worlds: World[];
  private step = 0;
  private finished = false;
  private heights: number[][];
  /** 測定中のジャンプ(レーンごと):跳ぶ前の高さと、最高到達点 */
  private current: ({ base: number; top: number } | null)[];
  private recent: number[][];
  private attempt = 0;
  private nextAt: number = HIGH_JUMP.firstAt;
  private jumpAt = -Infinity;
  private readonly endAt = HIGH_JUMP.firstAt + HIGH_JUMP.attempts * HIGH_JUMP.interval;

  constructor(R: Rapier, jumpers: FighterData[], seed: number) {
    if (jumpers.length === 0 || jumpers.length > HIGH_JUMP.maxJumpers) throw new Error(`跳ぶ人数は1〜${HIGH_JUMP.maxJumpers}人です`);
    const rng = new Rng(seed);
    const n = jumpers.length;
    this.worlds = jumpers.map(() => {
      const w = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
      w.timestep = PHYSICS.dt;
      addFlatGround(R, w);
      return w;
    });
    this.fighters = jumpers.map((j, i) => {
      const x = (i - (n - 1) / 2) * HIGH_JUMP.laneWidth;
      return new Fighter(R, this.worlds[i], j.blueprint, j.motor, { position: { x, y: spawnHeight(j.blueprint), z: 0 }, yaw: rng.range(-0.1, 0.1) });
    });
    this.heights = jumpers.map(() => []);
    this.current = jumpers.map(() => null);
    this.recent = jumpers.map(() => []);
  }

  get world(): World {
    return this.worlds[0];
  }

  get done(): boolean {
    return this.finished;
  }

  get time(): number {
    return this.step * PHYSICS.dt;
  }

  /** いまのジャンプの回数(1〜attempts。始まる前は0) */
  get attemptNumber(): number {
    return this.attempt;
  }

  advance(): void {
    if (this.finished) return;
    const t = this.time;
    if (this.step % PHYSICS.brainInterval === 0) {
      // ジャンプ指令:決まった時刻に、全員に同時に出す
      if (this.attempt < HIGH_JUMP.attempts && t >= this.nextAt) {
        this.attempt++;
        this.nextAt += HIGH_JUMP.interval;
        this.jumpAt = t;
        this.fighters.forEach((f, i) => {
          const r = this.recent[i];
          const y = f.position().y;
          const base = r.length ? r.reduce((s, v) => s + v, 0) / r.length : y;
          this.current[i] = { base, top: y };
        });
      }
      this.fighters.forEach((f, i) => {
        if (!f.isFinite()) return;
        const y = f.position().y;
        const c = this.current[i];
        if (c) {
          c.top = Math.max(c.top, y);
          if (t - this.jumpAt >= HIGH_JUMP.window) {
            this.heights[i].push(Math.max(0, c.top - c.base));
            this.current[i] = null;
            this.recent[i] = [];
          }
        } else {
          this.recent[i].push(y);
          if (this.recent[i].length > Math.round(BASELINE / BRAIN_DT)) this.recent[i].shift();
        }
        const h = f.heading();
        f.command = { dirX: h.fx, dirZ: h.fz, speed: 0, jump: t - this.jumpAt < PULSE ? 1 : 0 };
        f.drive(t);
      });
      if (t >= this.endAt) {
        this.finished = true;
        return;
      }
    }
    for (const f of this.fighters) applyBlockForces(f.creature);
    for (const w of this.worlds) w.step();
    this.step++;
  }

  run(): EpisodeOutcome {
    while (!this.finished) this.advance();
    return this.outcome();
  }

  result(): HighJumpResult {
    const best = this.heights.map((hs) => (hs.length ? Math.max(...hs) : 0));
    const order = best.map((_, i) => i).sort((a, b) => best[b] - best[a] || a - b);
    const rank = new Array<number>(order.length);
    order.forEach((j, r) => (rank[j] = r));
    return { heights: this.heights.map((h) => [...h]), best, rank };
  }

  outcome(): EpisodeOutcome {
    const r = this.result();
    return {
      reward: r.best[0],
      success: r.best[0] > 0,
      metric: r.best[0],
      time: this.time,
      flags: { stood: false, reached: false, crossed: false, survived60: false, won: r.rank[0] === 0, jumped: r.best[0] > 0 },
    };
  }

  free(): void {
    for (const w of this.worlds) w.free();
  }
}

/** ジャンプの公式記録:決まったシードで1体ずつ跳ばせ、いちばん高かった記録 [m] */
export function jumpRecord(R: Rapier, f: FighterData): number {
  let best = 0;
  for (const seed of HIGH_JUMP.seeds) {
    const ep = new HighJumpEpisode(R, [f], seed);
    ep.run();
    best = Math.max(best, ep.result().best[0]);
    ep.free();
  }
  return best;
}
