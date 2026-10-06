// 開発・テスト用のサンプルキャラ
import type { Blueprint } from './blueprint';

/**
 * 4本脚。胴体(コア+前後の基礎)の左右に関節を付け、その下にグリップの足を付ける。
 * 関節の軸は x(左右方向)なので、足は前後に振れる。コスト22、関節4。
 */
export const QUADRUPED: Blueprint = {
  blocks: [
    { id: 0, type: 'core', parent: null },
    { id: 1, type: 'base', parent: 0, face: '+z' },
    { id: 2, type: 'base', parent: 0, face: '-z' },
    { id: 3, type: 'joint', parent: 1, face: '+x', axis: 'x' },
    { id: 4, type: 'grip', parent: 3, face: '-y' },
    { id: 5, type: 'joint', parent: 1, face: '-x', axis: 'x' },
    { id: 6, type: 'grip', parent: 5, face: '-y' },
    { id: 7, type: 'joint', parent: 2, face: '+x', axis: 'x' },
    { id: 8, type: 'grip', parent: 7, face: '-y' },
    { id: 9, type: 'joint', parent: 2, face: '-x', axis: 'x' },
    { id: 10, type: 'grip', parent: 9, face: '-y' },
  ],
};

/** 2本の腕で這うキャラ。関節2、コスト14 */
export const CRAWLER: Blueprint = {
  blocks: [
    { id: 0, type: 'core', parent: null },
    { id: 1, type: 'base', parent: 0, face: '-z' },
    { id: 2, type: 'joint', parent: 0, face: '+x', axis: 'y' },
    { id: 3, type: 'grip', parent: 2, face: '+x' },
    { id: 4, type: 'joint', parent: 0, face: '-x', axis: 'y' },
    { id: 5, type: 'grip', parent: 4, face: '-x' },
  ],
};

/** くねくね進むヘビ。関節4、コスト19 */
export const SNAKE: Blueprint = {
  blocks: [
    { id: 0, type: 'core', parent: null },
    { id: 1, type: 'joint', parent: 0, face: '-z', axis: 'y' },
    { id: 2, type: 'base', parent: 1, face: '-z' },
    { id: 3, type: 'joint', parent: 2, face: '-z', axis: 'y' },
    { id: 4, type: 'base', parent: 3, face: '-z' },
    { id: 5, type: 'joint', parent: 4, face: '-z', axis: 'y' },
    { id: 6, type: 'base', parent: 5, face: '-z' },
    { id: 7, type: 'joint', parent: 6, face: '-z', axis: 'y' },
    { id: 8, type: 'grip', parent: 7, face: '-z' },
  ],
};

/** 標準BOTの体:4本脚の正面に、当たった相手を弾く弾力ブロックを付けたもの。コスト24、関節4 */
export const STANDARD_BODY: Blueprint = {
  blocks: [...QUADRUPED.blocks, { id: 11, type: 'bouncy', parent: 1, face: '+z' }],
};

/** ジャンプする4本脚:4本脚のコアの下に、下向きのピストンを付けたもの。コスト25、関節4・ピストン1 */
export const JUMPER: Blueprint = {
  blocks: [...QUADRUPED.blocks, { id: 11, type: 'piston', parent: 0, face: '-y' }],
};

/** 左右に1本ずつ脚を付けた2本脚。関節を同じ向きに振るとコアが前後に揺れやすい。コスト10、関節2 */
export const BIPED: Blueprint = {
  blocks: [
    { id: 0, type: 'core', parent: null },
    { id: 1, type: 'joint', parent: 0, face: '+x', axis: 'x' },
    { id: 2, type: 'grip', parent: 1, face: '-y' },
    { id: 3, type: 'joint', parent: 0, face: '-x', axis: 'x' },
    { id: 4, type: 'grip', parent: 3, face: '-y' },
  ],
};

export const SAMPLES: Record<string, Blueprint> = {
  biped: BIPED,
  jumper: JUMPER,
  quadruped: QUADRUPED,
  standard: STANDARD_BODY,
  crawler: CRAWLER,
  snake: SNAKE,
};
