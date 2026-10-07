// 判断脳(仕様書セクション7)。体に依存せず、「どの方向へどの速さで進むか」を決めて運動脳に指令する。
// 入力81:周囲タイル61(4周分)・自分3・相手7・安全円5・時間1・相手との接触4。
// 出力4:進む方向(コア基準の水平2成分)・速さ・ジャンプ指令(0より大きければ跳ぶ)。
import { BATTLE, BRAIN, STAGE } from '../config';
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
