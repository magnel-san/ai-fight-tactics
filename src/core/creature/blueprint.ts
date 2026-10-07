// キャラの設計図(仕様書セクション4・12)。
// コアを根とする木構造で、各ブロックは親ブロックのどの面に付くかだけを持つ。
// 位置はすべてコア基準の整数格子座標で、関節が0°のときの姿勢を表す。
import { BLOCK_OPTIONS, BLOCKS, CREATURE, type BlockShape, type BlockType } from '../config';

export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export type Axis = 'x' | 'y' | 'z';
export type Vec3i = readonly [number, number, number];

export interface BlockSpec {
  id: number;
  type: BlockType;
  parent: number | null;
  /** 親のどの面に付くか(コア以外で必須) */
  face?: Face;
  /** 関節の回転軸(関節のみ。コア基準の3軸から選ぶ) */
  axis?: Axis;
  /** ピストンの伸びる向き・風の吹く向き(ピストンと風のみ。コア基準。省略時は付けた面の向き = 親から離れる向き) */
  dir?: Face;
  /** 形(省略時は立方体) */
  shape?: BlockShape;
  /** 摩擦オン(省略時はオフ)。摩擦が大きく踏ん張れる。コストが増える */
  grip?: boolean;
  /** 円柱の軸の向き(円柱のみ。省略時は自動:cylinderAxis) */
  cylAxis?: Axis;
  /** タイヤモード(円柱にした関節のみ)。半径が大きくなる。コストが増える */
  tire?: boolean;
  /**
   * 関節の回り方(関節のみ)。省略時は180°(±90°の範囲で角度を指定する)。
   * true なら360°(可動範囲なしで回り続ける。脳は回る速さを指定する。車輪やタイヤに)
   */
  spin?: boolean;
}

export const SHAPES: readonly BlockShape[] = ['cube', 'sphere', 'cylinder'];

/** ブロックの形(省略時は立方体) */
export function shapeOf(b: BlockSpec): BlockShape {
  return b.shape ?? 'cube';
}

/** 1つのブロックのコスト(摩擦オン・タイヤモードなら追加のコスト) */
export function blockCost(b: BlockSpec): number {
  return BLOCKS[b.type].cost + (b.grip ? BLOCK_OPTIONS.gripCost : 0) + (b.tire ? BLOCK_OPTIONS.tireCost : 0);
}

/** 円柱の半径 [m](タイヤモードなら大きい) */
export function cylinderRadius(b: BlockSpec): number {
  return (CREATURE.blockSize / 2) * (b.tire ? BLOCK_OPTIONS.tireRadiusScale : 1);
}

/** 円柱の軸の向きを指定しなかったときの向き(自動)。関節は回転軸(車輪になる)、ピストン・風は向き、ほかは付けた面の向き(コアは上下) */
export function autoCylinderAxis(b: BlockSpec): Axis {
  if (b.type === 'joint' && b.axis) return b.axis;
  const f = hasDirection(b.type) && b.face ? pistonDirection(b) : b.face;
  return f ? (f[1] as Axis) : 'y';
}

/** 円柱の軸の向き(指定があればそれ、なければ自動) */
export function cylinderAxis(b: BlockSpec): Axis {
  return b.cylAxis ?? autoCylinderAxis(b);
}

export interface Blueprint {
  blocks: BlockSpec[];
}

export const FACES: readonly Face[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

export const FACE_DIR: Record<Face, Vec3i> = {
  '+x': [1, 0, 0],
  '-x': [-1, 0, 0],
  '+y': [0, 1, 0],
  '-y': [0, -1, 0],
  '+z': [0, 0, 1],
  '-z': [0, 0, -1],
};

export const AXIS_DIR: Record<Axis, Vec3i> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** 反対の面 */
export function oppositeFace(face: Face): Face {
  return ((face[0] === '+' ? '-' : '+') + face[1]) as Face;
}

/** ピストンの伸びる向き・風の吹く向き(指定がなければ付けた面の向き) */
export function pistonDirection(b: BlockSpec): Face {
  return b.dir ?? b.face!;
}

/** 向きを選べるブロックか(ピストンと風) */
export function hasDirection(type: BlockSpec['type']): boolean {
  return type === 'piston' || type === 'wind';
}

export function totalCost(bp: Blueprint): number {
  return bp.blocks.reduce((sum, b) => sum + blockCost(b), 0);
}

export function jointCount(bp: Blueprint): number {
  return bp.blocks.filter((b) => b.type === 'joint').length;
}

export function pistonCount(bp: Blueprint): number {
  return bp.blocks.filter((b) => b.type === 'piston').length;
}

/** 動かせるブロック(関節とピストン)の数。運動脳の入出力の大きさを決める */
export function actuatorCount(bp: Blueprint): number {
  return jointCount(bp) + pistonCount(bp);
}

/** 動かせるブロックか(脳の出力で動かす) */
export function isActuator(type: BlockSpec['type']): boolean {
  return type === 'joint' || type === 'piston';
}

/** 体をここで別の剛体に分けるブロックか(動かせるブロックと、ばねでつながる弾力ブロック) */
export function isSegmentRoot(type: BlockSpec['type']): boolean {
  return isActuator(type) || type === 'bouncy';
}

/**
 * 各ブロックの格子座標を求める(配列の添字 = ブロックID)。
 * validate() を通った設計図を前提とする。
 */
export function blockPositions(bp: Blueprint): Vec3i[] {
  const pos: Vec3i[] = [];
  for (const b of bp.blocks) {
    if (b.parent === null) {
      pos.push([0, 0, 0]);
    } else {
      const p = pos[b.parent];
      const d = FACE_DIR[b.face!];
      pos.push([p[0] + d[0], p[1] + d[1], p[2] + d[2]]);
    }
  }
  return pos;
}

/** 重心(コア基準、メートル単位)。キャラクリエイト画面の表示用 */
export function centerOfMass(bp: Blueprint): [number, number, number] {
  const pos = blockPositions(bp);
  let m = 0;
  const c: [number, number, number] = [0, 0, 0];
  bp.blocks.forEach((b, i) => {
    const mass = BLOCKS[b.type].mass;
    m += mass;
    for (let k = 0; k < 3; k++) c[k] += pos[i][k] * CREATURE.blockSize * mass;
  });
  return [c[0] / m, c[1] / m, c[2] / m];
}

/**
 * 設計図の検証。問題があれば日本語のメッセージを返す(なければ空配列)。
 * ルール:ブロックIDは配列の添字と一致し、親は自分より小さいIDを持つ。
 * こうしておくと、ID順に処理するだけで常に親が先に来て、Rapierへの登録順も一意に決まる。
 */
export function validate(bp: Blueprint): string[] {
  const errors: string[] = [];
  const { blocks } = bp;

  if (blocks.length === 0) return ['ブロックがありません'];
  if (blocks.length > CREATURE.maxBlocks) {
    errors.push(`ブロック数が上限(${CREATURE.maxBlocks})を超えています:${blocks.length}`);
  }

  const cost = totalCost(bp);
  if (cost > CREATURE.maxCost) errors.push(`コストが上限(${CREATURE.maxCost})を超えています:${cost}`);

  const joints = actuatorCount(bp);
  if (joints > CREATURE.maxJoints) errors.push(`関節数(関節とピストンの合計)が上限(${CREATURE.maxJoints})を超えています:${joints}`);

  const cores = blocks.filter((b) => b.type === 'core').length;
  if (cores !== 1) errors.push(`コアはちょうど1個必要です:${cores}個`);
  if (blocks[0].type !== 'core' || blocks[0].parent !== null) errors.push('ID 0 は親を持たないコアである必要があります');

  // 構造の検証(以降の座標計算はこれが通っていることが前提)
  let structureOk = true;
  blocks.forEach((b, i) => {
    if (b.id !== i) {
      errors.push(`ブロックIDが並び順と一致しません:添字${i}にID ${b.id}`);
      structureOk = false;
    }
    if (i === 0) return;
    if (b.parent === null || !Number.isInteger(b.parent) || b.parent < 0 || b.parent >= i) {
      errors.push(`ブロック${i}の親が不正です(自分より小さいIDが必要):${b.parent}`);
      structureOk = false;
    }
    if (!b.face || !(b.face in FACE_DIR)) {
      errors.push(`ブロック${i}の取り付け面が不正です:${b.face}`);
      structureOk = false;
    }
    if (b.type === 'joint' && (!b.axis || !(b.axis in AXIS_DIR))) {
      errors.push(`関節ブロック${i}の回転軸が不正です:${b.axis}`);
    }
    if (b.dir !== undefined) {
      if (!hasDirection(b.type)) errors.push(`ピストン・風以外のブロック${i}に向きが指定されています`);
      else if (!(b.dir in FACE_DIR)) errors.push(`ブロック${i}の向きが不正です:${b.dir}`);
      else if (b.type === 'piston' && b.face && b.dir === oppositeFace(b.face)) errors.push(`ピストン${i}は親のブロックに向かって伸ばせません`);
    }
    if (b.type !== 'joint' && b.axis !== undefined) {
      errors.push(`関節以外のブロック${i}に回転軸が指定されています`);
    }
    if (b.shape !== undefined && !SHAPES.includes(b.shape)) errors.push(`ブロック${i}の形が不正です:${b.shape}`);
    if (b.grip !== undefined && typeof b.grip !== 'boolean') errors.push(`ブロック${i}の摩擦の設定が不正です`);
    if (b.cylAxis !== undefined && (shapeOf(b) !== 'cylinder' || !(b.cylAxis in AXIS_DIR))) errors.push(`ブロック${i}の円柱の向きが不正です`);
    if (b.spin !== undefined && (b.spin !== true || b.type !== 'joint')) errors.push(`360°回転は関節ブロックだけに使えます(ブロック${i})`);
    if (b.tire !== undefined && (b.tire !== true || b.type !== 'joint' || shapeOf(b) !== 'cylinder')) {
      errors.push(`タイヤモードは、円柱にした関節ブロックだけに使えます(ブロック${i})`);
    }
  });

  if (structureOk) {
    const seen = new Map<string, number>();
    blockPositions(bp).forEach((p, i) => {
      const key = p.join(',');
      const other = seen.get(key);
      if (other !== undefined) errors.push(`ブロック${i}がブロック${other}と同じ位置に重なっています`);
      else seen.set(key, i);
    });
    // タイヤは半径が大きいので、回転軸に垂直な4方向の隣のマスに、親以外のブロックがあると重なる
    const pos = blockPositions(bp);
    blocks.forEach((b, i) => {
      if (!b.tire) return;
      const axis = cylinderAxis(b);
      for (const f of FACES) {
        if (f[1] === axis) continue;
        const d = FACE_DIR[f];
        const other = seen.get([pos[i][0] + d[0], pos[i][1] + d[1], pos[i][2] + d[2]].join(','));
        if (other !== undefined && other !== b.parent)
          errors.push(`タイヤ(ブロック${i})がブロック${other}と重なります。タイヤの周り(回転軸に垂直な4方向)には親以外のブロックを置けません`);
      }
    });
  }

  return errors;
}

/**
 * 剛体(セグメント)への分割。
 * 関節・ピストン・弾力のブロックを挟まずにつながったブロックは1つの剛体にまとめる。
 * 関節・ピストン・弾力のブロック自身は子側の剛体の根になり、親側の剛体とはヒンジ(関節)かスライド(ピストン・弾力のばね)でつながる。
 */
export interface Segment {
  /** この剛体の根のブロックID(コアまたは関節ブロック) */
  root: number;
  /** 含まれるブロックID(昇順) */
  blocks: number[];
}

export function segmentsOf(bp: Blueprint): { segments: Segment[]; segmentOf: number[] } {
  const segments: Segment[] = [];
  const segmentOf: number[] = [];
  for (const b of bp.blocks) {
    if (b.parent === null || isSegmentRoot(b.type)) {
      segmentOf.push(segments.length);
      segments.push({ root: b.id, blocks: [b.id] });
    } else {
      const s = segmentOf[b.parent];
      segmentOf.push(s);
      segments[s].blocks.push(b.id);
    }
  }
  return { segments, segmentOf };
}
