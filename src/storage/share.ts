// キャラの共有(仕様書セクション12)。
// URL共有:JSON を gzip(CompressionStream)で圧縮して base64url にし、`#c=` の後ろに付ける。
// ファイル共有:`.monster.json` としてダウンロード・読み込みする。
import type { Character } from '../core/character';
import { characterToJson, parseCharacter, type CharacterJson } from '../core/codec';
import type { FighterData } from '../core/training/tasks';

const HASH_KEY = 'c';
const REPLAY_KEY = 'r';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

async function gzipText(text: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream('gzip')));
}

async function gunzipText(code: string): Promise<string> {
  if (code.length > 200_000) throw new Error('共有コードが長すぎます');
  return new TextDecoder().decode(await pipe(fromBase64Url(code), new DecompressionStream('gzip')));
}

/** 共有コード(URL の #c= の後ろに付ける文字列) */
export async function encodeShareCode(c: Character): Promise<string> {
  return gzipText(JSON.stringify(characterToJson({ ...c, readOnly: false })));
}

export async function decodeShareCode(code: string): Promise<Character> {
  return parseCharacter(await gunzipText(code));
}

// ---- 試合のリプレイ(シードと両キャラのデータだけ) ----

export interface SharedReplay {
  seed: number;
  names: [string, string];
  fighters: [FighterData, FighterData];
}

interface ReplayJson {
  kind: 'battle-replay';
  seed: number;
  characters: [CharacterJson, CharacterJson];
}

function fighterJson(name: string, f: FighterData): CharacterJson {
  return characterToJson({ name, blueprint: f.blueprint, motor: f.motor, decision: f.decision, progress: { passed: [], generations: {} } });
}

export function replayToJson(r: SharedReplay): string {
  const json: ReplayJson = { kind: 'battle-replay', seed: r.seed, characters: [fighterJson(r.names[0], r.fighters[0]), fighterJson(r.names[1], r.fighters[1])] };
  return JSON.stringify(json);
}

/** リプレイの JSON を検証して読み込む(BOT の突進のような判断脳のない相手も、脳ありのキャラとして扱う) */
export function parseReplay(text: string): SharedReplay {
  const json = JSON.parse(text) as Partial<ReplayJson>;
  if (json.kind !== 'battle-replay' || !Array.isArray(json.characters) || json.characters.length !== 2) throw new Error('リプレイのデータではありません');
  if (typeof json.seed !== 'number' || !Number.isInteger(json.seed)) throw new Error('リプレイのシードが不正です');
  const cs = json.characters.map((c) => parseCharacter(c));
  const fighters = cs.map((c): FighterData => {
    if (!c.motor) throw new Error('リプレイのキャラに運動脳がありません');
    return { blueprint: c.blueprint, motor: c.motor, decision: c.decision, controller: c.decision ? 'brain' : 'rush' };
  });
  return { seed: json.seed, names: [cs[0].name, cs[1].name], fighters: [fighters[0], fighters[1]] };
}

export async function replayShareUrl(r: SharedReplay): Promise<string> {
  return `${location.origin}${location.pathname}#${REPLAY_KEY}=${await gzipText(replayToJson(r))}`;
}

export function replayCodeFromLocation(): string | null {
  const m = location.hash.match(new RegExp(`[#&]${REPLAY_KEY}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

export async function decodeReplayCode(code: string): Promise<SharedReplay> {
  return parseReplay(await gunzipText(code));
}

export function downloadReplay(r: SharedReplay): void {
  download(replayToJson(r), `${r.names[0]}_vs_${r.names[1]}.replay.json`);
}

function download(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function shareUrl(c: Character): Promise<string> {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#${HASH_KEY}=${await encodeShareCode(c)}`;
}

/** 開いた URL に共有コードが付いていれば取り出す */
export function shareCodeFromLocation(): string | null {
  const m = location.hash.match(new RegExp(`[#&]${HASH_KEY}=([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}

export function clearShareHash(): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/** `.monster.json` としてダウンロードさせる */
export function downloadCharacter(c: Character): void {
  download(JSON.stringify(characterToJson(c), null, 2), `${c.name || 'monster'}.monster.json`);
}

export async function readCharacterFile(file: File): Promise<Character> {
  if (file.size > 1_000_000) throw new Error('ファイルが大きすぎます');
  return parseCharacter(await file.text());
}
