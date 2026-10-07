import { describe, expect, it } from 'vitest';
import { CREATURE } from '../src/core/config';
import { blockPositions, totalCost, validate, type Blueprint } from '../src/core/creature/blueprint';
import {
  addBlock,
  addBlockSymmetric,
  blockAt,
  emptyBlueprint,
  removeBlock,
  removeBlockSymmetric,
  setJointAxisSymmetric,
  type EditResult,
} from '../src/core/creature/edit';
import { QUADRUPED } from '../src/core/creature/samples';

function ok(r: EditResult): Blueprint {
  if (!r.ok) throw new Error(r.errors.join(' / '));
  return r.blueprint;
}

describe('設計図の編集', () => {
  it('ブロックを追加すると末尾に新しいIDで付く', () => {
    const bp = ok(addBlock(emptyBlueprint(), 0, '+x', 'base'));
    expect(bp.blocks).toEqual([
      { id: 0, type: 'core', parent: null },
      { id: 1, type: 'base', parent: 0, face: '+x' },
    ]);
  });

  it('関節は回転軸つきで追加される', () => {
    const bp = ok(addBlock(emptyBlueprint(), 0, '+x', 'joint', 'y'));
    expect(bp.blocks[1].axis).toBe('y');
  });

  it('元の設計図は変更しない', () => {
    const before = emptyBlueprint();
    addBlock(before, 0, '+x', 'base');
    expect(before.blocks.length).toBe(1);
  });

  it('埋まっている位置には置けない', () => {
    const r = addBlock(QUADRUPED, 0, '+z', 'base');
    expect(r.ok).toBe(false);
  });

  it('コスト上限を超える追加は拒否される', () => {
    let bp = emptyBlueprint();
    // 弾力(コスト2)を一直線に並べて上限ちょうどにする
    while (totalCost(bp) < CREATURE.maxCost) bp = ok(addBlock(bp, bp.blocks.length - 1, '+z', 'bouncy'));
    expect(totalCost(bp)).toBe(CREATURE.maxCost);
    const r = addBlock(bp, 0, '-x', 'base');
    expect(r.ok).toBe(false);
  });

  it('削除すると、その先のブロックも消え、IDが詰め直される', () => {
    // QUADRUPED からブロック1(前の胴)を消すと、前脚2本(3,4,5,6)も消える
    const bp = ok(removeBlock(QUADRUPED, 1));
    expect(bp.blocks.length).toBe(6);
    expect(validate(bp)).toEqual([]);
    expect(bp.blocks.map((b) => b.parent)).toEqual([null, 0, 1, 2, 1, 4]);
  });

  it('コアは削除できない', () => {
    expect(removeBlock(QUADRUPED, 0).ok).toBe(false);
  });

  it('左右対称モードでは反対側にも置かれる', () => {
    const bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '+x', 'base'));
    const pos = blockPositions(bp);
    expect(pos).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [-1, 0, 0],
    ]);
  });

  it('左右対称モードで孫のブロックも反対側の対応する親に付く', () => {
    let bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '+x', 'joint', 'z'));
    bp = ok(addBlockSymmetric(bp, 1, '-y', 'base'));
    expect(blockAt(bp, [1, -1, 0])).toBeDefined();
    expect(blockAt(bp, [-1, -1, 0])).toBeDefined();
    expect(bp.blocks[blockAt(bp, [-1, -1, 0])!].parent).toBe(2);
    expect(bp.blocks[2].axis).toBe('z');
  });

  it('対称面上に置くときは1個だけ', () => {
    const bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '+z', 'base'));
    expect(bp.blocks.length).toBe(2);
  });

  it('反対側に親がなければ片側だけ置いて知らせる', () => {
    const bp = ok(addBlock(emptyBlueprint(), 0, '+x', 'base'));
    const r = addBlockSymmetric(bp, 1, '+z', 'base');
    expect(r.ok && r.blueprint.blocks.length).toBe(3);
    expect(r.ok && r.notes.length).toBe(1);
  });

  it('左右対称に置くとコスト上限を超える場合は拒否される', () => {
    let bp = emptyBlueprint();
    // 一直線に +z に並べてコストを上限-1にする
    while (totalCost(bp) < CREATURE.maxCost - 2) bp = ok(addBlock(bp, bp.blocks.length - 1, '+z', 'bouncy'));
    bp = ok(addBlock(bp, bp.blocks.length - 1, '+z', 'base'));
    expect(totalCost(bp)).toBe(CREATURE.maxCost - 1);
    const r = addBlockSymmetric(bp, 0, '+x', 'base');
    expect(r.ok).toBe(false);
  });

  it('左右対称モードの削除は反対側も消す', () => {
    const bp = ok(removeBlockSymmetric(QUADRUPED, 3));
    // 前の左脚(3,4)と前の右脚(5,6)が消える
    expect(bp.blocks.length).toBe(7);
    expect(validate(bp)).toEqual([]);
  });

  it('左右対称モードの回転軸変更は反対側の関節にも反映される', () => {
    const bp = ok(setJointAxisSymmetric(QUADRUPED, 3, 'y'));
    expect(bp.blocks[3].axis).toBe('y');
    expect(bp.blocks[5].axis).toBe('y');
    expect(bp.blocks[7].axis).toBe('x');
  });
});

describe('ピストンの向きの編集', () => {
  it('左右対称に置くと、反対側のピストンは左右が反転した向きになる', async () => {
    const { setPistonDirSymmetric } = await import('../src/core/creature/edit');
    let bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '+x', 'piston', undefined, '+z'));
    expect(bp.blocks[1].dir).toBe('+z');
    expect(bp.blocks[2].dir).toBe('+z');
    bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '-y', 'base'));
    bp = ok(addBlockSymmetric(emptyBlueprint(), 0, '+z', 'base'));
    const legs = ok(addBlockSymmetric(bp, 1, '+x', 'piston', undefined, '+x'));
    // 付けた面と同じ向きは「指定なし」として保存する
    expect(legs.blocks[2].dir).toBeUndefined();
    const turned = ok(setPistonDirSymmetric(legs, 2, '-y'));
    expect(turned.blocks[2].dir).toBe('-y');
    expect(turned.blocks[3].dir).toBe('-y');
    const sideways = ok(setPistonDirSymmetric(legs, 2, '+z'));
    expect(sideways.blocks[3].dir).toBe('+z');
  });

  it('親に向かう向きには置けない', () => {
    expect(addBlock(emptyBlueprint(), 0, '-y', 'piston', undefined, '+y').ok).toBe(false);
  });
});
