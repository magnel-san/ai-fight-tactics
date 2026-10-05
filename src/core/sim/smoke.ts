// 決定性の確認用シナリオ。シードから決めた位置・回転で箱を床に落とし、
// 関節モーターも動かして、一定ステップ後の全剛体の状態をハッシュにする。
// 本物の試合ループができるまで、Node とブラウザ間の一致確認に使う。
import { CREATURE, PHYSICS } from '../config';
import { cos, sin } from '../math/fmath';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { StateHasher } from './hash';

export function runSmokeSim(R: Rapier, seed: number, steps = 600): string {
  const rng = new Rng(seed);
  const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
  world.timestep = PHYSICS.dt;

  world.createCollider(R.ColliderDesc.cuboid(10, 0.1, 10).setTranslation(0, -0.1, 0));

  const bodies = [];
  for (let i = 0; i < 12; i++) {
    const yaw = rng.range(-Math.PI, Math.PI);
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(rng.range(-1, 1), 0.5 + i * 0.5, rng.range(-1, 1))
      .setRotation({ x: 0, y: sin(yaw / 2), z: 0, w: cos(yaw / 2) });
    const body = world.createRigidBody(desc);
    world.createCollider(
      R.ColliderDesc.cuboid(0.2, 0.2, 0.2).setFriction(rng.range(0.5, 2)).setRestitution(rng.range(0, 0.9)),
      body,
    );
    bodies.push(body);
  }

  // 2つの箱をヒンジでつなぎ、モーターで目標角度を振る(関節ブロックの代わり)
  const joint = world.createImpulseJoint(
    R.JointData.revolute({ x: 0.2, y: 0, z: 0 }, { x: -0.2, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
    bodies[0],
    bodies[1],
    true,
  ) as InstanceType<Rapier['RevoluteImpulseJoint']>;

  for (let step = 0; step < steps; step++) {
    if (step % PHYSICS.brainInterval === 0) {
      joint.configureMotorPosition(
        rng.range(-1, 1) * CREATURE.jointLimit,
        CREATURE.jointStiffness,
        CREATURE.jointDamping,
      );
    }
    world.step();
  }

  const h = new StateHasher();
  for (const b of bodies) {
    const t = b.translation();
    const r = b.rotation();
    const v = b.linvel();
    const w = b.angvel();
    h.add(t.x).add(t.y).add(t.z).add(r.x).add(r.y).add(r.z).add(r.w);
    h.add(v.x).add(v.y).add(v.z).add(w.x).add(w.y).add(w.z);
  }
  world.free();
  return h.digest();
}
