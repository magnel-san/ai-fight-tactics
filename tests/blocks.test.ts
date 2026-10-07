// ブロックの形・摩擦オン・雲・風・弾力のばねのテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_OPTIONS, BLOCKS, BOUNCY_SPRING, CREATURE, PHYSICS, WIND_BLOCK } from '../src/core/config';
import { applyBlockForces, setJointTargets, spawnCreature, type Creature } from '../src/core/creature/assemble';
import { blockCost, cylinderAxis, segmentsOf, totalCost, validate, type BlockSpec, type Blueprint } from '../src/core/creature/blueprint';
import { addBlock, setBlockLook } from '../src/core/creature/edit';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { StateHasher } from '../src/core/sim/hash';

let R: Rapier;
beforeAll(async () => {
  R = await initRapier();
});

const core: BlockSpec = { id: 0, type: 'core', parent: null };

/** 床のあるワールドに体を置いて、steps ステップ進める */
function simulate(bp: Blueprint, steps: number, height = 1.0): { creature: Creature; hash: string; y: number; com: number } {
  const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
  world.timestep = PHYSICS.dt;
  world.createCollider(R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
  const creature = spawnCreature(R, world, bp, { position: { x: 0, y: height, z: 0 }, yaw: 0 });
  for (let i = 0; i < steps; i++) {
    applyBlockForces(creature);
    world.step();
  }
  const h = new StateHasher();
  for (const b of creature.bodies) {
    const t = b.translation();
    const r = b.rotation();
    for (const v of [t.x, t.y, t.z, r.x, r.y, r.z, r.w]) h.add(v);
  }
  const y = creature.bodies[0].translation().y;
  const com = creature.bodies[0].worldCom().y;
  const hash = h.digest();
  world.free();
  return { creature, hash, y, com };
}

describe('形と摩擦オン', () => {
  it('どの形でも置けて、同じ条件なら同じ結果になる', () => {
    for (const shape of ['cube', 'sphere', 'cylinder'] as const) {
      const bp: Blueprint = {
        blocks: [
          { ...core, shape },
          { id: 1, type: 'joint', parent: 0, face: '+x', axis: 'x', shape },
          { id: 2, type: 'base', parent: 0, face: '-y', shape, grip: true },
        ],
      };
      expect(validate(bp)).toEqual([]);
      const a = simulate(bp, 120);
      const b = simulate(bp, 120);
      expect(a.hash).toBe(b.hash);
      expect(Number.isFinite(a.y)).toBe(true);
    }
  });

  it('形が違うと転がり方が変わる(球は立方体と違う結果になる)', () => {
    const cube = simulate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '+x' }] }, 90);
    const ball = simulate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '+x', shape: 'sphere' }] }, 90);
    expect(ball.hash).not.toBe(cube.hash);
  });

  it('円柱の軸:関節は回転軸、ピストンは伸びる向き、ほかは付けた面の向き', () => {
    expect(cylinderAxis({ id: 1, type: 'joint', parent: 0, face: '+x', axis: 'z' })).toBe('z');
    expect(cylinderAxis({ id: 1, type: 'piston', parent: 0, face: '+x', dir: '-y' })).toBe('y');
    expect(cylinderAxis({ id: 1, type: 'base', parent: 0, face: '-z' })).toBe('z');
    expect(cylinderAxis(core)).toBe('y');
  });

  it('摩擦オンはコストが増え、上限を超えるならオンにできない', () => {
    expect(blockCost({ id: 1, type: 'base', parent: 0, face: '+x', grip: true })).toBe(BLOCKS.base.cost + BLOCK_OPTIONS.gripCost);
    let bp: Blueprint = { blocks: [core] };
    while (totalCost(bp) < CREATURE.maxCost) {
      const r = addBlock(bp, bp.blocks.length - 1, '+z', 'base');
      if (!r.ok) break;
      bp = r.blueprint;
    }
    expect(totalCost(bp)).toBe(Math.min(CREATURE.maxCost, CREATURE.maxBlocks - 1));
    if (totalCost(bp) === CREATURE.maxCost) expect(setBlockLook(bp, 1, { grip: true }).ok).toBe(false);
  });
});

describe('雲・風・弾力', () => {
  it('雲は基礎よりずっと軽い', () => {
    expect(BLOCKS.cloud.mass).toBeLessThan(BLOCKS.base.mass / 4);
  });

  it('風を下向きに吹くと、床の上では持ち上がる(たくさん付けると浮く)', () => {
    // コアの下に、風を十字に並べる(どれも下向きに吹く。左右前後対称なので傾かない)
    const plate: Blueprint = {
      blocks: [
        core,
        { id: 1, type: 'wind', parent: 0, face: '-y' },
        { id: 2, type: 'wind', parent: 1, face: '+x', dir: '-y' },
        { id: 3, type: 'wind', parent: 1, face: '-x', dir: '-y' },
        { id: 4, type: 'wind', parent: 1, face: '+z', dir: '-y' },
        { id: 5, type: 'wind', parent: 1, face: '-z', dir: '-y' },
      ],
    };
    const base = simulate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '-y' }] }, 120, 0.6);
    // 5つ:体の重さ(コア2kg + 5kg)より、床の近くでの持ち上げる力(5 × 1.5kg 分)が大きいので、床から浮く
    const hover = simulate(plate, 180, 0.6);
    expect(hover.y).toBeGreaterThan(base.y + 0.02);
    // でも床から離れるほど力が弱まるので、高くは上がらない
    expect(hover.y).toBeLessThan(base.y + WIND_BLOCK.groundRange);
  });

  it('下に床がなければ、風では持ち上がらない', () => {
    const bp: Blueprint = {
      blocks: [core, ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, type: 'wind' as const, parent: i, face: '+z' as const, dir: '-y' as const }))],
    };
    // 床から高いところ(持ち上げる力が届かない)に置くと、ふつうに落ちる
    const t = 20 / 60;
    const freeFall = 0.5 * -PHYSICS.gravity * t * t;
    const start = simulate(bp, 0, 10).com;
    const after = simulate(bp, 20, 10).com;
    expect(start - after).toBeGreaterThan(freeFall * 0.95);
  });

  it('風を横に吹くと、反対向きに押されて進む', () => {
    // 後ろ(-z)に吹く風:前(+z)に進む
    const bp: Blueprint = { blocks: [core, { id: 1, type: 'wind', parent: 0, face: '-z' }] };
    const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    world.timestep = PHYSICS.dt;
    world.createCollider(R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0).setFriction(0.1));
    const c = spawnCreature(R, world, bp, { position: { x: 0, y: 0.25, z: 0 }, yaw: 0 });
    for (let i = 0; i < 60; i++) {
      applyBlockForces(c);
      world.step();
    }
    expect(c.bodies[0].translation().z).toBeGreaterThan(0.3);
    world.free();
  });

  it('弾力ブロックはばねで別の剛体になり、落ちると縮む', () => {
    const bp: Blueprint = { blocks: [core, { id: 1, type: 'bouncy', parent: 0, face: '-y' }] };
    expect(segmentsOf(bp).segments.length).toBe(2);
    const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    world.timestep = PHYSICS.dt;
    world.createCollider(R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0));
    const c = spawnCreature(R, world, bp, { position: { x: 0, y: 1.5, z: 0 }, yaw: 0 });
    expect(c.springs.length).toBe(1);
    let minGap = Infinity;
    for (let i = 0; i < 120; i++) {
      world.step();
      // コアと弾力ブロックの距離(元は1マス)。縮むと短くなる
      const a = c.bodies[0].translation();
      const b = c.bodies[1].translation();
      minGap = Math.min(minGap, a.y - b.y);
    }
    expect(minGap).toBeLessThan(CREATURE.blockSize - 0.02);
    expect(minGap).toBeGreaterThan(CREATURE.blockSize - BOUNCY_SPRING.compress - 0.02);
    world.free();
  });
});

describe('円柱の向きとタイヤモード', () => {
  const wheelBody = (look: Partial<BlockSpec>): Blueprint => ({
    blocks: [core, { id: 1, type: 'joint', parent: 0, face: '-y', axis: 'x', shape: 'cylinder', ...look }],
  });

  it('円柱の向きを指定すると、自動の向きより優先される', () => {
    const b: BlockSpec = { id: 1, type: 'base', parent: 0, face: '+x', shape: 'cylinder' };
    expect(cylinderAxis(b)).toBe('x');
    expect(cylinderAxis({ ...b, cylAxis: 'y' })).toBe('y');
    expect(validate({ blocks: [core, { ...b, cylAxis: 'z' }] })).toEqual([]);
    // 円柱でないブロックには向きを付けられない
    expect(validate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '+x', cylAxis: 'z' }] }).length).toBeGreaterThan(0);
  });

  it('タイヤモードは円柱の関節だけで、コストが増える', () => {
    expect(validate(wheelBody({ tire: true }))).toEqual([]);
    expect(blockCost({ id: 1, type: 'joint', parent: 0, face: '-y', axis: 'x', shape: 'cylinder', tire: true })).toBe(
      BLOCKS.joint.cost + BLOCK_OPTIONS.tireCost,
    );
    expect(validate({ blocks: [core, { id: 1, type: 'joint', parent: 0, face: '-y', axis: 'x', tire: true }] }).length).toBeGreaterThan(0);
    expect(validate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '-y', shape: 'cylinder', tire: true }] }).length).toBeGreaterThan(0);
  });

  it('タイヤの周り(回転軸に垂直な4方向)に親以外のブロックがあると重なるので置けない', () => {
    // 軸 x のタイヤ(コアの下)。タイヤの前(+z)にブロックを付けると、タイヤの円と重なる
    const bp = wheelBody({ tire: true });
    expect(addBlock(bp, 1, '+z', 'base').ok).toBe(false);
    // 軸の向き(+x)なら重ならない
    expect(addBlock(bp, 1, '+x', 'base').ok).toBe(true);
    // すでに隣にブロックがあるとタイヤにできない
    const withNeighbor: Blueprint = {
      blocks: [...wheelBody({}).blocks, { id: 2, type: 'base', parent: 1, face: '+z' }],
    };
    expect(setBlockLook(withNeighbor, 1, { tire: true }).ok).toBe(false);
  });

  it('タイヤは半径が大きいので、同じ体でも高く立つ', () => {
    const normal = simulate(wheelBody({}), 120, 0.8);
    const tire = simulate(wheelBody({ tire: true }), 120, 0.8);
    expect(tire.y - normal.y).toBeGreaterThan(0.07);
    expect(tire.y - normal.y).toBeLessThan(0.13);
  });
});

describe('関節の360°回転', () => {
  /** 左右にタイヤを付けた体(回転軸 x)。spin で回り方を切り替える */
  const car = (spin: boolean): Blueprint => {
    const look = { shape: 'cylinder' as const, tire: true, ...(spin ? { spin: true } : {}) };
    return {
      blocks: [
        core,
        { id: 1, type: 'joint', parent: 0, face: '+x', axis: 'x', ...look },
        { id: 2, type: 'joint', parent: 0, face: '-x', axis: 'x', ...look },
        { id: 3, type: 'base', parent: 0, face: '-z', shape: 'sphere' },
      ],
    };
  };

  function drive(bp: Blueprint): number {
    const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    world.timestep = PHYSICS.dt;
    world.createCollider(R.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0));
    const c = spawnCreature(R, world, bp, { position: { x: 0, y: 0.35, z: 0 }, yaw: 0 });
    for (let i = 0; i < 180; i++) {
      setJointTargets(c, [1, 1]);
      world.step();
    }
    const p = c.bodies[0].translation();
    world.free();
    return Math.sqrt(p.x * p.x + p.z * p.z);
  }

  it('360°の関節は回り続けるので、タイヤで転がって進む。180°では進まない', () => {
    expect(validate(car(true))).toEqual([]);
    const spinDist = drive(car(true));
    const halfDist = drive(car(false));
    expect(spinDist).toBeGreaterThan(1.0);
    expect(halfDist).toBeLessThan(0.5);
  });

  it('360°は関節ブロックだけに使える', () => {
    expect(validate({ blocks: [core, { id: 1, type: 'base', parent: 0, face: '+x', spin: true }] }).length).toBeGreaterThan(0);
  });
});
