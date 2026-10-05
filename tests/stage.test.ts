import { beforeAll, describe, expect, it } from 'vitest';
import { decisionGenomeLength, decisionInputs, EYE_OFFSETS } from '../src/core/brain/decision';
import { createMotorGenome } from '../src/core/brain/motor';
import { BRAIN, STAGE } from '../src/core/config';
import { QUADRUPED } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { Fighter } from '../src/core/sim/fighter';
import { MatchEpisode } from '../src/core/sim/match';
import { hexDistance, hexesWithin, hexToWorld, rotateHex, worldToHex } from '../src/core/stage/hex';
import { randomInterval, Stage } from '../src/core/stage/stage';

describe('六角グリッド', () => {
  it('半径6のステージは127枚', () => {
    expect(hexesWithin(6).length).toBe(127);
    expect(hexesWithin(2).length).toBe(19);
  });

  it('タイル中心の座標と、座標からタイルへの変換が往復する', () => {
    for (const h of hexesWithin(6)) {
      const { x, z } = hexToWorld(h, 0.6);
      expect(worldToHex(x, z, 0.6)).toEqual(h);
      // 中心から少しずれても同じタイル
      expect(worldToHex(x + 0.2, z - 0.2, 0.6)).toEqual(h);
    }
  });

  it('隣のタイルとの距離は1、中心間の距離は √3 × 外接半径', () => {
    const a = { q: 0, r: 0 };
    const b = { q: 1, r: -1 };
    expect(hexDistance(a, b)).toBe(1);
    const pa = hexToWorld(a, 0.6);
    const pb = hexToWorld(b, 0.6);
    expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeCloseTo(Math.sqrt(3) * 0.6, 12);
  });

  it('60°回転を6回すると元に戻り、距離は変わらない', () => {
    const h = { q: 3, r: -1 };
    expect(rotateHex(h, 6)).toEqual(h);
    for (let k = 0; k < 6; k++) expect(hexDistance(rotateHex(h, k), { q: 0, r: 0 })).toBe(3);
  });
});

describe('崩落ルール', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  const newStage = (seed = 1, pace = 1) => {
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    return { world, stage: new Stage(R, world, seed, { rules: true, pace }) };
  };
  const tick = (stage: Stage, seconds: number, occupants: { x: number; z: number }[] = []) => {
    for (let i = 0; i < Math.round(seconds / 0.05); i++) stage.update(0.05, occupants);
  };

  it('最終地点は中心から4以内で、最初の安全半径は最も遠いタイルまでの距離', () => {
    for (let seed = 1; seed < 20; seed++) {
      const { world, stage } = newStage(seed);
      expect(hexDistance(stage.finalPoint, { q: 0, r: 0 })).toBeLessThanOrEqual(STAGE.finalPointMaxDist);
      expect(stage.initialSafeRadius).toBe(Math.max(...stage.tiles.map((t) => hexDistance(t, stage.finalPoint))));
      world.free();
    }
  });

  it('ルールA:10秒後から8秒ごとに安全半径が1ずつ縮み、円の外は危険になってから崩落する', () => {
    const { world, stage } = newStage(3);
    const r0 = stage.safeRadius;
    tick(stage, 9.9);
    expect(stage.safeRadius).toBe(r0);
    tick(stage, 0.2);
    expect(stage.safeRadius).toBe(r0 - 1);
    const outside = stage.tiles.filter((t) => hexDistance(t, stage.finalPoint) > r0 - 1);
    expect(outside.length).toBeGreaterThan(0);
    for (const t of outside) expect(t.state).toBe('warning');
    tick(stage, 2.0);
    for (const t of outside) expect(t.state).toBe('collapsed');
    tick(stage, 8);
    expect(stage.safeRadius).toBe(r0 - 2);
    world.free();
  });

  it('ルールA:安全半径は1より小さくならない', () => {
    const { world, stage } = newStage(5);
    tick(stage, 200);
    expect(stage.safeRadius).toBe(STAGE.minSafeRadius);
    world.free();
  });

  it('ルールB:3秒滞在すると危険になり、離れると半分の速さで減る', () => {
    const { world, stage } = newStage(7);
    const t = stage.tiles.find((x) => x.q === 0 && x.r === 0)!;
    tick(stage, 2.0, [{ x: t.x, z: t.z }]);
    expect(t.stay).toBeCloseTo(2.0, 6);
    expect(t.state).toBe('safe');
    tick(stage, 2.0);
    expect(t.stay).toBeCloseTo(1.0, 6);
    tick(stage, 2.05, [{ x: t.x, z: t.z }]);
    expect(t.state).toBe('warning');
    world.free();
  });

  it('ルールC:20秒後からランダム崩落が始まり、間隔は4秒から90秒時点の1秒へ短くなる', () => {
    expect(randomInterval(20)).toBe(4);
    expect(randomInterval(55)).toBeCloseTo(2.5, 9);
    expect(randomInterval(90)).toBe(1);
    expect(randomInterval(200)).toBe(1);
    // 安全円の縮小が起きない「中心」をずっと見ていても、20秒後には安全円の内側に危険マークが出る
    const { world, stage } = newStage(9);
    tick(stage, 19.9);
    const inside = () => stage.tiles.filter((t) => t.state !== 'safe' && !stage.isOutsideSafe(t)).length;
    expect(inside()).toBe(0);
    tick(stage, 0.2);
    expect(inside()).toBe(1);
    world.free();
  });

  it('レベルのペースが速いほど早く縮む', () => {
    const slow = newStage(11, 0.6);
    const fast = newStage(11, 1.5);
    tick(slow.stage, 12);
    tick(fast.stage, 12);
    expect(fast.stage.safeRadius).toBeLessThan(slow.stage.safeRadius);
    slow.world.free();
    fast.world.free();
  });

  it('目が読む値:安全 0、危険 0.5〜1、穴 -1', () => {
    const { world, stage } = newStage(13);
    const t = stage.tiles[60];
    expect(stage.dangerAt(t.x, t.z)).toBe(0);
    expect(stage.dangerAt(100, 100)).toBe(-1);
    tick(stage, 3.05, [{ x: t.x, z: t.z }]);
    expect(stage.dangerAt(t.x, t.z)).toBeGreaterThanOrEqual(0.5);
    tick(stage, 2.5);
    expect(stage.dangerAt(t.x, t.z)).toBe(-1);
    world.free();
  });
});

describe('判断脳の入力と試合', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  it('目は19点、入力は35個', () => {
    expect(EYE_OFFSETS.length).toBe(19);
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const stage = new Stage(R, world, 1, { rules: true });
    const f = new Fighter(R, world, QUADRUPED, createMotorGenome(4, new Rng(1)), { position: { x: 0, y: 1, z: 0 }, yaw: 0.3 });
    const x = new Float64Array(BRAIN.decisionInputs).fill(NaN);
    decisionInputs({ self: f, opponent: null, stage, time: 0 }, x);
    for (const v of x) expect(Number.isFinite(v)).toBe(true);
    world.free();
  });

  const fighter = (seed: number, controller: 'brain' | 'rush' = 'brain') => {
    const rng = new Rng(seed);
    const decision = new Float64Array(decisionGenomeLength());
    for (let i = 0; i < decision.length; i++) decision[i] = rng.gaussian() * 0.3;
    return { blueprint: QUADRUPED, motor: createMotorGenome(4, rng), decision, controller };
  };

  it('同じシードなら試合結果が完全に一致する', () => {
    const run = () => {
      const m = new MatchEpisode(R, { mode: 'battle', seed: 42, fighters: [fighter(1), fighter(2, 'rush')], timeLimit: 40 });
      m.run();
      const r = m.matchResult();
      const p = m.fighters.map((f) => f.position());
      m.free();
      return { r, p };
    };
    const a = run();
    expect(run()).toEqual(a);
    expect(a).toMatchSnapshot();
  });

  it('2体は中心を挟んで反対側に、中心を向いて置かれる', () => {
    const m = new MatchEpisode(R, { mode: 'battle', seed: 5, fighters: [fighter(1), fighter(2)] });
    const [a, b] = m.fighters.map((f) => f.position());
    expect(a.x + b.x).toBeCloseTo(0, 6);
    expect(a.z + b.z).toBeCloseTo(0, 6);
    expect(Math.hypot(a.x, a.z)).toBeCloseTo(STAGE.spawnDistance * Math.sqrt(3) * STAGE.tileCircumradius, 6);
    const h = m.fighters[0].heading();
    expect(h.fx * -a.x + h.fz * -a.z).toBeGreaterThan(0.99 * Math.hypot(a.x, a.z));
    m.free();
  });

  it('時間切れは引き分け、脱落したら負け', () => {
    // 関節を動かさない2体は動かないので、崩落に巻き込まれるまで残る
    const still = () => ({ ...fighter(1), motor: new Float64Array(createMotorGenome(4, new Rng(1)).length), controller: 'rush' as const });
    const m = new MatchEpisode(R, { mode: 'battle', seed: 8, fighters: [still(), still()], timeLimit: 5 });
    m.run();
    expect(m.matchResult()!.winner).toBeNull();
    m.free();

    const m2 = new MatchEpisode(R, { mode: 'battle', seed: 8, fighters: [still(), still()] });
    m2.run();
    const r = m2.matchResult()!;
    expect(r.outAt.some((t) => t !== null)).toBe(true);
    if (r.winner !== null) expect(r.outAt[r.winner]).toBeNull();
    m2.free();
  });
});
