import { describe, expect, it } from 'vitest';
import { createDecisionGenome } from '../src/core/brain/decision';
import { createMotorGenome } from '../src/core/brain/motor';
import { newCharacter } from '../src/core/character';
import { base64ToBytes, bytesToBase64, characterToJson, decodeWeights, encodeWeights, parseCharacter } from '../src/core/codec';
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
    expect(json.version).toBe(1);
    expect(json.brains.motor!.inputs).toBe(25);
    expect(json.brains.motor!.outputs).toBe(4);
    expect(json.brains.decision!.inputs).toBe(35);
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
        for (let i = 0; i < 9; i++) j.blueprint.blocks.push({ id: j.blueprint.blocks.length, type: 'joint', parent: j.blueprint.blocks.length - 1, face: '+y', axis: 'x' });
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
