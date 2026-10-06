// 改善②で追加したメニューとブロックのテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { createDecisionGenome } from '../src/core/brain/decision';
import { createMotorGenome, motorGenomeLength } from '../src/core/brain/motor';
import { PHYSICS, SENSOR, STAGE } from '../src/core/config';
import type { Blueprint } from '../src/core/creature/blueprint';
import { QUADRUPED } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { MatchEpisode } from '../src/core/sim/match';
import { Stage } from '../src/core/stage/stage';
import { JumpEpisode } from '../src/core/training/jump';
import { MoveEpisode } from '../src/core/training/move';
import { isUnlocked } from '../src/core/training/tasks';

describe('メニューの解放順', () => {
  it('移動 → 追跡 →(ジャンプ・穴・回避)、回避 → 生き残り → 押し合い → ライバル', () => {
    expect(isUnlocked('move', [])).toBe(true);
    expect(isUnlocked('avoid', ['move'])).toBe(false);
    expect(isUnlocked('avoid', ['move', 'chase'])).toBe(true);
    expect(isUnlocked('jump', ['move', 'chase'])).toBe(true);
    expect(isUnlocked('survive', ['move', 'chase'])).toBe(false);
    expect(isUnlocked('survive', ['move', 'chase', 'avoid'])).toBe(true);
    expect(isUnlocked('rival', ['move', 'chase', 'avoid', 'survive'])).toBe(false);
    expect(isUnlocked('rival', ['move', 'chase', 'avoid', 'survive', 'push'])).toBe(true);
  });

  it('一度合格したメニューは、前提が増えても開いたまま', () => {
    expect(isUnlocked('survive', ['move', 'chase', 'survive'])).toBe(true);
  });
});

describe('危険なタイルを避ける(崩れないステージ)', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  it('崩れたタイルは床として残り、目や足元には穴として見える', () => {
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const stage = new Stage(R, world, 3, { rules: true, solid: true });
    for (let i = 0; i < 400; i++) stage.update(0.05, []);
    const collapsed = stage.tiles.filter((t) => t.state === 'collapsed');
    expect(collapsed.length).toBeGreaterThan(0);
    const t = collapsed[0];
    expect(stage.isHole(t.x, t.z)).toBe(true);
    // 床が残っているので、上に置いた箱は落ちない
    const box = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(t.x, 0.5, t.z));
    world.createCollider(R.ColliderDesc.cuboid(0.15, 0.15, 0.15), box);
    for (let i = 0; i < 120; i++) world.step();
    expect(box.translation().y).toBeGreaterThan(0);
    world.free();
  });

  it('動かないキャラは崩れたはずのタイルに触れ続け、合格しない', () => {
    const still = { blueprint: QUADRUPED, motor: new Float64Array(motorGenomeLength(4)), decision: createDecisionGenome(new Rng(1)), controller: 'brain' as const };
    const m = new MatchEpisode(R, { mode: 'avoid', seed: 5, fighters: [still] });
    const o = m.run();
    expect(o.time).toBeGreaterThanOrEqual(59.9);
    expect(o.metric).toBeGreaterThan(STAGE.stayLimit);
    expect(o.success).toBe(false);
    m.free();
  });
});

describe('センサーブロックとジャンプ', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  it('センサーが地面に触れていると、トレーニングで減点される', () => {
    const withSensor: Blueprint = { blocks: [...QUADRUPED.blocks, { id: 11, type: 'sensor', parent: 0, face: '-y' }] };
    const plain: Blueprint = { blocks: [...QUADRUPED.blocks, { id: 11, type: 'base', parent: 0, face: '-y' }] };
    const motor = new Float64Array(motorGenomeLength(4));
    const run = (bp: Blueprint) => {
      const ep = new MoveEpisode(R, bp, motor, 7);
      const o = ep.run();
      ep.free();
      return o.reward;
    };
    // 腹にセンサーを付けると、地面に触れている時間(15秒)ぶん減点される
    const diff = run(plain) - run(withSensor);
    expect(diff).toBeGreaterThan(SENSOR.penaltyPerSec * 10);
  });

  it('ジャンプは4回測り、関節を動かさない脳ではほとんど上がらない', () => {
    const ep = new JumpEpisode(R, QUADRUPED, new Float64Array(motorGenomeLength(4)), 1);
    const o = ep.run();
    expect(ep.jumpHeights().length).toBe(4);
    expect(o.metric).toBeLessThan(0.05);
    expect(o.success).toBe(false);
    ep.free();
  });

  it('同じ遺伝子・同じシードならジャンプの結果も一致する', () => {
    const g = createMotorGenome(4, new Rng(3));
    const run = () => {
      const ep = new JumpEpisode(R, QUADRUPED, g, 2);
      const o = ep.run();
      ep.free();
      return o;
    };
    expect(run()).toEqual(run());
    void PHYSICS;
  });
});
