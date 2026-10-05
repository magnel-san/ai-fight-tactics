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
