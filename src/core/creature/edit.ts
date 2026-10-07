// 設計図の編集操作(キャラクリエイト画面から使う)。
// どの操作も元の設計図は変更せず、新しい設計図を返す。結果は必ず validate() を通る。
import type { BlockShape, BlockType } from '../config';
import { blockPositions, FACE_DIR, validate, type Axis, type Blueprint, type Face, type Vec3i, type BlockSpec } from './blueprint';

export type EditResult = { ok: true; blueprint: Blueprint; /** 操作は成功したが知らせたいこと */ notes: string[] } | { ok: false; errors: string[] };

/** 左右対称の基準面は x = 0(コアの正面 +z を向いたとき、x が左右方向) */
export function mirrorCell(p: Vec3i): Vec3i {
  return [-p[0], p[1], p[2]];
}

export function mirrorFace(face: Face): Face {
  if (face === '+x') return '-x';
  if (face === '-x') return '+x';
  return face;
}

/** 指定した格子座標にあるブロックのID(なければ undefined) */
export function blockAt(bp: Blueprint, cell: Vec3i): number | undefined {
  const i = blockPositions(bp).findIndex((p) => p[0] === cell[0] && p[1] === cell[1] && p[2] === cell[2]);
  return i < 0 ? undefined : i;
}

/** 親ブロックの面に新しいブロックを置いたときの格子座標 */
export function cellOnFace(bp: Blueprint, parent: number, face: Face): Vec3i {
  const p = blockPositions(bp)[parent];
  const d = FACE_DIR[face];
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}

function finish(bp: Blueprint, notes: string[] = []): EditResult {
  const errors = validate(bp);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, blueprint: bp, notes };
}

/** 置くブロックの形と摩擦 */
export interface BlockLook {
  shape?: BlockShape;
  grip?: boolean;
  /** 円柱の軸の向き(null は自動) */
  cylAxis?: Axis | null;
  /** タイヤモード(円柱にした関節だけ) */
  tire?: boolean;
  /** 360°回転(関節だけ) */
  spin?: boolean;
}

/** 形と摩擦を設定したブロック(既定の値のときは持たない) */
function withLook(b: BlockSpec, look: BlockLook | undefined): BlockSpec {
  const next: BlockSpec = { ...b };
  if (look?.shape !== undefined) {
    if (look.shape === 'cube') delete next.shape;
    else next.shape = look.shape;
  }
  if (look?.grip !== undefined) {
    if (look.grip) next.grip = true;
    else delete next.grip;
  }
  if (look?.cylAxis !== undefined) {
    if (look.cylAxis === null) delete next.cylAxis;
    else next.cylAxis = look.cylAxis;
  }
  if (look?.tire !== undefined) {
    if (look.tire) next.tire = true;
    else delete next.tire;
  }
  if (look?.spin !== undefined) {
    if (look.spin) next.spin = true;
    else delete next.spin;
  }
  // 円柱の向きとタイヤは円柱のときだけ、タイヤは関節のときだけ持つ
  if (next.shape !== 'cylinder') {
    delete next.cylAxis;
    delete next.tire;
  }
  if (next.type !== 'joint') {
    delete next.tire;
    delete next.spin;
  }
  return next;
}

/**
 * ブロックを1つ追加する。axis は関節の回転軸、pistonDir はピストンの伸びる向き
 * (省略または付けた面と同じなら、付けた面の向き)、look は形と摩擦
 */
export function addBlock(bp: Blueprint, parent: number, face: Face, type: BlockType, axis?: Axis, pistonDir?: Face, look?: BlockLook): EditResult {
  if (type === 'core') return { ok: false, errors: ['コアは追加できません'] };
  if (!bp.blocks[parent]) return { ok: false, errors: [`親ブロック${parent}がありません`] };
  if (blockAt(bp, cellOnFace(bp, parent, face)) !== undefined) {
    return { ok: false, errors: ['その位置にはすでにブロックがあります'] };
  }
  const id = bp.blocks.length;
  const block: BlockSpec =
    type === 'joint'
      ? { id, type, parent, face, axis: axis ?? 'x' }
      : (type === 'piston' || type === 'wind') && pistonDir && pistonDir !== face
        ? { id, type, parent, face, dir: pistonDir }
        : { id, type, parent, face };
  return finish({ blocks: [...bp.blocks, withLook(block, look)] });
}

/**
 * 左右対称モードでの追加。反対側の対応する位置にも同じブロックを置く。
 * 置く位置が対称面上にある場合や、反対側に親がない・埋まっている場合は、片側だけに置いて notes で知らせる。
 */
export function addBlockSymmetric(bp: Blueprint, parent: number, face: Face, type: BlockType, axis?: Axis, pistonDir?: Face, look?: BlockLook): EditResult {
  const first = addBlock(bp, parent, face, type, axis, pistonDir, look);
  if (!first.ok) return first;

  const target = cellOnFace(bp, parent, face);
  const mirrored = mirrorCell(target);
  if (mirrored[0] === target[0]) return first;

  const mirrorParent = blockAt(first.blueprint, mirrorCell(blockPositions(bp)[parent]));
  if (mirrorParent === undefined) {
    return { ...first, notes: ['反対側に対応するブロックがないため、片側だけに置きました'] };
  }
  if (blockAt(first.blueprint, mirrored) !== undefined) {
    return { ...first, notes: ['反対側の位置が埋まっているため、片側だけに置きました'] };
  }
  // 反対側のピストンは、伸びる向きも左右を反転させる
  const second = addBlock(first.blueprint, mirrorParent, mirrorFace(face), type, axis, pistonDir ? mirrorFace(pistonDir) : undefined, look);
  if (!second.ok) return { ok: false, errors: second.errors.map((e) => `左右対称に置けません:${e}`) };
  return second;
}

/** 指定したブロックと、その先につながるすべてのブロックのID */
export function subtreeOf(bp: Blueprint, id: number): Set<number> {
  const result = new Set<number>([id]);
  // 親は必ず自分より小さいIDなので、ID順に1回なめるだけで子孫がそろう
  for (const b of bp.blocks) if (b.parent !== null && result.has(b.parent)) result.add(b.id);
  return result;
}

/** 複数のブロックを、その先も含めて削除する。残ったブロックはID順を保ったまま詰め直す */
export function removeBlocks(bp: Blueprint, ids: number[]): EditResult {
  if (ids.includes(0)) return { ok: false, errors: ['コアは削除できません'] };
  const removed = new Set<number>();
  for (const id of ids) {
    if (!bp.blocks[id]) return { ok: false, errors: [`ブロック${id}がありません`] };
    for (const r of subtreeOf(bp, id)) removed.add(r);
  }
  const newId = new Map<number, number>();
  const blocks = bp.blocks
    .filter((b) => !removed.has(b.id))
    .map((b, i) => {
      newId.set(b.id, i);
      return { ...b, id: i, parent: b.parent === null ? null : newId.get(b.parent)! };
    });
  return finish({ blocks });
}

export function removeBlock(bp: Blueprint, id: number): EditResult {
  return removeBlocks(bp, [id]);
}

/** 左右対称モードでの削除。反対側の同じ位置にあるブロックも削除する */
export function removeBlockSymmetric(bp: Blueprint, id: number): EditResult {
  const pos = blockPositions(bp)[id];
  if (!pos) return { ok: false, errors: [`ブロック${id}がありません`] };
  const mirror = blockAt(bp, mirrorCell(pos));
  if (mirror === undefined || mirror === id || mirror === 0) return removeBlock(bp, id);
  return removeBlocks(bp, [id, mirror]);
}

/** 関節の回転軸を変更する */
export function setJointAxis(bp: Blueprint, id: number, axis: Axis): EditResult {
  const b = bp.blocks[id];
  if (!b || b.type !== 'joint') return { ok: false, errors: ['関節ブロックではありません'] };
  return finish({ blocks: bp.blocks.map((x) => (x.id === id ? { ...x, axis } : x)) });
}

/** ピストンの伸びる向き・風の吹く向きを変更する(付けた面と同じ向きなら、指定なしに戻す) */
export function setPistonDir(bp: Blueprint, id: number, dir: Face): EditResult {
  const b = bp.blocks[id];
  if (!b || (b.type !== 'piston' && b.type !== 'wind')) return { ok: false, errors: ['ピストン・風のブロックではありません'] };
  return finish({
    blocks: bp.blocks.map((x) => {
      if (x.id !== id) return x;
      const next: BlockSpec = { ...x };
      if (dir === x.face) delete next.dir;
      else next.dir = dir;
      return next;
    }),
  });
}

/** 左右対称モードでのピストンの向きの変更。反対側の同じ位置にあるピストンは、左右を反転した向きにする */
export function setPistonDirSymmetric(bp: Blueprint, id: number, dir: Face): EditResult {
  const first = setPistonDir(bp, id, dir);
  if (!first.ok) return first;
  const mirror = blockAt(bp, mirrorCell(blockPositions(bp)[id]));
  if (mirror === undefined || mirror === id || bp.blocks[mirror].type !== bp.blocks[id].type) return first;
  return setPistonDir(first.blueprint, mirror, mirrorFace(dir));
}

/** 左右対称モードでの回転軸の変更。反対側の同じ位置にある関節も同じ軸にする */
export function setJointAxisSymmetric(bp: Blueprint, id: number, axis: Axis): EditResult {
  const first = setJointAxis(bp, id, axis);
  if (!first.ok) return first;
  const mirror = blockAt(bp, mirrorCell(blockPositions(bp)[id]));
  if (mirror === undefined || mirror === id || bp.blocks[mirror].type !== 'joint') return first;
  return setJointAxis(first.blueprint, mirror, axis);
}

/** ブロックの形や摩擦を変更する(摩擦オンにするとコストが増えるので、上限を超えるときは失敗する) */
export function setBlockLook(bp: Blueprint, id: number, look: BlockLook): EditResult {
  if (!bp.blocks[id]) return { ok: false, errors: [`ブロック${id}がありません`] };
  return finish({ blocks: bp.blocks.map((x) => (x.id === id ? withLook(x, look) : x)) });
}

/** 左右対称モードでの形・摩擦の変更。反対側の同じ位置にあるブロックも同じにする */
export function setBlockLookSymmetric(bp: Blueprint, id: number, look: BlockLook): EditResult {
  const first = setBlockLook(bp, id, look);
  if (!first.ok) return first;
  const pos = blockPositions(bp)[id];
  const mirror = blockAt(bp, mirrorCell(pos));
  if (mirror === undefined || mirror === id) return first;
  return setBlockLook(first.blueprint, mirror, look);
}

/** コアだけの設計図 */
export function emptyBlueprint(): Blueprint {
  return { blocks: [{ id: 0, type: 'core', parent: null }] };
}
