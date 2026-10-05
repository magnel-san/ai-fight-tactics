// 試合やトレーニングに参加する1体分の実行器。体(剛体)と運動脳をまとめ、
// 「進む方向と速さ」の指令を受けて関節を動かす。指令を決めるのは判断脳・BOT・トレーニング課題のどれか。
import type { World } from '@dimforge/rapier3d-compat';
import { MotorBrain, type MotorCommand } from '../brain/motor';
import { setJointTargets, spawnCreature, type Creature, type SpawnPose } from '../creature/assemble';
import type { Blueprint } from '../creature/blueprint';
import { rotate } from '../math/quat';
import type { Rapier } from '../physics/rapier';

export class Fighter {
  readonly creature: Creature;
  readonly motor: MotorBrain;
  /** 現在の指令(次に変えるまで保持する) */
  command: MotorCommand = { dirX: 0, dirZ: 1, speed: 0 };
  /** 脱落したか */
  out = false;

  constructor(R: Rapier, world: World, bp: Blueprint, motorGenome: Float64Array, pose: SpawnPose) {
    this.creature = spawnCreature(R, world, bp, pose);
    this.motor = new MotorBrain(this.creature, motorGenome);
  }

  get core() {
    return this.creature.bodies[0];
  }

  position(): { x: number; y: number; z: number } {
    return this.core.translation();
  }

  /** コアの向きを水平面に投影した単位ベクトル(前方 F と、コアの +x 方向 X) */
  heading(): { fx: number; fz: number; xx: number; xz: number } {
    const q = this.core.rotation();
    let [fx, , fz] = rotate(q, 0, 0, 1);
    let len = Math.sqrt(fx * fx + fz * fz);
    if (len < 0.2) {
      // 正面が真上・真下を向いているときは、コアの上方向を代わりに使う
      const [ux, , uz] = rotate(q, 0, 1, 0);
      fx = ux;
      fz = uz;
      len = Math.sqrt(fx * fx + fz * fz);
    }
    if (len < 1e-9) return { fx: 0, fz: 1, xx: 1, xz: 0 };
    fx /= len;
    fz /= len;
    // 鉛直軸まわりの回転では、コアの +x は (cos yaw, -sin yaw)、前方は (sin yaw, cos yaw)
    return { fx, fz, xx: fz, xz: -fx };
  }

  /** 運動脳を1回動かして関節の目標角度を更新する。holesAhead は指令方向の前方3点が穴かどうか */
  drive(time: number, holesAhead?: readonly number[]): Float64Array {
    const out = this.motor.think(this.command, time, holesAhead);
    setJointTargets(this.creature, out);
    return out;
  }

  isFinite(): boolean {
    const p = this.position();
    return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  }
}
