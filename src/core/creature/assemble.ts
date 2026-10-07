// 設計図からRapierの剛体・コライダー・関節を組み立てる(仕様書セクション4・5)。
// 登録順は必ずブロックID順:剛体(セグメントの根のID順)→ コライダー(ブロックID順)→ 関節(関節ブロックのID順)。
// 運動脳の入出力の並びは「関節(ID順)→ ピストン(ID順)」。
// 弾力ブロックは親とばね(スライド)でつながり、浮力ブロックには物理ステップごとに上向きの力をかける(applyBlockForces)。
import type { ImpulseJoint, PrismaticImpulseJoint, RevoluteImpulseJoint, RigidBody } from '@dimforge/rapier3d-compat';
import { BLOCK_OPTIONS, BLOCKS, BOUNCY_SPRING, BRAIN, CREATURE, FLOAT_BLOCK } from '../config';
import { atan2, cos, sin } from '../math/fmath';
import { rotate } from '../math/quat';
import type { Rapier } from '../physics/rapier';
import { AXIS_DIR, blockPositions, cylinderAxis, FACE_DIR, pistonDirection, segmentsOf, shapeOf, validate, type Axis, type Blueprint } from './blueprint';

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
  /** ピストン(ピストンブロックのID順) */
  pistons: PrismaticImpulseJoint[];
  /** pistons[i] に対応するピストンブロックのID */
  pistonBlockIds: number[];
  /** 弾力ブロックのばね(弾力ブロックのID順。脳では動かさない) */
  springs: PrismaticImpulseJoint[];
  /** 浮力ブロック:属する剛体の番号と、剛体のローカル座標での位置 */
  floats: { body: number; local: [number, number, number] }[];
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
  const bodies = segments.map((seg, si) => {
    const [lx, ly, lz] = pos[seg.root].map((v) => v * size);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x + cy * lx + sy * lz, pose.position.y + ly, pose.position.z - sy * lx + cy * lz)
      .setRotation(rotation)
      // スリープによる挙動の差をなくすため、キャラの剛体は眠らせない
      .setCanSleep(false);
    // コアの剛体だけ回転にブレーキをかける(関節の反動でコアが回りすぎないように)
    if (si === 0) desc.setAngularDamping(CREATURE.coreAngularDamping);
    return world.createRigidBody(desc);
  });

  // コライダー:各ブロックを、属する剛体のローカル座標に置く
  const half = size / 2 - CREATURE.colliderShrink;
  const localOffsets: [number, number, number][] = [];
  const floats: Creature['floats'] = [];
  bp.blocks.forEach((b, i) => {
    const root = segments[segmentOf[i]].root;
    const offset: [number, number, number] = [(pos[i][0] - pos[root][0]) * size, (pos[i][1] - pos[root][1]) * size, (pos[i][2] - pos[root][2]) * size];
    localOffsets.push(offset);
    const spec = BLOCKS[b.type];
    // 形ごとの当たり判定。外形の大きさはどれも 2 × half(立方体と円柱は角を半径 blockRoundness で丸める)。重さは形に関係なく同じ
    const r = CREATURE.blockRoundness;
    const shape = shapeOf(b);
    const desc =
      shape === 'sphere'
        ? R.ColliderDesc.ball(half)
        : shape === 'cylinder'
          ? R.ColliderDesc.roundCylinder(half - r, half - r, r).setRotation(CYLINDER_ROTATION[cylinderAxis(b)])
          : R.ColliderDesc.roundCuboid(half - r, half - r, half - r, r);
    desc
      .setTranslation(offset[0], offset[1], offset[2])
      .setMass(spec.mass)
      .setFriction(b.grip ? BLOCK_OPTIONS.gripFriction : spec.friction)
      .setRestitution(spec.restitution);
    // 摩擦オンの摩擦と弾力の反発は、相手の値と平均せず大きい方を使う(特性をはっきり効かせる)
    if (b.grip) desc.setFrictionCombineRule(R.CoefficientCombineRule.Max);
    if (b.type === 'bouncy') desc.setRestitutionCombineRule(R.CoefficientCombineRule.Max);
    world.createCollider(desc, bodies[segmentOf[i]]);
    if (b.type === 'float') floats.push({ body: segmentOf[i], local: offset });
  });

  // 関節:親ブロックと関節ブロックの接する面の中心をヒンジの支点にする
  const joints: RevoluteImpulseJoint[] = [];
  const jointBlockIds: number[] = [];
  const pistons: PrismaticImpulseJoint[] = [];
  const pistonBlockIds: number[] = [];
  const springs: PrismaticImpulseJoint[] = [];
  for (const b of bp.blocks) {
    if (b.type !== 'joint' && b.type !== 'piston' && b.type !== 'bouncy') continue;
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
    if (b.type === 'bouncy') {
      // 弾力:付けた面の向きに伸び縮みするばね。力をかけなければ元の位置(0)に戻る
      const [dx, dy, dz] = FACE_DIR[b.face!];
      const sdata = R.JointData.prismatic(anchor1, anchor2, { x: dx, y: dy, z: dz });
      const spring = world.createImpulseJoint(sdata, bodies[segmentOf[parent]], bodies[segmentOf[b.id]], true) as ImpulseJoint as PrismaticImpulseJoint;
      spring.setContactsEnabled(false);
      spring.setLimits(-BOUNCY_SPRING.compress, BOUNCY_SPRING.stretch);
      spring.configureMotorModel(R.MotorModel.ForceBased);
      spring.setMotorMaxForce(BOUNCY_SPRING.maxForce);
      spring.configureMotorPosition(0, BOUNCY_SPRING.stiffness, BOUNCY_SPRING.damping);
      springs.push(spring);
      continue;
    }
    if (b.type === 'piston') {
      // ピストン:伸びる向き(指定がなければ付けた面の向き = 親から離れる向き)に、0〜1マス分だけスライドする
      const [dx, dy, dz] = FACE_DIR[pistonDirection(b)];
      const pdata = R.JointData.prismatic(anchor1, anchor2, { x: dx, y: dy, z: dz });
      const piston = world.createImpulseJoint(pdata, bodies[segmentOf[parent]], bodies[segmentOf[b.id]], true) as ImpulseJoint as PrismaticImpulseJoint;
      piston.setContactsEnabled(false);
      piston.setLimits(0, CREATURE.pistonStroke);
      piston.configureMotorModel(R.MotorModel.ForceBased);
      piston.setMotorMaxForce(CREATURE.pistonMaxForce);
      piston.configureMotorPosition(0, CREATURE.pistonStiffness, CREATURE.pistonDamping);
      pistons.push(piston);
      pistonBlockIds.push(b.id);
      continue;
    }
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

  return { blueprint: bp, bodies, joints, jointBlockIds, pistons, pistonBlockIds, springs, floats, segmentOf, localOffsets };
}

/** 円柱(Rapier では軸がローカルの Y)を、指定した軸の向きに回す */
/** √(1/2) */
const H = 0.7071067811865476;
const CYLINDER_ROTATION: Record<Axis, { x: number; y: number; z: number; w: number }> = {
  x: { x: 0, y: 0, z: -H, w: H },
  y: { x: 0, y: 0, z: 0, w: 1 },
  z: { x: H, y: 0, z: 0, w: H },
};

/**
 * ブロックごとの力をかける(物理ステップの直前に毎回呼ぶ)。いまは浮力ブロックの上向きの力だけ。
 * Rapier の力は呼ぶまで残り続け、かけた位置もワールド座標で固定されるので、毎ステップかけ直す
 */
export function applyBlockForces(creature: Creature): void {
  if (creature.floats.length === 0) return;
  const reset = new Set<number>();
  for (const f of creature.floats) {
    const body = creature.bodies[f.body];
    if (!reset.has(f.body)) {
      // 力とトルクは別々に残るので、両方を消してからかけ直す
      body.resetForces(true);
      body.resetTorques(true);
      reset.add(f.body);
    }
    const t = body.translation();
    const [x, y, z] = rotate(body.rotation(), f.local[0], f.local[1], f.local[2]);
    body.addForceAtPoint({ x: 0, y: FLOAT_BLOCK.lift, z: 0 }, { x: t.x + x, y: t.y + y, z: t.z + z }, true);
  }
}

/** 動かせるブロックの数(関節 + ピストン) */
export function actuatorsOf(creature: Creature): number {
  return creature.joints.length + creature.pistons.length;
}

/**
 * 関節とピストンの目標を設定する。targets の並びは「関節 → ピストン」で、値は -1〜1。
 * 関節は可動範囲 ±jointLimit の角度に対応し、ピストンは 0 以上なら伸ばし、0 未満なら縮める
 */
export function setJointTargets(creature: Creature, targets: ArrayLike<number>): void {
  creature.joints.forEach((joint, i) => {
    const t = Math.max(-1, Math.min(1, targets[i]));
    joint.configureMotorPosition(t * CREATURE.jointLimit, CREATURE.jointStiffness, CREATURE.jointDamping);
  });
  const n = creature.joints.length;
  creature.pistons.forEach((piston, i) => {
    const extend = targets[n + i] >= 0;
    piston.configureMotorPosition(extend ? CREATURE.pistonStroke : 0, CREATURE.pistonStiffness, CREATURE.pistonDamping);
  });
}

/**
 * 関節とピストンの状態を -1〜1 程度にそろえた値(運動脳の入力)。並びは「関節 → ピストン」。
 * 関節は角度/可動範囲と角速度、ピストンは伸び(縮み -1 〜 伸び 1)と伸びる速さ
 */
export function actuatorStates(creature: Creature): { position: number; velocity: number }[] {
  const joints = jointStates(creature).map((s) => ({ position: s.angle / CREATURE.jointLimit, velocity: s.velocity / BRAIN.jointVelScale }));
  const pistons = pistonStates(creature).map((s) => ({
    position: (2 * s.extension) / CREATURE.pistonStroke - 1,
    velocity: s.velocity / BRAIN.pistonVelScale,
  }));
  return [...joints, ...pistons];
}

/** ピストンの伸び [m] と伸びる速さ [m/s](親の剛体から見た、付けた面の向きの成分) */
export function pistonStates(creature: Creature): { extension: number; velocity: number }[] {
  return creature.pistons.map((piston, i) => {
    const b = creature.blueprint.blocks[creature.pistonBlockIds[i]];
    const [dx, dy, dz] = FACE_DIR[pistonDirection(b)];
    const b1 = piston.body1();
    const b2 = piston.body2();
    const q1 = b1.rotation();
    const l1 = piston.anchor1();
    const l2 = piston.anchor2();
    const a1 = rotate(q1, l1.x, l1.y, l1.z);
    const a2 = rotate(b2.rotation(), l2.x, l2.y, l2.z);
    const p1 = b1.translation();
    const p2 = b2.translation();
    const axis = rotate(q1, dx, dy, dz);
    const ex = p2.x + a2[0] - (p1.x + a1[0]);
    const ey = p2.y + a2[1] - (p1.y + a1[1]);
    const ez = p2.z + a2[2] - (p1.z + a1[2]);
    const v1 = b1.linvel();
    const v2 = b2.linvel();
    return {
      extension: ex * axis[0] + ey * axis[1] + ez * axis[2],
      velocity: (v2.x - v1.x) * axis[0] + (v2.y - v1.y) * axis[1] + (v2.z - v1.z) * axis[2],
    };
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
