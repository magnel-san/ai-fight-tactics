// 運動脳(仕様書セクション7)。判断脳からの指令(進む方向と速さ)どおりに関節を動かす。
// 遺伝子 = MLPの重み + リズム周期の遺伝子1個。体ごとに固有で、入力数は 17 + 2×関節数。
import { BRAIN } from '../config';
import { actuatorStates, actuatorsOf, type Creature } from '../creature/assemble';
import { cos, exp, log, sin } from '../math/fmath';
import { rotateInv } from '../math/quat';
import type { Rng } from '../math/rng';
import { roundF16 } from './f16';
import { mlpForward, mlpInit, mlpParamCount, type MlpShape } from './mlp';

/** 運動脳の形。actuators は動かせるブロック(関節 + ピストン)の数 */
export function motorShape(actuators: number): MlpShape {
  return { inputs: BRAIN.motorFixedInputs + 2 * actuators, hidden: BRAIN.motorHidden, outputs: actuators };
}

/** 遺伝子の長さ(MLPの重み + リズム周期) */
export function motorGenomeLength(actuators: number): number {
  return mlpParamCount(motorShape(actuators)) + 1;
}

/** リズム周期 [s]。遺伝子は周期の対数で持ち、範囲外は端に収める */
export function rhythmPeriod(genome: Float64Array): number {
  const g = genome[genome.length - 1];
  return exp(Math.min(log(BRAIN.rhythmPeriodMax), Math.max(log(BRAIN.rhythmPeriodMin), g)));
}

export function createMotorGenome(actuators: number, rng: Rng): Float64Array {
  const genome = new Float64Array(motorGenomeLength(actuators));
  mlpInit(motorShape(actuators), rng, genome, 0);
  genome[genome.length - 1] = roundF16(log(BRAIN.rhythmPeriodInit));
  return genome;
}

/** 運動脳への指令 */
export interface MotorCommand {
  /** 進む方向(ワールド座標の水平成分。長さは問わない) */
  dirX: number;
  dirZ: number;
  /** 速さ 0〜1 */
  speed: number;
  /** ジャンプ指令(1 = 跳べ、0 = なし。省略時は 0) */
  jump?: number;
}

/** 運動脳の実行器。作業領域を使い回して、毎回のメモリ確保を避ける */
export class MotorBrain {
  readonly shape: MlpShape;
  private input: Float64Array;
  /** 隠れ層の活性(「脳の様子」の表示用) */
  readonly hidden: Float64Array;
  readonly output: Float64Array;
  private period: number;

  constructor(
    private creature: Creature,
    private genome: Float64Array,
  ) {
    this.shape = motorShape(actuatorsOf(creature));
    if (genome.length !== motorGenomeLength(actuatorsOf(creature))) {
      throw new Error(`運動脳の遺伝子の長さが体と合いません:${genome.length}`);
    }
    this.input = new Float64Array(this.shape.inputs);
    this.hidden = new Float64Array(this.shape.hidden);
    this.output = new Float64Array(this.shape.outputs);
    this.period = rhythmPeriod(genome);
  }

  /**
   * センサーを読み、各関節の目標角度(-1〜1)を返す。
   * holesAhead は指令方向の前方3マスが穴かどうか(平地では省略)。
   */
  think(command: MotorCommand, time: number, holesAhead: readonly number[] = [0, 0, 0]): Float64Array {
    const core = this.creature.bodies[0];
    const q = core.rotation();
    const x = this.input;
    let k = 0;

    // 指令:進む方向をコア座標系に直し、水平2成分(左右 x・前後 z)を正規化して使う
    const [cx, , cz] = rotateInv(q, command.dirX, 0, command.dirZ);
    const len = Math.sqrt(cx * cx + cz * cz);
    x[k++] = len > 1e-9 ? cx / len : 0;
    x[k++] = len > 1e-9 ? cz / len : 0;
    x[k++] = command.speed;

    // 姿勢:コア座標系で見た重力の向き
    const [gx, gy, gz] = rotateInv(q, 0, -1, 0);
    x[k++] = gx;
    x[k++] = gy;
    x[k++] = gz;

    // 速度:コアの速度と角速度(コア座標系)
    const v = core.linvel();
    const [vx, vy, vz] = rotateInv(q, v.x, v.y, v.z);
    x[k++] = vx / BRAIN.linvelScale;
    x[k++] = vy / BRAIN.linvelScale;
    x[k++] = vz / BRAIN.linvelScale;
    const w = core.angvel();
    const [wx, wy, wz] = rotateInv(q, w.x, w.y, w.z);
    x[k++] = wx / BRAIN.angvelScale;
    x[k++] = wy / BRAIN.angvelScale;
    x[k++] = wz / BRAIN.angvelScale;

    // 関節・ピストン:位置と速さ(どちらも -1〜1 程度にそろえた値)
    for (const s of actuatorStates(this.creature)) {
      x[k++] = s.position;
      x[k++] = s.velocity;
    }

    // リズム
    const phase = (2 * Math.PI * time) / this.period;
    x[k++] = sin(phase);
    x[k++] = cos(phase);

    // 足元
    for (let i = 0; i < 3; i++) x[k++] = holesAhead[i];

    // ジャンプ指令
    x[k++] = command.jump ?? 0;

    mlpForward(this.shape, this.genome, 0, x, this.hidden, this.output);
    return this.output;
  }
}
