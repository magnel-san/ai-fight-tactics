// キャラの共有(仕様書セクション12)。
// URL共有:JSON を gzip(CompressionStream)で圧縮して base64url にし、`#c=` の後ろに付ける。
// ファイル共有:`.monster.json` としてダウンロード・読み込みする。
import type { Character } from '../core/character';
import { characterToJson, parseCharacter } from '../core/codec';

const HASH_KEY = 'c';

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

/** 共有コード(URL の #c= の後ろに付ける文字列) */
export async function encodeShareCode(c: Character): Promise<string> {
  const json = JSON.stringify(characterToJson({ ...c, readOnly: false }));
  return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream('gzip')));
}

export async function decodeShareCode(code: string): Promise<Character> {
  const bytes = await pipe(fromBase64Url(code), new DecompressionStream('gzip'));
  return parseCharacter(new TextDecoder().decode(bytes));
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
  const blob = new Blob([JSON.stringify(characterToJson(c), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name.replace(/[\\/:*?"<>|]/g, '_') || 'monster'}.monster.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function readCharacterFile(file: File): Promise<Character> {
  if (file.size > 1_000_000) throw new Error('ファイルが大きすぎます');
  return parseCharacter(await file.text());
}
