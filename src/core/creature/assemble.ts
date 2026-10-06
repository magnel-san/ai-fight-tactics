// 設計図からRapierの剛体・コライダー・関節を組み立てる(仕様書セクション4・5)。
// 登録順は必ずブロックID順:剛体(セグメントの根のID順)→ コライダー(ブロックID順)→ 関節(関節ブロックのID順)。
import type { ImpulseJoint, RevoluteImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import { BLOCKS, CREATURE } from '../config';
import { atan2, cos, sin } from '../math/fmath';
import { rotate } from '../math/quat';
import type { Rapier } from '../physics/rapier';
import { AXIS_DIR, blockPositions, segmentsOf, validate, type Blueprint } from './blueprint';

export interface SpawnPose {
  /** コア中心のワールド座標 [m] */
  position: { x: number; y: number; z: number };
  /** 鉛直軸まわりの向き [rad]。0 のときコアの正面(+z)がワールドの +z を向く */
  yaw: number;
}

export interface Creature {
  blueprint: Blueprint;
  /** セグメントごとの剛体(0番がコア) */
  bodies: RigidBody[];
  /** 関節(関節ブロックのID順。運動脳の入出力の並び順と同じ) */
  joints: RevoluteImpulseJoint[];
  /** joints[i] に対応する関節ブロックのID */
  jointBlockIds: number[];
  /** 各ブロックが属する剛体の番号(描画で使う) */
  segmentOf: number[];
  /** 各ブロックの、属する剛体のローカル座標での中心 [m](描画で使う) */
  localOffsets: [number, number, number][];
}

export function spawnCreature(R: Rapier, world: InstanceType<Rapier['World']>, bp: Blueprint, pose: SpawnPose): Creature {
  const errors = validate(bp);
  if (errors.length > 0) throw new Error(`設計図が不正です:${errors.join(' / ')}`);

  const size = CREATURE.blockSize;
  const pos = blockPositions(bp);
  const { segments, segmentOf } = segmentsOf(bp);

  const cy = cos(pose.yaw);
  const sy = sin(pose.yaw);
  const rotation = { x: 0, y: sin(pose.yaw / 2), z: 0, w: cos(pose.yaw / 2) };

  // 剛体:セグメントの根ブロックの位置を剛体の原点にする
  const bodies = segments.map((seg) => {
    const [lx, ly, lz] = pos[seg.root].map((v) => v * size);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x + cy * lx + sy * lz, pose.position.y + ly, pose.position.z - sy * lx + cy * lz)
      .setRotation(rotation)
      // スリープによる挙動の差をなくすため、キャラの剛体は眠らせない
      .setCanSleep(false);
    return world.createRigidBody(desc);
  });

  // コライダー:各ブロックを、属する剛体のローカル座標に置く
  const half = size / 2 - CREATURE.colliderShrink;
  const localOffsets: [number, number, number][] = [];
  bp.blocks.forEach((b, i) => {
    const root = segments[segmentOf[i]].root;
    const offset: [number, number, number] = [
      (pos[i][0] - pos[root][0]) * size,
      (pos[i][1] - pos[root][1]) * size,
      (pos[i][2] - pos[root][2]) * size,
    ];
    localOffsets.push(offset);
    const spec = BLOCKS[b.type];
    // 角を丸めた立方体(外形は 2 × half のまま、角を半径 blockRoundness で丸める)
    const r = CREATURE.blockRoundness;
    const desc = R.ColliderDesc.roundCuboid(half - r, half - r, half - r, r)
      .setTranslation(offset[0], offset[1], offset[2])
      .setMass(spec.mass)
      .setFriction(spec.friction)
      .setRestitution(spec.restitution);
    // グリップの摩擦と弾力の反発は、相手の値と平均せず大きい方を使う(特性をはっきり効かせる)
    if (b.type === 'grip') desc.setFrictionCombineRule(R.CoefficientCombineRule.Max);
    if (b.type === 'bouncy') desc.setRestitutionCombineRule(R.CoefficientCombineRule.Max);
    world.createCollider(desc, bodies[segmentOf[i]]);
  });

  // 関節:親ブロックと関節ブロックの接する面の中心をヒンジの支点にする
  const joints: RevoluteImpulseJoint[] = [];
  const jointBlockIds: number[] = [];
  for (const b of bp.blocks) {
    if (b.type !== 'joint') continue;
    const parent = b.parent!;
    const parentRoot = segments[segmentOf[parent]].root;
    const anchorGrid = [0, 1, 2].map((k) => (pos[parent][k] + pos[b.id][k]) / 2);
    const anchor1 = {
      x: (anchorGrid[0] - pos[parentRoot][0]) * size,
      y: (anchorGrid[1] - pos[parentRoot][1]) * size,
      z: (anchorGrid[2] - pos[parentRoot][2]) * size,
    };
    const anchor2 = {
      x: (anchorGrid[0] - pos[b.id][0]) * size,
      y: (anchorGrid[1] - pos[b.id][1]) * size,
      z: (anchorGrid[2] - pos[b.id][2]) * size,
    };
    const [ax, ay, az] = AXIS_DIR[b.axis!];
    const data = R.JointData.revolute(anchor1, anchor2, { x: ax, y: ay, z: az });
    const joint = world.createImpulseJoint(data, bodies[segmentOf[parent]], bodies[segmentOf[b.id]], true) as ImpulseJoint as RevoluteImpulseJoint;
    joint.setContactsEnabled(false);
    joint.setLimits(-CREATURE.jointLimit, CREATURE.jointLimit);
    // ForceBased:ばね定数・減衰・上限をトルク(N·m)で扱う。重い手足ほどゆっくり動く
    joint.configureMotorModel(R.MotorModel.ForceBased);
    joint.setMotorMaxForce(CREATURE.jointMaxTorque);
    joint.configureMotorPosition(0, CREATURE.jointStiffness, CREATURE.jointDamping);
    joints.push(joint);
    jointBlockIds.push(b.id);
  }

  return { blueprint: bp, bodies, joints, jointBlockIds, segmentOf, localOffsets };
}

/** 各関節の目標角度を設定する。targets は -1〜1 で、可動範囲 ±jointLimit に対応する */
export function setJointTargets(creature: Creature, targets: ArrayLike<number>): void {
  creature.joints.forEach((joint, i) => {
    const t = Math.max(-1, Math.min(1, targets[i]));
    joint.configureMotorPosition(t * CREATURE.jointLimit, CREATURE.jointStiffness, CREATURE.jointDamping);
  });
}

/** 関節の現在角度 [rad] と角速度 [rad/s]。運動脳の入力に使う */
export function jointStates(creature: Creature): { angle: number; velocity: number }[] {
  // Rapier の JS API には関節角度の取得がないため、2つの剛体の相対回転から求める。
  // 組み立て時は全剛体が同じ向きなので、相対回転 q = q1^-1 * q2 はヒンジ軸まわりの回転になる
  return creature.joints.map((joint, i) => {
    const b = creature.blueprint.blocks[creature.jointBlockIds[i]];
    const [ax, ay, az] = AXIS_DIR[b.axis!];
    const q1 = joint.body1().rotation();
    const q2 = joint.body2().rotation();
    // q = conj(q1) * q2
    const w = q1.w * q2.w + q1.x * q2.x + q1.y * q2.y + q1.z * q2.z;
    const x = q1.w * q2.x - q1.x * q2.w - q1.y * q2.z + q1.z * q2.y;
    const y = q1.w * q2.y + q1.x * q2.z - q1.y * q2.w - q1.z * q2.x;
    const z = q1.w * q2.z - q1.x * q2.y + q1.y * q2.x - q1.z * q2.w;
    const angle = 2 * atan2(x * ax + y * ay + z * az, w);
    // 角速度:2剛体の角速度の差を、ワールド座標でのヒンジ軸に射影する
    const axis = rotate(q1, ax, ay, az);
    const w1 = joint.body1().angvel();
    const w2 = joint.body2().angvel();
    const velocity = (w2.x - w1.x) * axis[0] + (w2.y - w1.y) * axis[1] + (w2.z - w1.z) * axis[2];
    // 角度は (-π, π] に正規化する
    return { angle: angle > Math.PI ? angle - 2 * Math.PI : angle < -Math.PI ? angle + 2 * Math.PI : angle, velocity };
  });
}
