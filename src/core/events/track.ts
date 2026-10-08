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
const INFIELD = 0x3f6b46;
const TRACK_COLOR = 0xb5562f;
const WHITE = 0xf2f2f2;
const BLACK = 0x222222;
const FINISH = 0xf2c94c;
/** チェックポイントの色:自分が通ったもの・次に通るもの */
const PASSED = 0x4cd07d;
const NEXT = 0xff8c42;

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
    this.props = { spheres: [], boxes: trackBoxes(this) };
  }

  private distToNext(f: Fighter, next: number): number {
    const p = f.position();
    const c = CHECKPOINTS[next];
    return Math.sqrt((p.x - c.x) ** 2 + (p.z - c.z) ** 2);
  }

  /** 自分(1人目)から見た、チェックポイント k の状態(この周で通った・次に通る・まだ)。ゴールしたら全部「通った」 */
  checkpointState(k: number): 'passed' | 'next' | 'todo' {
    if (this.finishAt[0] !== null) return 'passed';
    const next = this.next[0];
    return k === next ? 'next' : k < next ? 'passed' : 'todo';
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

/** ランキングの長距離の公式記録:ゴールのタイム、ゴールできなければ通ったチェックポイントの数 */
export interface TrackRecord {
  time: number | null;
  passed: number;
}

/** 長距離の公式記録:決まったシードで1体だけ3周を走らせる */
export function trackRecord(R: Rapier, f: FighterData): TrackRecord {
  const ep = new TrackEpisode(R, [f], TRACK.recordSeed);
  ep.run();
  const r = ep.result();
  ep.free();
  return { time: r.finishAt[0], passed: r.passed[0] };
}

/** 長距離の記録の並べ方(小さいほど上):ゴールしたらタイム、しなければ制限時間+残りのチェックポイント数 */
export function trackRecordKey(r: TrackRecord): number {
  return r.time !== null ? r.time : TRACK.timeLimit + (TRACK.laps * TRACK.checkpoints - r.passed);
}

/** トラックの見た目:地面・トラック・白線(両端の実線・レーンの破線・スタートの市松模様)・チェックポイントの柱と線 */
function trackBoxes(ep: TrackEpisode): EpisodeProps['boxes'] {
  const boxes: EpisodeProps['boxes'] = [];
  const W = TRACK.width;
  const S = TRACK.straight;
  const R = TRACK.radius;
  boxes.push({ x: 0, y: -0.05, z: 0, hx: R + W + 3, hy: 0.05, hz: S / 2 + R + W + 3, color: GROUND });
  // 内側の芝(トラックの内側を少し明るくする)
  boxes.push({ x: 0, y: 0.002, z: 0, hx: R - W / 2, hy: 0.002, hz: S / 2, color: INFIELD });
  for (const cz of [S / 2, -S / 2]) {
    for (let k = 0; k < 24; k++) {
      const th = (k + 0.5) * (Math.PI / 24) + (cz < 0 ? Math.PI : 0);
      const r = (R - W / 2) / 2;
      boxes.push({
        x: r * cos(th),
        y: 0.002,
        z: cz + r * sin(th),
        hx: r,
        hy: 0.002,
        hz: (R - W / 2) * sin(Math.PI / 48) + 0.02,
        color: INFIELD,
        yaw: atan2(-sin(th), cos(th)),
      });
    }
  }
  // トラック:中心線に沿って板を並べる(外側の長さに合わせ、すき間ができないようにする)
  strip(boxes, 0, W / 2, 0.006, 96, TRACK_COLOR, () => true);
  // 白線:両端は実線、レーンの境目は破線
  const line = 0.05;
  strip(boxes, -W / 2 + line, line, 0.016, 192, WHITE, () => true);
  strip(boxes, W / 2 - line, line, 0.016, 192, WHITE, () => true);
  for (let j = 1; j < TRACK.lanes; j++) strip(boxes, -W / 2 + (W * j) / TRACK.lanes, line * 0.7, 0.016, 192, WHITE, (k) => Math.floor(k / 3) % 2 === 0);
  // スタート・ゴールの市松模様(ゴールのチェックポイントの線のすぐ手前)
  const start = trackPoint(0);
  const sq = W / 8;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      const lat = -W / 2 + sq * (col + 0.5);
      const back = -sq * 0.5 * (row + 0.5) - 0.1;
      boxes.push({
        x: start.x + start.tz * lat + start.tx * back,
        y: 0.017,
        z: start.z - start.tx * lat + start.tz * back,
        hx: sq / 2,
        hy: 0.004,
        hz: sq / 4,
        color: (row + col) % 2 === 0 ? WHITE : BLACK,
        yaw: atan2(start.tx, start.tz),
      });
    }
  }
  // チェックポイント:両側の柱と、トラックを横切る線。自分(1人目)が通ったら緑、次に通るものはオレンジになる
  CHECKPOINTS.forEach((c, k) => {
    const colorOf = () => {
      const st = ep.checkpointState(k);
      return st === 'passed' ? PASSED : st === 'next' ? NEXT : k === CHECKPOINTS.length - 1 ? FINISH : WHITE;
    };
    for (const side of [-1, 1]) {
      const nx = c.tz * side;
      const nz = -c.tx * side;
      boxes.push({ x: c.x + nx * (W / 2 + 0.15), y: 0.6, z: c.z + nz * (W / 2 + 0.15), hx: 0.07, hy: 0.6, hz: 0.07, color: WHITE, colorOf });
      // 柱の上の旗
      boxes.push({
        x: c.x + nx * (W / 2 + 0.15) + c.tx * 0.18,
        y: 1.08,
        z: c.z + nz * (W / 2 + 0.15) + c.tz * 0.18,
        hx: 0.02,
        hy: 0.11,
        hz: 0.18,
        color: WHITE,
        colorOf,
        yaw: atan2(c.tx, c.tz),
      });
    }
    // 板の長い向き(ローカルの x)をトラックの横方向に、薄い向き(ローカルの z)を進む向きに合わせる
    boxes.push({ x: c.x, y: 0.02, z: c.z, hx: W / 2, hy: 0.005, hz: 0.07, color: WHITE, colorOf, yaw: atan2(c.tx, c.tz) });
  });
  return boxes;
}

/**
 * 中心線から横に offset [m](外側が正)ずれた線に沿って、細い板を n 枚並べる(half は板の幅の半分)。
 * keep(k) が false の板は置かない(破線にする)
 */
function strip(boxes: EpisodeProps['boxes'], offset: number, half: number, y: number, n: number, color: number, keep: (k: number) => boolean): void {
  // 中心線の点を、横(外向き)にずらす。外向きは進む向き (tx, tz) を右に回した (tz, -tx)
  const at = (s: number, o: number) => {
    const p = trackPoint(s);
    return { x: p.x + p.tz * o, z: p.z - p.tx * o };
  };
  for (let k = 0; k < n; k++) {
    if (!keep(k)) continue;
    const s0 = (k * TRACK_LENGTH) / n;
    const s1 = ((k + 1) * TRACK_LENGTH) / n;
    const a = at(s0, offset);
    const b = at(s1, offset);
    // 板の長さは、板の外側の端の長さに合わせる(曲がるところですき間ができないように)
    const ao = at(s0, offset + half);
    const bo = at(s1, offset + half);
    const len = Math.max(Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2), Math.sqrt((bo.x - ao.x) ** 2 + (bo.z - ao.z) ** 2));
    boxes.push({
      x: (a.x + b.x) / 2,
      y,
      z: (a.z + b.z) / 2,
      hx: half,
      hy: y > 0.01 ? 0.004 : 0.006,
      hz: len / 2 + 0.01,
      color,
      yaw: atan2(b.x - a.x, b.z - a.z),
    });
  }
}
