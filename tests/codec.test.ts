import { describe, expect, it } from 'vitest';
import { createDecisionGenome } from '../src/core/brain/decision';
import { createMotorGenome } from '../src/core/brain/motor';
import { newCharacter } from '../src/core/character';
import { base64ToBytes, bytesToBase64, characterToJson, decodeWeights, encodeWeights, parseCharacter } from '../src/core/codec';
import { totalCost } from '../src/core/creature/blueprint';
import { QUADRUPED } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';

const sample = () => {
  const c = newCharacter('ころがりくん', QUADRUPED);
  c.motor = createMotorGenome(4, new Rng(1));
  c.decision = createDecisionGenome(new Rng(2));
  c.progress = { passed: ['move', 'chase'], generations: { move: 140, chase: 85 } };
  return c;
};

describe('キャラのJSON', () => {
  it('base64 の往復(長さの余りが 0・1・2 のすべて)', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
    expect(bytesToBase64(new TextEncoder().encode('Man'))).toBe('TWFu');
  });

  it('重みは float16 なので、エンコードしても値が変わらない', () => {
    const w = createMotorGenome(4, new Rng(3));
    expect([...decodeWeights(encodeWeights(w))]).toEqual([...w]);
  });

  it('キャラの往復で、体・脳・育成状況が一致する', () => {
    const c = sample();
    const json = characterToJson(c);
    expect(json.version).toBe(7);
    expect(json.brains.motor!.inputs).toBe(26);
    expect(json.brains.motor!.outputs).toBe(4);
    expect(json.brains.decision!.inputs).toBe(77);
    const back = parseCharacter(JSON.stringify(json));
    expect(back.name).toBe(c.name);
    expect(back.blueprint).toEqual(c.blueprint);
    expect([...back.motor!]).toEqual([...c.motor!]);
    expect([...back.decision!]).toEqual([...c.decision!]);
    expect(back.progress).toEqual(c.progress);
  });

  it('脳がないキャラも扱える', () => {
    const c = newCharacter('まだ', QUADRUPED);
    const back = parseCharacter(characterToJson(c));
    expect(back.motor).toBeNull();
    expect(back.decision).toBeNull();
  });

  it('不正なデータは拒否する', () => {
    const good = characterToJson(sample());
    const bad = (mut: (j: ReturnType<typeof characterToJson>) => void) => {
      const j = structuredClone(good);
      mut(j);
      return () => parseCharacter(j);
    };
    expect(bad((j) => (j.version = 99))).toThrow('バージョン');
    expect(bad((j) => (j.blueprint.blocks[1].type = 'rocket' as never))).toThrow('種類');
    expect(bad((j) => (j.blueprint.blocks[1].parent = 5))).toThrow();
    expect(bad((j) => (j.brains.motor!.weights = j.brains.motor!.weights.slice(0, 40)))).toThrow('重みの数');
    expect(bad((j) => (j.brains.decision!.weights = '!!!'))).toThrow('base64');
    // 関節が上限を超える体
    expect(
      bad((j) => {
        for (let i = 0; i < 9; i++)
          j.blueprint.blocks.push({ id: j.blueprint.blocks.length, type: 'joint', parent: j.blueprint.blocks.length - 1, face: '+y', axis: 'x' });
      }),
    ).toThrow();
    expect(() => parseCharacter('not json')).toThrow();
  });

  it('知らない合格メニューや不正な世代数は取り除く', () => {
    const j = characterToJson(sample());
    (j.progress as unknown as { passed: string[] }).passed.push('fly');
    (j.progress.generations as Record<string, number>).move = -5;
    const back = parseCharacter(j);
    expect(back.progress.passed).toEqual(['move', 'chase']);
    expect(back.progress.generations.move).toBeUndefined();
  });
});

describe('試合のリプレイ', () => {
  it('シードと両キャラのデータが往復で一致し、判断脳のない相手は突進BOTになる', async () => {
    const { replayToJson, parseReplay } = await import('../src/storage/share');
    const me = sample();
    const rec = {
      seed: 12345,
      names: ['わたし', '突進BOT'] as [string, string],
      fighters: [
        { blueprint: me.blueprint, motor: me.motor!, decision: me.decision, controller: 'brain' as const },
        { blueprint: me.blueprint, motor: me.motor!, decision: null, controller: 'rush' as const },
      ] as [ReturnType<typeof Object>, ReturnType<typeof Object>],
    };
    const back = parseReplay(replayToJson(rec as never));
    expect(back.seed).toBe(12345);
    expect(back.names).toEqual(['わたし', '突進BOT']);
    expect([...back.fighters[0].decision!]).toEqual([...me.decision!]);
    expect(back.fighters[1].controller).toBe('rush');
    expect(() => parseReplay('{"kind":"other"}')).toThrow();
  });
});

describe('形式の移行', () => {
  it('2 → 3:運動脳にジャンプ指令の入力を足しても、ジャンプ指令が0なら同じ出力', async () => {
    const { mlpForward } = await import('../src/core/brain/mlp');
    const { motorShape } = await import('../src/core/brain/motor');
    // version 2 の運動脳(入力 17 + 8 = 25)を作る
    const from = { inputs: 25, hidden: 32, outputs: 4 };
    const { mlpInit, mlpParamCount } = await import('../src/core/brain/mlp');
    const { roundF16Array } = await import('../src/core/brain/f16');
    const g2 = new Float64Array(mlpParamCount(from) + 1);
    mlpInit(from, new Rng(22), g2, 0);
    g2[g2.length - 1] = 0.25;
    roundF16Array(g2);
    const v2 = { ...characterToJson(sample()), version: 2 };
    v2.brains.motor = { inputs: 25, hidden: 32, outputs: 4, rhythmPeriod: 1, weights: encodeWeights(g2) };
    v2.brains.decision = null;
    const c = parseCharacter(v2);
    expect(c.motor!.length).toBe(mlpParamCount(motorShape(4)) + 1);
    expect(c.motor![c.motor!.length - 1]).toBe(0.25); // リズム周期の遺伝子は最後のまま
    const rng = new Rng(5);
    const x = Array.from({ length: 25 }, () => rng.range(-1, 1));
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    mlpForward(from, g2, 0, x, new Float64Array(32), a);
    mlpForward(motorShape(4), c.motor!, 0, [...x, 0], new Float64Array(32), b);
    expect([...b]).toEqual([...a]);
  });

  it('移行した判断脳は、増えたマスの値に関係なく古い脳と同じ出力になる(1 → 2 → 3)', async () => {
    const { mlpForward, mlpInit } = await import('../src/core/brain/mlp');
    const { DECISION_SHAPE, EYE_HEXES } = await import('../src/core/brain/decision');
    const { hexesWithin } = await import('../src/core/stage/hex');
    const { roundF16Array } = await import('../src/core/brain/f16');
    const oldShape = { inputs: 35, hidden: DECISION_SHAPE.hidden, outputs: 3 };
    const oldW = new Float64Array(24 * 35 + 24 + 3 * 24 + 3);
    mlpInit(oldShape, new Rng(9), oldW, 0);
    for (let i = 24 * 35; i < 24 * 35 + 24; i++) oldW[i] = 0.1; // バイアスも移ることを確かめる
    roundF16Array(oldW);
    const v1 = { ...characterToJson(sample()), version: 1 };
    v1.brains.decision = { inputs: 35, hidden: 24, outputs: 3, weights: encodeWeights(oldW) };
    v1.brains.motor = null; // この確認では判断脳だけを見る
    const c = parseCharacter(v1);
    expect(c.decision!.length).toBe(24 * 77 + 24 + 4 * 24 + 4);

    const rng = new Rng(4);
    const oldEye = hexesWithin(2);
    for (let trial = 0; trial < 5; trial++) {
      const oldIn = Array.from({ length: 35 }, () => rng.range(-1, 1));
      const newIn = Array.from({ length: 77 }, () => rng.range(-1, 1)); // 増えたマスはでたらめな値
      oldEye.forEach((h, i) => (newIn[EYE_HEXES.findIndex((e) => e.q === h.q && e.r === h.r)] = oldIn[i]));
      for (let i = 19; i < 35; i++) newIn[61 + (i - 19)] = oldIn[i];
      const a = new Float64Array(3);
      const b = new Float64Array(4);
      mlpForward(oldShape, oldW, 0, oldIn, new Float64Array(24), a);
      mlpForward(DECISION_SHAPE, c.decision!, 0, newIn, new Float64Array(24), b);
      // もとの3つの出力は同じで、増えたジャンプ指令の出力は 0(跳ばない)
      expect([...b.subarray(0, 3)]).toEqual([...a]);
      expect(b[3]).toBe(0);
    }
    expect(characterToJson(c).version).toBe(7);
  });
});

describe('形式4:形・摩擦オン・グリップの置き換え', () => {
  it('古いグリップブロックは「基礎 + 摩擦オン」になり、コストは変わらない', () => {
    const old = {
      version: 3,
      name: 'old',
      blueprint: {
        blocks: [
          { id: 0, type: 'core', parent: null },
          { id: 1, type: 'grip', parent: 0, face: '-y' },
        ],
      },
      brains: { motor: null, decision: null },
      progress: { passed: [], generations: {} },
    };
    const c = parseCharacter(old);
    expect(c.blueprint.blocks[1]).toEqual({ id: 1, type: 'base', parent: 0, face: '-y', grip: true });
    expect(totalCost(c.blueprint)).toBe(2);
  });

  it('古い浮力ブロックは、下向きに吹く風ブロックになる', () => {
    const c = parseCharacter({
      version: 4,
      name: 'float',
      blueprint: {
        blocks: [
          { id: 0, type: 'core', parent: null },
          { id: 1, type: 'float', parent: 0, face: '-y' },
          { id: 2, type: 'float', parent: 0, face: '+x' },
        ],
      },
      brains: { motor: null, decision: null },
      progress: { passed: [], generations: {} },
    });
    expect(c.blueprint.blocks[1]).toEqual({ id: 1, type: 'wind', parent: 0, face: '-y' });
    expect(c.blueprint.blocks[2]).toEqual({ id: 2, type: 'wind', parent: 0, face: '+x', dir: '-y' });
  });

  it('形と摩擦オンは保存して読み直しても同じ。既定の値はデータに入れない', () => {
    const c = parseCharacter({
      version: 5,
      name: 'shapes',
      blueprint: {
        blocks: [
          { id: 0, type: 'core', parent: null, shape: 'sphere' },
          { id: 1, type: 'cloud', parent: 0, face: '+x', shape: 'cylinder', grip: true },
          { id: 2, type: 'wind', parent: 0, face: '-x', shape: 'cube', grip: false },
        ],
      },
      brains: { motor: null, decision: null },
      progress: { passed: [], generations: {} },
    });
    expect(c.blueprint.blocks[2]).toEqual({ id: 2, type: 'wind', parent: 0, face: '-x' });
    const again = parseCharacter(JSON.parse(JSON.stringify(characterToJson(c))));
    expect(again.blueprint).toEqual(c.blueprint);
    expect(() =>
      parseCharacter({
        version: 4,
        name: 'bad',
        blueprint: { blocks: [{ id: 0, type: 'core', parent: null, shape: 'cone' }] },
        brains: { motor: null, decision: null },
        progress: { passed: [], generations: {} },
      }),
    ).toThrow();
  });
});

describe('形式6:円柱の向きとタイヤモード', () => {
  it('円柱の向きとタイヤは保存して読み直しても同じ。形式5のデータもそのまま読める', () => {
    const c = parseCharacter({
      version: 5,
      name: 'wheel',
      blueprint: {
        blocks: [
          { id: 0, type: 'core', parent: null },
          { id: 1, type: 'joint', parent: 0, face: '-y', axis: 'x', shape: 'cylinder', tire: true },
          { id: 2, type: 'base', parent: 0, face: '+z', shape: 'cylinder', cylAxis: 'y' },
        ],
      },
      brains: { motor: null, decision: null },
      progress: { passed: [], generations: {} },
    });
    expect(c.blueprint.blocks[1].tire).toBe(true);
    expect(c.blueprint.blocks[2].cylAxis).toBe('y');
    const again = parseCharacter(JSON.parse(JSON.stringify(characterToJson(c))));
    expect(again.blueprint).toEqual(c.blueprint);
  });
});
