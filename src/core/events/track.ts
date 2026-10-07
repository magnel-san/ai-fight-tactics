// 種目「長距離」(かけっこの発展)。楕円のトラックを決まった周回だけ走る。最大4体が同じトラックを一緒に走る(ぶつかることもある)。
// トラックにはチェックポイントがあり、順番どおりに全部通らないと周回にならない。
// 近道をしても、取っていないチェックポイントを通るまでは先に進めない(次のチェックポイントだけを数える)。
// 各キャラには「次のチェックポイントの方向へ全速力」の指令を出し、運動脳で走る。トレーニング(1周)にも使う。
import { TRACK } from '../config';
import { cos, sin, atan2 } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { EpisodeBase, type EpisodeProps } from '../training/episode';
import { addFlatGround, spawnHeight } from '../training/move';
import type { FighterData } from '../training/tasks';

/** トラック1周の長さ [m] */
export const TRACK_LENGTH = 2 * TRACK.straight + 2 * Math.PI * TRACK.radius;

/** トラックの中心線上の点と、進む向き(s はスタートラインからの道のり [m]) */
export function trackPoint(s: number): { x: number; z: number; tx: number; tz: number } {
  const S = TRACK.straight;
  const R = TRACK.radius;
  const arc = Math.PI * R;
  let d = s % TRACK_LENGTH;
  if (d < 0) d += TRACK_LENGTH;
  if (d < S) return { x: R, z: -S / 2 + d, tx: 0, tz: 1 };
  d -= S;
  if (d < arc) {
    const th = d / R;
    return { x: R * cos(th), z: S / 2 + R * sin(th), tx: -sin(th), tz: cos(th) };
  }
  d -= arc;
  if (d < S) return { x: -R, z: S / 2 - d, tx: 0, tz: -1 };
  d -= S;
  const th = Math.PI + d / R;
  return { x: R * cos(th), z: -S / 2 + R * sin(th), tx: -sin(th), tz: cos(th) };
}

/** チェックポイントの位置(1周あたり TRACK.checkpoints 個。最後の1つがスタート・ゴールのライン) */
export const CHECKPOINTS = Array.from({ length: TRACK.checkpoints }, (_, k) => trackPoint(((k + 1) * TRACK_LENGTH) / TRACK.checkpoints));

export interface TrackResult {
  /** ゴールした時刻 [s](走りきれなければ null) */
  finishAt: (number | null)[];
  /** 通ったチェックポイントの数(全部で laps × checkpoints) */
  passed: number[];
  /** 走りきった周回 */
  laps: number[];
  /** 順位(0 = 1位):ゴールの早い順、次に通ったチェックポイントの多い順、次に次のチェックポイントに近い順 */
  rank: number[];
}

const GROUND = 0x34503a;
const TRACK_COLOR = 0xb5562f;
const POLE = 0xf2f2f2;
const FINISH = 0xf2c94c;

export class TrackEpisode extends EpisodeBase {
  readonly props: EpisodeProps;
  readonly view = { x: 0, z: 0, distance: 24 };
  readonly laps: number;
  private training: boolean;
  /** 次に取るチェックポイントの番号(0〜checkpoints-1)と、通った数 */
  private next: number[];
  private passed: number[];
  private finishAt: (number | null)[];
  private prevDist: number[];

  constructor(R: Rapier, runners: FighterData[], seed: number, opts: { laps?: number; training?: boolean } = {}) {
    super(R);
    if (runners.length === 0 || runners.length > TRACK.maxRunners) throw new Error(`走る人数は1〜${TRACK.maxRunners}人です`);
    this.laps = opts.laps ?? TRACK.laps;
    this.training = !!opts.training;
    this.posture = this.training;
    const rng = new Rng(seed);
    addFlatGround(R, this.world);
    // スタートラインの少し手前に、横に並べる(正面はトラックの進む向き = +z)
    const start = trackPoint(0);
    const n = runners.length;
    this.fighters = runners.map(
      (r, i) =>
        new Fighter(R, this.world, r.blueprint, r.motor, {
          position: { x: start.x + (i - (n - 1) / 2) * 0.9, y: spawnHeight(r.blueprint), z: start.z - 1 },
          yaw: rng.range(-0.1, 0.1),
        }),
    );
    this.next = runners.map(() => 0);
    this.passed = runners.map(() => 0);
    this.finishAt = runners.map(() => null);
    this.prevDist = this.fighters.map((f) => this.distToNext(f, 0));
    this.props = { spheres: [], boxes: trackBoxes() };
  }

  private distToNext(f: Fighter, next: number): number {
    const p = f.position();
    const c = CHECKPOINTS[next];
    return Math.sqrt((p.x - c.x) ** 2 + (p.z - c.z) ** 2);
  }

  /** i 番目のキャラの、次のチェックポイントの番号(0〜) */
  nextCheckpoint(i: number): number {
    return this.next[i];
  }

  result(): TrackResult {
    const total = this.laps * TRACK.checkpoints;
    const laps = this.passed.map((p) => Math.floor(p / TRACK.checkpoints));
    const dist = this.fighters.map((f, i) => (f.isFinite() ? this.distToNext(f, this.next[i]) : Infinity));
    const order = this.fighters
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = this.finishAt[a];
        const fb = this.finishAt[b];
        if (fa !== null && fb !== null) return fa - fb || a - b;
        if (fa !== null) return -1;
        if (fb !== null) return 1;
        return this.passed[b] - this.passed[a] || dist[a] - dist[b] || a - b;
      });
    const rank = new Array<number>(order.length);
    order.forEach((r, k) => (rank[r] = k));
    return { finishAt: [...this.finishAt], passed: this.passed.map((p) => Math.min(p, total)), laps, rank };
  }

  protected think(): void {
    const t = this.time;
    const total = this.laps * TRACK.checkpoints;
    this.fighters.forEach((f, i) => {
      if (this.finishAt[i] !== null || !f.isFinite()) return;
      // 次のチェックポイントだけを数える(順番どおりでないと通ったことにならない)
      const d = this.distToNext(f, this.next[i]);
      if (this.training && i === 0) this.reward += this.prevDist[i] - d;
      if (d < TRACK.checkpointRadius) {
        this.passed[i]++;
        this.next[i] = (this.next[i] + 1) % TRACK.checkpoints;
        if (this.training && i === 0) {
          this.reward += TRACK.checkpointBonus;
          if (this.next[i] === 0) this.reward += TRACK.lapBonus;
        }
        if (this.passed[i] >= total) this.finishAt[i] = t;
      }
      this.prevDist[i] = this.distToNext(f, this.next[i]);
    });

    const limit = this.training ? TRACK.lapTimeLimit * this.laps : TRACK.timeLimit;
    const allDone = this.finishAt.every((x, i) => x !== null || !this.fighters[i].isFinite());
    if (t >= limit || allDone) {
      const mine = this.finishAt[0];
      this.metric = mine ?? limit;
      this.success = mine !== null && mine <= TRACK.passLapTime * this.laps;
      this.flags.reached = mine !== null;
      this.finish();
      return;
    }

    // 指令:次のチェックポイントの方向へ全速力
    this.fighters.forEach((f, i) => {
      if (this.finishAt[i] !== null || !f.isFinite()) {
        f.command = { dirX: 0, dirZ: 1, speed: 0 };
      } else {
        const p = f.position();
        const c = CHECKPOINTS[this.next[i]];
        f.command = { dirX: c.x - p.x, dirZ: c.z - p.z, speed: 1 };
      }
      f.drive(t);
    });
  }
}

/** トラックの見た目:地面・トラック(板を並べる)・チェックポイントの柱(スタート・ゴールは黄色) */
function trackBoxes(): EpisodeProps['boxes'] {
  const boxes: EpisodeProps['boxes'] = [];
  const W = TRACK.width;
  const S = TRACK.straight;
  const R = TRACK.radius;
  boxes.push({ x: 0, y: -0.05, z: 0, hx: R + W + 3, hy: 0.05, hz: S / 2 + R + W + 3, color: GROUND });
  // まっすぐな部分
  for (const sx of [-1, 1]) boxes.push({ x: sx * R, y: 0.006, z: 0, hx: W / 2, hy: 0.006, hz: S / 2, color: TRACK_COLOR });
  // 半円の部分:中心線に沿って板を並べる(外側ほど長くなるので、外側の長さに合わせる)
  const n = 14;
  const step = Math.PI / n;
  for (const [cz, from] of [
    [S / 2, 0],
    [-S / 2, Math.PI],
  ] as const) {
    for (let k = 0; k < n; k++) {
      const th = from + (k + 0.5) * step;
      const half = (R + W / 2) * sin(step / 2) + 0.05;
      // 板の長さの向き(ローカルの z)を、円の接線 (-sin θ, cos θ) に合わせる
      const yaw = atan2(-sin(th), cos(th));
      boxes.push({ x: R * cos(th), y: 0.006, z: cz + R * sin(th), hx: W / 2, hy: 0.006, hz: half, color: TRACK_COLOR, yaw });
    }
  }
  // チェックポイントの柱:トラックの両側に立てる
  CHECKPOINTS.forEach((c, k) => {
    const finish = k === CHECKPOINTS.length - 1;
    for (const side of [-1, 1]) {
      const nx = c.tz * side;
      const nz = -c.tx * side;
      boxes.push({ x: c.x + nx * (W / 2 + 0.15), y: 0.6, z: c.z + nz * (W / 2 + 0.15), hx: 0.07, hy: 0.6, hz: 0.07, color: finish ? FINISH : POLE });
    }
    // 地面の線
    const yaw = atan2(c.tz, -c.tx);
    boxes.push({ x: c.x, y: 0.014, z: c.z, hx: W / 2, hy: 0.004, hz: 0.06, color: finish ? FINISH : POLE, opacity: 0.8, yaw });
  });
  return boxes;
}
