// サッカー脳(役割ごとに1つ:シューター・ブロッカー・キャリアー)。どこへどの速さで進むかを決めて、運動脳に指令する。
// 判断脳(崩落ステージ用)とは別の、小さな脳。サッカーのトレーニングで役割ごとに鍛え、試合ではその役割のときに使う。
// 入力19(すべてキャラの向き基準):ボールの位置2・ボールの相対速度2・ボールの高さ1・距離1・攻めるゴール2・守るゴール2・
//   いちばん近い相手2・相手がいるか1・自分の速度2・時間1・お手本の動き3(向き2・速さ1)。出力3:進む方向2・速さ1。
// 最初の脳は、お手本の動きをそのまま出すように作る(createSoccerGenome)。
import { SOCCER_BRAIN } from '../config';
import type { Rng } from '../math/rng';
import type { Fighter } from '../sim/fighter';
import { roundF16 } from './f16';
import { mlpForward, mlpInit, mlpParamCount, type MlpShape } from './mlp';
import type { MotorCommand } from './motor';

export const SOCCER_SHAPE: MlpShape = { inputs: SOCCER_BRAIN.inputs, hidden: SOCCER_BRAIN.hidden, outputs: SOCCER_BRAIN.outputs };

export function soccerGenomeLength(): number {
  return mlpParamCount(SOCCER_SHAPE);
}

/** お手本の入力の位置(入力の最後の3つ) */
const RULE_INPUT = SOCCER_BRAIN.inputs - 3;

/**
 * 最初のサッカー脳:お手本の動き(入力の最後の3つ)を、そのまま進む方向と速さとして出す。
 * ほかの重みは小さなばらつきだけにして、鍛えながらお手本より上手な動きを探す
 */
export function createSoccerGenome(rng: Rng): Float64Array {
  const s = SOCCER_SHAPE;
  const g = new Float64Array(soccerGenomeLength());
  mlpInit(s, rng, g, 0);
  for (let i = 0; i < g.length; i++) g[i] = roundF16(g[i] * 0.2);
  const w2 = s.hidden * s.inputs + s.hidden;
  for (let k = 0; k < 3; k++) {
    // 隠れ層の k 番目 ← お手本の k 番目、出力の k 番目 ← 隠れ層の k 番目
    g[k * s.inputs + RULE_INPUT + k] = 1;
    g[w2 + k * s.hidden + k] = 2;
  }
  return g;
}

export interface SoccerContext {
  self: Fighter;
  ball: { x: number; y: number; z: number };
  ballVel: { x: number; y: number; z: number };
  /** 攻めるゴールと守るゴールの z */
  enemyGoalZ: number;
  ownGoalZ: number;
  /** いちばん近い相手(いなければ null) */
  opponent: Fighter | null;
  /** 経過時間の割合(0〜1) */
  timeRatio: number;
  /** お手本の動き(その役割の手書きの動き。ワールドの向きと速さ) */
  rule: MotorCommand;
}

export function soccerInputs(ctx: SoccerContext, x: Float64Array): void {
  const { self } = ctx;
  const p = self.position();
  const h = self.heading();
  const v = self.core.linvel();
  const S = SOCCER_BRAIN.posScale;
  const V = SOCCER_BRAIN.velScale;
  // ワールドの水平ベクトルを、キャラの向き基準の (x, z) に直す
  const local = (vx: number, vz: number): [number, number] => [vx * h.xx + vz * h.xz, vx * h.fx + vz * h.fz];
  let k = 0;
  const [bx, bz] = local(ctx.ball.x - p.x, ctx.ball.z - p.z);
  const [bvx, bvz] = local(ctx.ballVel.x - v.x, ctx.ballVel.z - v.z);
  x[k++] = bx / S;
  x[k++] = bz / S;
  x[k++] = bvx / V;
  x[k++] = bvz / V;
  x[k++] = ctx.ball.y / 3;
  x[k++] = Math.sqrt(bx * bx + bz * bz) / S;
  const [ex, ez] = local(0 - p.x, ctx.enemyGoalZ - p.z);
  x[k++] = ex / (2 * S);
  x[k++] = ez / (2 * S);
  const [ox, oz] = local(0 - p.x, ctx.ownGoalZ - p.z);
  x[k++] = ox / (2 * S);
  x[k++] = oz / (2 * S);
  if (ctx.opponent && ctx.opponent.isFinite()) {
    const q = ctx.opponent.position();
    const [rx, rz] = local(q.x - p.x, q.z - p.z);
    x[k++] = rx / S;
    x[k++] = rz / S;
    x[k++] = 1;
  } else {
    x[k++] = 0;
    x[k++] = 0;
    x[k++] = 0;
  }
  const [svx, svz] = local(v.x, v.z);
  x[k++] = svx / V;
  x[k++] = svz / V;
  x[k++] = ctx.timeRatio;
  // お手本の向き(単位ベクトル)と速さ
  const [rx, rz] = local(ctx.rule.dirX, ctx.rule.dirZ);
  const rl = Math.sqrt(rx * rx + rz * rz);
  x[k++] = rl > 1e-9 ? rx / rl : 0;
  x[k++] = rl > 1e-9 ? rz / rl : 0;
  x[k++] = rl > 1e-9 ? ctx.rule.speed : 0;
}

export class SoccerBrain {
  readonly input = new Float64Array(SOCCER_SHAPE.inputs);
  readonly hidden = new Float64Array(SOCCER_SHAPE.hidden);
  readonly output = new Float64Array(SOCCER_SHAPE.outputs);

  constructor(private genome: Float64Array) {
    if (genome.length !== soccerGenomeLength()) throw new Error(`サッカー脳の遺伝子の長さが違います:${genome.length}`);
  }

  think(ctx: SoccerContext): MotorCommand {
    soccerInputs(ctx, this.input);
    mlpForward(SOCCER_SHAPE, this.genome, 0, this.input, this.hidden, this.output);
    const h = ctx.self.heading();
    const u = this.output[0];
    const w = this.output[1];
    return { dirX: u * h.xx + w * h.fx, dirZ: u * h.xz + w * h.fz, speed: (this.output[2] + 1) / 2 };
  }
}
