// キャラの設計図(仕様書セクション4・12)。
// コアを根とする木構造で、各ブロックは親ブロックのどの面に付くかだけを持つ。
// 位置はすべてコア基準の整数格子座標で、関節が0°のときの姿勢を表す。
import { BLOCKS, CREATURE, type BlockType } from '../config';

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

export function totalCost(bp: Blueprint): number {
  return bp.blocks.reduce((sum, b) => sum + BLOCKS[b.type].cost, 0);
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

/** 動かせるブロックか(体をここで別の剛体に分ける) */
export function isActuator(type: BlockSpec['type']): boolean {
  return type === 'joint' || type === 'piston';
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
    if (b.type !== 'joint' && b.axis !== undefined) {
      errors.push(`関節以外のブロック${i}に回転軸が指定されています`);
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
  }

  return errors;
}

/**
 * 剛体(セグメント)への分割。
 * 関節・ピストンのブロックを挟まずにつながったブロックは1つの剛体にまとめる。
 * 関節・ピストンのブロック自身は子側の剛体の根になり、親側の剛体とはヒンジ(関節)かスライド(ピストン)でつながる。
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
    if (b.parent === null || isActuator(b.type)) {
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
