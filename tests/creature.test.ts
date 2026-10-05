import { beforeAll, describe, expect, it } from 'vitest';
import { BLOCKS, CREATURE, PHYSICS } from '../src/core/config';
import { jointStates, setJointTargets, spawnCreature } from '../src/core/creature/assemble';
import {
  centerOfMass,
  jointCount,
  segmentsOf,
  totalCost,
  validate,
  type BlockSpec,
  type Blueprint,
} from '../src/core/creature/blueprint';
import { QUADRUPED } from '../src/core/creature/samples';
import { sin } from '../src/core/math/fmath';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { StateHasher } from '../src/core/sim/hash';

const core: BlockSpec = { id: 0, type: 'core', parent: null };

/** コアから +z 方向に一直線に並べた設計図 */
function chain(types: BlockSpec['type'][]): Blueprint {
  return {
    blocks: [
      core,
      ...types.map((type, i) => ({
        id: i + 1,
        type,
        parent: i,
        face: '+z' as const,
        ...(type === 'joint' ? { axis: 'y' as const } : {}),
      })),
    ],
  };
}

describe('設計図', () => {
  it('サンプルのコストと関節数', () => {
    expect(totalCost(QUADRUPED)).toBe(22);
    expect(jointCount(QUADRUPED)).toBe(4);
    expect(validate(QUADRUPED)).toEqual([]);
  });

  it('左右対称なキャラの重心は左右の中央にある', () => {
    const [x] = centerOfMass(QUADRUPED);
    expect(x).toBeCloseTo(0, 12);
  });

  it('コスト上限を超えると不正', () => {
    const bp = chain(Array(CREATURE.maxCost / BLOCKS.bouncy.cost + 1).fill('bouncy'));
    expect(validate(bp).some((e) => e.includes('コスト'))).toBe(true);
  });

  it('関節数の上限を超えると不正', () => {
    const bp = chain(Array(CREATURE.maxJoints + 1).fill('joint'));
    expect(validate(bp).some((e) => e.includes('関節数'))).toBe(true);
  });

  it('ブロック数の上限を超えると不正', () => {
    const bp = chain(Array(CREATURE.maxBlocks).fill('base'));
    expect(validate(bp).some((e) => e.includes('ブロック数'))).toBe(true);
  });

  it('同じ位置に重なると不正', () => {
    const bp: Blueprint = {
      blocks: [core, { id: 1, type: 'base', parent: 0, face: '+x' }, { id: 2, type: 'base', parent: 1, face: '-x' }],
    };
    expect(validate(bp).some((e) => e.includes('重なって'))).toBe(true);
  });

  it('親が自分より後ろのIDだと不正', () => {
    const bp: Blueprint = {
      blocks: [core, { id: 1, type: 'base', parent: 2, face: '+x' }, { id: 2, type: 'base', parent: 0, face: '-x' }],
    };
    expect(validate(bp).some((e) => e.includes('親が不正'))).toBe(true);
  });

  it('関節に回転軸がないと不正', () => {
    const bp: Blueprint = { blocks: [core, { id: 1, type: 'joint', parent: 0, face: '+x' }] };
    expect(validate(bp).some((e) => e.includes('回転軸'))).toBe(true);
  });

  it('コアがないと不正', () => {
    expect(validate({ blocks: [{ id: 0, type: 'base', parent: null }] }).length).toBeGreaterThan(0);
  });

  it('関節を挟まないブロックは1つの剛体にまとまる', () => {
    const { segments, segmentOf } = segmentsOf(QUADRUPED);
    expect(segments.map((s) => s.blocks)).toEqual([[0, 1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]);
    expect(segmentOf).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('剛体への組み立て', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  function newWorld(gravity: number = PHYSICS.gravity) {
    const world = new R.World({ x: 0, y: gravity, z: 0 });
    world.timestep = PHYSICS.dt;
    return world;
  }

  it('剛体と関節の数、総質量が設計図どおり', () => {
    const world = newWorld();
    const c = spawnCreature(R, world, QUADRUPED, { position: { x: 0, y: 1, z: 0 }, yaw: 0 });
    expect(c.bodies.length).toBe(5);
    expect(c.joints.length).toBe(4);
    expect(c.jointBlockIds).toEqual([3, 5, 7, 9]);
    const mass = c.bodies.reduce((s, b) => s + b.mass(), 0);
    const expected = QUADRUPED.blocks.reduce((s, b) => s + BLOCKS[b.type].mass, 0);
    expect(mass).toBeCloseTo(expected, 4);
    world.free();
  });

  it('向き(yaw)を指定すると体ごと回転して配置される', () => {
    const world = newWorld();
    const c = spawnCreature(R, world, QUADRUPED, { position: { x: 0, y: 1, z: 0 }, yaw: Math.PI / 2 });
    // ブロック3(関節)はコア基準で (+1, 0, +1) マス。yaw=90° でワールドの (+1, 0, -1) マスへ
    const t = c.bodies[1].translation();
    const s = CREATURE.blockSize;
    expect(t.x).toBeCloseTo(s, 6);
    expect(t.y).toBeCloseTo(1, 6);
    expect(t.z).toBeCloseTo(-s, 6);
    world.free();
  });

  it('関節は目標角度に向かって動き、角度を読み取れる', () => {
    const world = newWorld(0);
    const c = spawnCreature(R, world, QUADRUPED, { position: { x: 0, y: 1, z: 0 }, yaw: 0.3 });
    const targets = [0.5, -0.5, 0.25, -0.25];
    setJointTargets(c, targets);
    for (let i = 0; i < 120; i++) world.step();
    jointStates(c).forEach((s, i) => {
      expect(s.angle).toBeCloseTo(targets[i] * CREATURE.jointLimit, 1);
      expect(Math.abs(s.velocity)).toBeLessThan(0.05);
    });
    world.free();
  });

  it('関節は可動範囲(±90°)を超えない', () => {
    const world = newWorld(0);
    const c = spawnCreature(R, world, QUADRUPED, { position: { x: 0, y: 1, z: 0 }, yaw: 0 });
    // 範囲外の目標角度はクランプされ、物理の制限でも止まる
    setJointTargets(c, [5, -5, 5, -5]);
    for (let i = 0; i < 240; i++) world.step();
    for (const s of jointStates(c)) expect(Math.abs(s.angle)).toBeLessThanOrEqual(CREATURE.jointLimit + 0.05);
    world.free();
  });

  it('床の上で関節を動かし続けても、同じ条件なら結果が完全に一致する', () => {
    const run = () => {
      const world = newWorld();
      world.createCollider(R.ColliderDesc.cuboid(10, 0.1, 10).setTranslation(0, -0.1, 0));
      const c = spawnCreature(R, world, QUADRUPED, { position: { x: 0, y: 0.8, z: 0 }, yaw: 0.7 });
      for (let step = 0; step < 600; step++) {
        if (step % PHYSICS.brainInterval === 0) {
          const t = step * PHYSICS.dt;
          setJointTargets(c, [sin(t * 6), sin(t * 6 + 1.5), sin(t * 6 + 3), sin(t * 6 + 4.5)]);
        }
        world.step();
      }
      const h = new StateHasher();
      for (const b of c.bodies) {
        const p = b.translation();
        const q = b.rotation();
        h.add(p.x).add(p.y).add(p.z).add(q.x).add(q.y).add(q.z).add(q.w);
      }
      world.free();
      return h.digest();
    };
    const first = run();
    expect(run()).toBe(first);
    expect(first).toMatchSnapshot();
  });
});
