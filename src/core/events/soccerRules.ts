// サッカーの役割ごとの手書きの動き(サッカー脳を鍛えていないキャラと、トレーニングの相手BOTが使う)。
//   シューター:ボールの後ろ(攻めるゴールの反対側)に回り込み、近づいたらゴールへ押し込む
//   ブロッカー:自分のゴールの前で待ち、ボールが近づいたら取りに出て、遠くへ押し返す。ボールが遠ければゴール前に戻る
//   キャリアー:ボールの後ろに回り込み、前方(相手陣の手前)へ向けてゆっくり押して運ぶ
import type { MotorCommand } from '../brain/motor';
import { SOCCER, type SoccerRole } from '../config';
import type { Fighter } from '../sim/fighter';

function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

/** ボールを、指定した点の方へ押す動き(ボールの後ろに回り込み、近づいたら押す) */
function pushToward(me: { x: number; z: number }, ball: { x: number; z: number }, tx: number, tz: number, speed: number): MotorCommand {
  const gx = tx - ball.x;
  const gz = tz - ball.z;
  const gl = len(gx, gz) || 1;
  const bx = ball.x - (gx / gl) * SOCCER.approachOffset;
  const bz = ball.z - (gz / gl) * SOCCER.approachOffset;
  if (len(me.x - bx, me.z - bz) < SOCCER.pushStartDist) return { dirX: gx, dirZ: gz, speed };
  return { dirX: bx - me.x, dirZ: bz - me.z, speed: 1 };
}

/** 役割ごとの指令。team 0 は +z を攻める */
export function ruleCommand(role: SoccerRole, f: Fighter, team: number, ball: { x: number; z: number }, speed = 1): MotorCommand {
  const me = f.position();
  const goalZ = team === 0 ? SOCCER.halfLength : -SOCCER.halfLength;
  const ownGoalZ = -goalZ;
  const dir = Math.sign(goalZ);
  if (role === 'shooter') return pushToward(me, ball, 0, goalZ, speed);
  if (role === 'carrier') {
    // 相手陣の手前(フィールドの3/4)まで、ボールを前へ運ぶ
    return pushToward(me, ball, ball.x * 0.5, goalZ * 0.5, SOCCER.carrySpeed * speed);
  }
  // ブロッカー
  const homeX = Math.max(-SOCCER.goalWidth / 2, Math.min(SOCCER.goalWidth / 2, ball.x * 0.5));
  const homeZ = ownGoalZ + dir * SOCCER.blockerLine;
  const ballNear = Math.abs(ball.z - ownGoalZ) < SOCCER.blockerReach;
  if (ballNear) return pushToward(me, ball, ball.x, goalZ, speed);
  const d = len(homeX - me.x, homeZ - me.z);
  return d < 0.4 ? { dirX: 0, dirZ: dir, speed: 0 } : { dirX: homeX - me.x, dirZ: homeZ - me.z, speed: Math.min(1, d) * speed };
}
