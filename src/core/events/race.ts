// 種目「かけっこ」。最大4体が別々のレーンで、まっすぐゴールへ向かって走る。
// ゴールまでのタイムを競い、届かなかったキャラは進んだ距離で順位をつける。
// 走る人どうしがぶつからないよう、レーンごとに別の物理ワールドで計算する(表示は横に並べる)。
import type { World } from '@dimforge/rapier3d-compat';
import { PHYSICS, RACE } from '../config';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { applyBlockForces } from '../creature/assemble';
import { Fighter } from '../sim/fighter';
import type { Episode, EpisodeOutcome } from '../training/episode';
import { addFlatGround, spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';

export interface RaceResult {
  /** ゴールした時刻 [s](届かなければ null) */
  finishAt: (number | null)[];
  /** スタートからゴール方向へ進んだ距離 [m] */
  distance: number[];
  /** 順位(0 = 1位)。タイムの速い順、次に進んだ距離の長い順 */
  rank: number[];
}

export class RaceEpisode implements Episode {
  readonly fighters: Fighter[];
  readonly target: { x: number; z: number };
  readonly stage = null;
  readonly view = { x: 0, z: 0, distance: 16 };
  private worlds: World[];
  private step = 0;
  private finishAt: (number | null)[];
  private startZ: number[];
  private finished = false;

  constructor(R: Rapier, runners: FighterData[], seed: number) {
    if (runners.length === 0 || runners.length > RACE.maxRunners) throw new Error(`走る人数は1〜${RACE.maxRunners}人です`);
    const rng = new Rng(seed);
    const n = runners.length;
    this.worlds = runners.map(() => {
      const w = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
      w.timestep = PHYSICS.dt;
      addFlatGround(R, w);
      return w;
    });
    // レーンを横に並べる(全体の中央が x = 0)。向きは正面(+z)をゴールに向け、少しだけばらつかせる
    this.fighters = runners.map((r, i) => {
      const x = (i - (n - 1) / 2) * RACE.laneWidth;
      return new Fighter(R, this.worlds[i], r.blueprint, r.motor, {
        position: { x, y: spawnHeight(r.blueprint), z: -RACE.distance / 2 },
        yaw: rng.range(-0.1, 0.1),
      });
    });
    this.startZ = this.fighters.map((f) => f.position().z);
    this.finishAt = runners.map(() => null);
    this.target = { x: 0, z: RACE.distance / 2 };
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

  advance(): void {
    if (this.finished) return;
    const t = this.time;
    if (this.step % PHYSICS.brainInterval === 0) {
      this.fighters.forEach((f, i) => {
        if (this.finishAt[i] !== null || !f.isFinite()) return;
        f.command = { dirX: 0, dirZ: 1, speed: 1 };
        f.drive(t);
      });
    }
    // 浮力ブロックなど、ブロックごとの力は毎ステップかけ直す
    for (const f of this.fighters) applyBlockForces(f.creature);
    for (const w of this.worlds) w.step();
    this.step++;
    this.fighters.forEach((f, i) => {
      if (this.finishAt[i] === null && f.isFinite() && f.position().z >= this.target.z) this.finishAt[i] = this.time;
    });
    if (this.time >= RACE.timeLimit || this.finishAt.every((x) => x !== null)) this.finished = true;
  }

  run(): EpisodeOutcome {
    while (!this.finished) this.advance();
    return this.outcome();
  }

  result(): RaceResult {
    const distance = this.fighters.map((f, i) => {
      const z = f.position().z;
      return Number.isFinite(z) ? Math.min(RACE.distance, z - this.startZ[i]) : 0;
    });
    const order = this.fighters
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = this.finishAt[a];
        const fb = this.finishAt[b];
        if (fa !== null && fb !== null) return fa - fb || a - b;
        if (fa !== null) return -1;
        if (fb !== null) return 1;
        return distance[b] - distance[a] || a - b;
      });
    const rank = new Array<number>(order.length);
    order.forEach((runner, r) => (rank[runner] = r));
    return { finishAt: [...this.finishAt], distance, rank };
  }

  /** トレーニング用ではないが、Episode として扱えるように1人目の結果を返す */
  outcome(): EpisodeOutcome {
    const r = this.result();
    return {
      reward: r.distance[0],
      success: r.finishAt[0] !== null,
      metric: r.distance[0],
      time: this.time,
      flags: { stood: false, reached: r.finishAt[0] !== null, crossed: false, survived60: false, won: r.rank[0] === 0, jumped: false },
    };
  }

  free(): void {
    for (const w of this.worlds) w.free();
  }
}
