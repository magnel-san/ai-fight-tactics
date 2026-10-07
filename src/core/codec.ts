// キャラのJSON形式(仕様書セクション12)。重みは float16 のバイト列を base64 にして持つ。
// 形式を変えたときは version を上げ、migrate() に移行処理を書く。
// 受け取ったデータは信用せず、parseCharacter() で形と値を検証してから使う(不正対策)。
import { decisionGenomeLength, DECISION_SHAPE, EYE_HEXES } from './brain/decision';
import { appendOutputs, mlpParamCount, remapInputs } from './brain/mlp';
import { hexesWithin } from './stage/hex';
import { fromF16Bits, toF16Bits } from './brain/f16';
import { motorGenomeLength, motorShape, rhythmPeriod } from './brain/motor';
import type { Character, Progress } from './character';
import { actuatorCount, validate, type Blueprint, type BlockSpec } from './creature/blueprint';
import { TASK_ORDER, type TaskName } from './training/tasks';

/**
 * 形式のバージョン
 *   1:最初の形式(判断脳の入力35、目は2周19マス)
 *   2:判断脳の目を4周61マスに広げた(入力77)
 *   3:ピストンブロックを追加。運動脳の入力にジャンプ指令、判断脳の出力にジャンプ指令を追加
 *   4:ブロックに形(shape)と摩擦オン(grip)を追加。グリップブロックを「基礎 + 摩擦オン」に置き換え、雲・浮力ブロックを追加
 *   5:浮力ブロックを風ブロックに置き換え(下向きに吹く風にする)
 *   6:円柱の軸の向き(cylAxis)と、関節のタイヤモード(tire)を追加(古いデータはそのまま読める)
 *   7:関節の360°回転(spin)を追加(古いデータはそのまま読める)
 */
export const FORMAT_VERSION = 7;

interface BrainJson {
  inputs: number;
  hidden: number;
  outputs: number;
  weights: string;
}

export interface CharacterJson {
  version: number;
  name: string;
  blueprint: Blueprint;
  brains: {
    /** weights の最後の1個はリズム周期の遺伝子(周期の対数)。rhythmPeriod は確認用の値 */
    motor: (BrainJson & { rhythmPeriod: number }) | null;
    decision: BrainJson | null;
  };
  progress: Progress;
}

// ---- base64(DOM の btoa に頼らず、どの環境でも同じ結果にする) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) throw new Error('base64 の形式が不正です');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12) | (B64.indexOf(clean[i + 2] ?? 'A') << 6) | B64.indexOf(clean[i + 3] ?? 'A');
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** 重みを float16(リトルエンディアン)のバイト列にして base64 にする */
export function encodeWeights(w: Float64Array): string {
  const bytes = new Uint8Array(w.length * 2);
  for (let i = 0; i < w.length; i++) {
    const h = toF16Bits(w[i]);
    bytes[2 * i] = h & 255;
    bytes[2 * i + 1] = h >> 8;
  }
  return bytesToBase64(bytes);
}

export function decodeWeights(s: string): Float64Array {
  const bytes = base64ToBytes(s);
  if (bytes.length % 2 !== 0) throw new Error('重みのバイト数が不正です');
  const w = new Float64Array(bytes.length / 2);
  for (let i = 0; i < w.length; i++) w[i] = fromF16Bits(bytes[2 * i] | (bytes[2 * i + 1] << 8));
  return w;
}

export function characterToJson(c: Character): CharacterJson {
  const ms = motorShape(actuatorCount(c.blueprint));
  return {
    version: FORMAT_VERSION,
    name: c.name,
    blueprint: c.blueprint,
    brains: {
      motor: c.motor
        ? { inputs: ms.inputs, hidden: ms.hidden, outputs: ms.outputs, rhythmPeriod: Number(rhythmPeriod(c.motor).toFixed(3)), weights: encodeWeights(c.motor) }
        : null,
      decision: c.decision ? { ...DECISION_SHAPE, weights: encodeWeights(c.decision) } : null,
    },
    progress: c.progress,
  };
}

/** 古い形式を新しい形式に直す。重みは移し替えるだけなので、移行しても動きは変わらない */
function migrate(input: { version?: unknown }): CharacterJson {
  let json = input as CharacterJson;
  if (json.version === 1) json = migrate1to2(json);
  if (json.version === 2) json = migrate2to3(json);
  if (json.version === 3) json = migrate3to4(json);
  if (json.version === 4) json = migrate4to5(json);
  // 5 → 6:項目を足しただけなので、中身は変えない
  if (json.version === 5) json = { ...json, version: 6 };
  // 6 → 7:項目を足しただけ
  if (json.version === 6) json = { ...json, version: 7 };
  if (json.version === FORMAT_VERSION) return json;
  throw new Error(`対応していない形式のバージョンです:${String(json.version)}`);
}

/**
 * 4 → 5:浮力ブロック(いつも上向きの力)を、下向きに吹く風ブロック(床の近くで持ち上げる)に置き換える
 */
function migrate4to5(json: CharacterJson): CharacterJson {
  const bp = json.blueprint as { blocks?: unknown } | undefined;
  if (!bp || !Array.isArray(bp.blocks)) return { ...json, version: 5 };
  const blocks = bp.blocks.map((b: unknown) => {
    const o = b as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.type !== 'float') return o;
    const next: Record<string, unknown> = { ...o, type: 'wind' };
    if (o.face === '-y') delete next.dir;
    else next.dir = '-y';
    return next;
  });
  return { ...json, version: 5, blueprint: { ...(json.blueprint as object), blocks } as unknown as Blueprint };
}

/**
 * 3 → 4:グリップブロックを「基礎 + 摩擦オン」に置き換える。コスト・重さ・摩擦が同じなので、動きは変わらない
 */
function migrate3to4(json: CharacterJson): CharacterJson {
  const bp = json.blueprint as { blocks?: unknown } | undefined;
  if (!bp || !Array.isArray(bp.blocks)) return { ...json, version: 4 };
  const blocks = bp.blocks.map((b: unknown) => {
    const o = b as Record<string, unknown>;
    return o && typeof o === 'object' && o.type === 'grip' ? { ...o, type: 'base', grip: true } : o;
  });
  return { ...json, version: 4, blueprint: { ...(json.blueprint as object), blocks } as unknown as Blueprint };
}

/**
 * 2 → 3:運動脳の入力の最後にジャンプ指令を、判断脳の出力の最後にジャンプ指令を足す。
 * 足した重みは0なので、ジャンプ指令は使われず、動きは変わらない
 */
function migrate2to3(json: CharacterJson): CharacterJson {
  const brains = { ...json.brains };
  const m = brains.motor;
  if (m && typeof m.weights === 'string') {
    const genome = decodeWeights(m.weights);
    const from = { inputs: m.inputs, hidden: m.hidden, outputs: m.outputs };
    const to = { inputs: m.inputs + 1, hidden: m.hidden, outputs: m.outputs };
    if (genome.length !== mlpParamCount(from) + 1) throw new Error('運動脳の重みの数が不正です');
    const mlp = remapInputs(
      genome.subarray(0, genome.length - 1),
      from,
      to,
      Array.from({ length: from.inputs }, (_, i) => i),
    );
    const next = new Float64Array(mlp.length + 1);
    next.set(mlp);
    next[mlp.length] = genome[genome.length - 1];
    brains.motor = { ...m, inputs: to.inputs, weights: encodeWeights(next) };
  }
  const d = brains.decision;
  if (d && typeof d.weights === 'string') {
    const from = { inputs: d.inputs, hidden: d.hidden, outputs: 3 };
    brains.decision = { ...DECISION_SHAPE, weights: encodeWeights(appendOutputs(decodeWeights(d.weights), from, DECISION_SHAPE)) };
  }
  return { ...json, version: 3, brains };
}

/** 1 → 2:判断脳の目を2周19マスから4周61マスへ。古い目の重みは同じマスへ移し、増えたマスの重みは0にする */
function migrate1to2(json: CharacterJson): CharacterJson {
  const d = json.brains?.decision;
  if (!d || typeof d.weights !== 'string') return { ...json, version: 2 };
  const oldEye = hexesWithin(2);
  const oldShape = { inputs: 35, hidden: DECISION_SHAPE.hidden, outputs: 3 };
  const inputMap = Array.from({ length: oldShape.inputs }, (_, i) =>
    i < oldEye.length ? EYE_HEXES.findIndex((h) => h.q === oldEye[i].q && h.r === oldEye[i].r) : EYE_HEXES.length + (i - oldEye.length),
  );
  const weights = remapInputs(decodeWeights(d.weights), oldShape, { ...oldShape, inputs: 77 }, inputMap);
  const decision = { inputs: 77, hidden: DECISION_SHAPE.hidden, outputs: 3, weights: encodeWeights(weights) };
  return { ...json, version: 2, brains: { ...json.brains, decision } };
}

const BLOCK_TYPES = new Set(['core', 'base', 'joint', 'bouncy', 'piston', 'sensor', 'cloud', 'wind']);
const SHAPE_SET = new Set(['cube', 'sphere', 'cylinder']);
const FACES = new Set(['+x', '-x', '+y', '-y', '+z', '-z']);
const AXES = new Set(['x', 'y', 'z']);

function parseBlueprint(v: unknown): Blueprint {
  if (!v || typeof v !== 'object' || !Array.isArray((v as Blueprint).blocks)) throw new Error('設計図がありません');
  const blocks: BlockSpec[] = (v as Blueprint).blocks.map((b: unknown, i: number) => {
    const o = b as Record<string, unknown>;
    if (!o || typeof o !== 'object') throw new Error(`ブロック${i}が不正です`);
    if (!BLOCK_TYPES.has(o.type as string)) throw new Error(`ブロック${i}の種類が不正です`);
    const spec: BlockSpec = { id: Number(o.id), type: o.type as BlockSpec['type'], parent: o.parent === null ? null : Number(o.parent) };
    if (o.face !== undefined) {
      if (!FACES.has(o.face as string)) throw new Error(`ブロック${i}の面が不正です`);
      spec.face = o.face as BlockSpec['face'];
    }
    if (o.dir !== undefined) {
      if (!FACES.has(o.dir as string)) throw new Error(`ブロック${i}の向きが不正です`);
      spec.dir = o.dir as BlockSpec['dir'];
    }
    if (o.axis !== undefined) {
      if (!AXES.has(o.axis as string)) throw new Error(`ブロック${i}の軸が不正です`);
      spec.axis = o.axis as BlockSpec['axis'];
    }
    // 形と摩擦は、既定(立方体・摩擦オフ)のときは持たない(データを小さく保つ)
    if (o.shape !== undefined && o.shape !== 'cube') {
      if (!SHAPE_SET.has(o.shape as string)) throw new Error(`ブロック${i}の形が不正です`);
      spec.shape = o.shape as BlockSpec['shape'];
    }
    if (o.grip !== undefined && o.grip !== false) {
      if (o.grip !== true) throw new Error(`ブロック${i}の摩擦の設定が不正です`);
      spec.grip = true;
    }
    if (o.cylAxis !== undefined) {
      if (!AXES.has(o.cylAxis as string)) throw new Error(`ブロック${i}の円柱の向きが不正です`);
      spec.cylAxis = o.cylAxis as BlockSpec['cylAxis'];
    }
    if (o.tire !== undefined && o.tire !== false) {
      if (o.tire !== true) throw new Error(`ブロック${i}のタイヤの設定が不正です`);
      spec.tire = true;
    }
    if (o.spin !== undefined && o.spin !== false) {
      if (o.spin !== true) throw new Error(`ブロック${i}の関節の回り方が不正です`);
      spec.spin = true;
    }
    return spec;
  });
  const bp = { blocks };
  const errors = validate(bp);
  if (errors.length > 0) throw new Error(errors[0]);
  return bp;
}

function parseWeights(brain: BrainJson | null | undefined, length: number, label: string): Float64Array | null {
  if (brain === null || brain === undefined) return null;
  if (typeof brain.weights !== 'string') throw new Error(`${label}の重みがありません`);
  const w = decodeWeights(brain.weights);
  if (w.length !== length) throw new Error(`${label}の重みの数が体と合いません:${w.length}(必要 ${length})`);
  for (const x of w) if (!Number.isFinite(x)) throw new Error(`${label}の重みに不正な値があります`);
  return w;
}

/** JSON(文字列またはオブジェクト)を検証してキャラにする */
export function parseCharacter(input: string | unknown): Character {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object') throw new Error('キャラのデータではありません');
  const json = migrate(raw as { version?: unknown });
  const blueprint = parseBlueprint(json.blueprint);
  const name = typeof json.name === 'string' && json.name.trim() ? json.name.slice(0, 40) : '名無し';
  const motor = parseWeights(json.brains?.motor, motorGenomeLength(actuatorCount(blueprint)), '運動脳');
  const decision = parseWeights(json.brains?.decision, decisionGenomeLength(), '判断脳');
  const p = (json.progress ?? {}) as Partial<Progress>;
  const passed = Array.isArray(p.passed) ? p.passed.filter((t): t is TaskName => TASK_ORDER.includes(t as TaskName)) : [];
  const generations: Progress['generations'] = {};
  for (const t of TASK_ORDER) {
    const g = (p.generations as Record<string, unknown> | undefined)?.[t];
    if (typeof g === 'number' && Number.isFinite(g) && g >= 0) generations[t] = Math.floor(g);
  }
  const progress: Progress = { passed, generations };
  if (typeof p.surviveLevel === 'number') progress.surviveLevel = Math.min(5, Math.max(1, Math.floor(p.surviveLevel)));
  if (Array.isArray(p.milestones)) progress.milestones = p.milestones.filter((m): m is string => typeof m === 'string').slice(0, 20);
  return { name, blueprint, motor, decision, progress };
}
