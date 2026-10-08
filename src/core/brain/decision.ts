// 判断脳(仕様書セクション7)。体に依存せず、「どの方向へどの速さで進むか」を決めて運動脳に指令する。
// 入力102:周囲タイル61(4周分)・自分3・相手7・安全円5・時間1・相手との接触4・相手の向きと体の形9・体の傾きと回転12。
// 出力4:進む方向(コア基準の水平2成分)・速さ・ジャンプ指令(0より大きければ跳ぶ)。
import { BATTLE, BLOCKS, BRAIN, CREATURE, STAGE } from '../config';
import type { Rng } from '../math/rng';
import type { Fighter } from '../sim/fighter';
import { rotate } from '../math/quat';
import { hexesWithin, hexToWorld, worldToHex } from '../stage/hex';
import type { Stage } from '../stage/stage';
import { mlpForward, mlpInit, mlpParamCount, type MlpShape } from './mlp';
import type { MotorCommand } from './motor';

export const DECISION_SHAPE: MlpShape = {
  inputs: BRAIN.decisionInputs,
  hidden: BRAIN.decisionHidden,
  outputs: BRAIN.decisionOutputs,
};

export function decisionGenomeLength(): number {
  return mlpParamCount(DECISION_SHAPE);
}

export function createDecisionGenome(rng: Rng): Float64Array {
  const g = new Float64Array(decisionGenomeLength());
  mlpInit(DECISION_SHAPE, rng, g, 0);
  return g;
}

/** 目で見るタイルの、コアを中心とした六角格子の位置(4周分 = 61点。並び順は hexesWithin の順) */
export const EYE_HEXES = hexesWithin(BRAIN.eyeRings);

/**
 * 目:EYE_HEXES のワールド座標での位置。コアの向きに合わせて回転させて使う。
 * x はコアの +x 方向、z は正面方向の距離 [m]
 */
export const EYE_OFFSETS: readonly { x: number; z: number }[] = EYE_HEXES.map((h) => hexToWorld(h, STAGE.tileCircumradius));

export interface DecisionContext {
  self: Fighter;
  opponent: Fighter | null;
  stage: Stage;
  time: number;
  /** 2体のブロックが触れているか(試合が調べて渡す) */
  touching?: boolean;
}

/** すべてのブロックの中心のワールド座標 */
export function blockWorldPositions(f: Fighter): { x: number; y: number; z: number }[] {
  const c = f.creature;
  return c.localOffsets.map((o, i) => {
    const body = c.bodies[c.segmentOf[i]];
    const t = body.translation();
    const [x, y, z] = rotate(body.rotation(), o[0], o[1], o[2]);
    return { x: t.x + x, y: t.y + y, z: t.z + z };
  });
}

/** 2体のブロック同士の、いちばん近い中心間の距離 [m] */
export function nearestBlockDistance(a: Fighter, b: Fighter): number {
  const pa = blockWorldPositions(a);
  const pb = blockWorldPositions(b);
  let best = Infinity;
  for (const p of pa) {
    for (const q of pb) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** 体の重さの合計 [kg](設計図のブロックの重さを足したもの) */
export function bodyMass(f: Fighter): number {
  let m = 0;
  for (const b of f.creature.blueprint.blocks) m += BLOCKS[b.type].mass;
  return m;
}

/**
 * 体の形:コアから見て、(ux, uz) の向き・その反対・両横へ、体がどこまで伸びているか [m] と、体の高さ [m]。
 * 横は、(ux, uz) と反対向きに立って見たときのコアの +x 側(side)と -x 側(otherSide)
 */
export function bodyShape(f: Fighter, ux: number, uz: number): { toward: number; away: number; side: number; otherSide: number; height: number } {
  const q = f.position();
  // (ux, uz) の反対を正面とするコアの +x は (-uz, ux)(Fighter.heading と同じ決まり)
  const sx = -uz;
  const sz = ux;
  let toward = 0;
  let away = 0;
  let side = 0;
  let otherSide = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of blockWorldPositions(f)) {
    const dx = b.x - q.x;
    const dz = b.z - q.z;
    const a = dx * ux + dz * uz;
    const s = dx * sx + dz * sz;
    toward = Math.max(toward, a);
    away = Math.max(away, -a);
    side = Math.max(side, s);
    otherSide = Math.max(otherSide, -s);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y);
  }
  const half = CREATURE.blockSize / 2;
  return { toward: toward + half, away: away + half, side: side + half, otherSide: otherSide + half, height: maxY - minY + CREATURE.blockSize };
}

/** 相手の周り(自分のマスと隣の6マス)で、いちばん危ないところの危険度(穴なら1)。崖っぷちにいる相手ほど大きい */
const NEIGHBOR_HEXES = hexesWithin(1);
export function edgeDanger(stage: Stage, f: Fighter): number {
  const p = f.position();
  const h = worldToHex(p.x, p.z, stage.size);
  let worst = 0;
  for (const n of NEIGHBOR_HEXES) {
    const w = hexToWorld({ q: h.q + n.q, r: h.r + n.r }, stage.size);
    const d = stage.dangerAt(w.x, w.z);
    worst = Math.max(worst, d < 0 ? 1 : d);
  }
  return worst;
}

/** 判断脳の入力を組み立てる(観戦の「脳の様子」でも使えるよう外に出しておく) */
export function decisionInputs(ctx: DecisionContext, x: Float64Array): void {
  const { self, opponent, stage } = ctx;
  const p = self.position();
  const h = self.heading();
  let k = 0;

  // 周囲タイル
  for (const o of EYE_OFFSETS) {
    const wx = p.x + o.x * h.xx + o.z * h.fx;
    const wz = p.z + o.x * h.xz + o.z * h.fz;
    x[k++] = stage.dangerAt(wx, wz);
  }

  // ワールドの水平ベクトルを、コアの向き基準の (x, z) に直す
  const local = (vx: number, vz: number): [number, number] => [vx * h.xx + vz * h.xz, vx * h.fx + vz * h.fz];

  // 自分
  const tile = stage.tileAt(p.x, p.z);
  x[k++] = tile && tile.state !== 'collapsed' ? tile.stay / STAGE.stayLimit : 0;
  const v = self.core.linvel();
  const [svx, svz] = local(v.x, v.z);
  x[k++] = svx / BRAIN.decisionVelScale;
  x[k++] = svz / BRAIN.decisionVelScale;

  // 相手
  if (opponent && !opponent.out) {
    const q = opponent.position();
    const [rx, rz] = local(q.x - p.x, q.z - p.z);
    const ov = opponent.core.linvel();
    const [rvx, rvz] = local(ov.x - v.x, ov.z - v.z);
    const d = stage.dangerAt(q.x, q.z);
    x[k++] = rx / BRAIN.decisionPosScale;
    x[k++] = rz / BRAIN.decisionPosScale;
    x[k++] = rvx / BRAIN.decisionVelScale;
    x[k++] = rvz / BRAIN.decisionVelScale;
    x[k++] = Math.sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) / BRAIN.decisionDistScale;
    x[k++] = d < 0 ? 1 : d;
    x[k++] = 1;
  } else {
    for (let i = 0; i < 7; i++) x[k++] = 0;
  }

  // 安全円
  const fp = hexToWorld(stage.finalPoint, stage.size);
  const [fx, fz] = local(fp.x - p.x, fp.z - p.z);
  const fd = Math.sqrt(fx * fx + fz * fz);
  x[k++] = fd > 1e-9 ? fx / fd : 0;
  x[k++] = fd > 1e-9 ? fz / fd : 0;
  x[k++] = fd / BRAIN.decisionDistScale;
  x[k++] = stage.safeRadius / BRAIN.safeRadiusScale;
  x[k++] = stage.isOutsideSafe(worldToHex(p.x, p.z, stage.size)) ? 1 : 0;

  // 時間
  x[k++] = ctx.time / BATTLE.timeLimit;

  // 相手との接触:触れているか・近づく速さ・いちばん近いブロックまでの距離・相手の周りの危険度(相手がいなければ 0)
  if (opponent && !opponent.out) {
    const q = opponent.position();
    const ov = opponent.core.linvel();
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // 近づく速さ = 距離が縮む速さ(相対速度の、相手に向かう成分の反対)
    const closing = dist > 1e-9 ? -((ov.x - v.x) * dx + (ov.z - v.z) * dz) / dist : 0;
    x[k++] = ctx.touching ? 1 : 0;
    x[k++] = closing / BRAIN.decisionVelScale;
    x[k++] = Math.min(1, nearestBlockDistance(self, opponent) / BRAIN.decisionContactScale);
    x[k++] = edgeDanger(stage, opponent);
  } else {
    for (let i = 0; i < 4; i++) x[k++] = 0;
  }

  // 相手の向きと体の形:相手の正面の向き(自分の向き基準)・こちらを向いているか・重さの比べ・
  // 体がこちら側・反対側・両横へどこまで伸びているか・体の高さ(相手がいなければ 0)
  if (opponent && !opponent.out) {
    const q = opponent.position();
    const oh = opponent.heading();
    // 相手から自分への向き(重なっているときは、自分の正面の反対)
    let ux = p.x - q.x;
    let uz = p.z - q.z;
    const ud = Math.sqrt(ux * ux + uz * uz);
    if (ud > 1e-9) {
      ux /= ud;
      uz /= ud;
    } else {
      ux = -h.fx;
      uz = -h.fz;
    }
    const [ofx, ofz] = local(oh.fx, oh.fz);
    x[k++] = ofx;
    x[k++] = ofz;
    x[k++] = oh.fx * ux + oh.fz * uz;
    const sm = bodyMass(self);
    const om = bodyMass(opponent);
    x[k++] = (om - sm) / (om + sm);
    const s = bodyShape(opponent, ux, uz);
    x[k++] = s.toward / BRAIN.decisionShapeScale;
    x[k++] = s.away / BRAIN.decisionShapeScale;
    x[k++] = s.side / BRAIN.decisionShapeScale;
    x[k++] = s.otherSide / BRAIN.decisionShapeScale;
    x[k++] = s.height / BRAIN.decisionShapeScale;
  } else {
    for (let i = 0; i < 9; i++) x[k++] = 0;
  }

  // 体の傾きと回転:自分と相手のコアの上が向いている方向(まっすぐ立っていれば (0, 1, 0)、ひっくり返ると上下が -1)と、
  // 回転の速さ(角速度)。どちらも自分の向き基準(コアの +x・真上・正面)に直す(相手がいなければ 0)
  for (const f of [self, opponent]) {
    if (f && !f.out) {
      const [ux, uy, uz] = rotate(f.core.rotation(), 0, 1, 0);
      const [lux, luz] = local(ux, uz);
      x[k++] = lux;
      x[k++] = uy;
      x[k++] = luz;
      const w = f.core.angvel();
      const [lwx, lwz] = local(w.x, w.z);
      x[k++] = lwx / BRAIN.angvelScale;
      x[k++] = w.y / BRAIN.angvelScale;
      x[k++] = lwz / BRAIN.angvelScale;
    } else {
      for (let i = 0; i < 6; i++) x[k++] = 0;
    }
  }
}

export class DecisionBrain {
  readonly input = new Float64Array(DECISION_SHAPE.inputs);
  readonly hidden = new Float64Array(DECISION_SHAPE.hidden);
  readonly output = new Float64Array(DECISION_SHAPE.outputs);

  constructor(private genome: Float64Array) {
    if (genome.length !== decisionGenomeLength()) throw new Error(`判断脳の遺伝子の長さが違います:${genome.length}`);
  }

  think(ctx: DecisionContext): MotorCommand {
    decisionInputs(ctx, this.input);
    mlpForward(DECISION_SHAPE, this.genome, 0, this.input, this.hidden, this.output);
    // 出力はコアの向き基準の方向なので、ワールドの方向に直す
    const h = ctx.self.heading();
    const u = this.output[0];
    const w = this.output[1];
    return {
      dirX: u * h.xx + w * h.fx,
      dirZ: u * h.xz + w * h.fz,
      speed: (this.output[2] + 1) / 2,
      jump: this.output[3] > 0 ? 1 : 0,
    };
  }
}

/** 突進BOT:相手のコアに向かって直進するだけのルールベースの判断 */
export function rushCommand(self: Fighter, opponent: Fighter | null): MotorCommand {
  if (!opponent || opponent.out) return { dirX: 0, dirZ: 1, speed: 0 };
  const p = self.position();
  const q = opponent.position();
  return { dirX: q.x - p.x, dirZ: q.z - p.z, speed: 1 };
}

/** 運動脳の「足元」入力:指令方向の前方の数点が穴かどうか */
export function footing(stage: Stage, self: Fighter): number[] {
  const p = self.position();
  const c = self.command;
  const len = Math.sqrt(c.dirX * c.dirX + c.dirZ * c.dirZ);
  if (len < 1e-9) return BRAIN.footingDistances.map(() => 0);
  return BRAIN.footingDistances.map((d) => (stage.isHole(p.x + (c.dirX / len) * d, p.z + (c.dirZ / len) * d) ? 1 : 0));
}
