// ローカル保存(仕様書セクション12):IndexedDB に、キャラ・学習履歴・リプレイ・対戦相手プールを保存する。
// キャラは JSON 形式(codec.ts)で保存するので、形式のバージョン移行も読み込み時に行われる。
import type { Character } from '../core/character';
import { characterToJson, parseCharacter, type CharacterJson } from '../core/codec';
import type { TaskName } from '../core/training/tasks';

const DB_NAME = 'ai-fight-tactics';
const DB_VERSION = 1;

export interface StoredCharacter {
  id: string;
  /** mine = 自分で作ったキャラ、received = 受け取ったキャラ(読み取り専用) */
  source: 'mine' | 'received';
  json: CharacterJson;
  updatedAt: number;
}

/** 世代ごとの成績(グラフ用に小さくしたもの) */
export interface HistoryPoint {
  best: number;
  mean: number;
  passed: boolean;
}

export interface StoredHistory {
  /** `${キャラID}:${メニュー}` */
  id: string;
  points: HistoryPoint[];
}

export interface StoredReplay {
  id: string;
  /** battle = バトル、milestone = トレーニングの名場面、tournament = ランクマッチのトーナメント、random = ランダムマッチ */
  kind: 'battle' | 'milestone' | 'tournament' | 'random';
  title: string;
  createdAt: number;
  /** 再生に必要なデータ(シードと、試合時点のキャラのデータ) */
  data: unknown;
}

export interface PoolEntry {
  id: string;
  name: string;
  json: CharacterJson;
  addedAt: number;
}

type StoreName = 'characters' | 'histories' | 'replays' | 'pool' | 'settings';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ['characters', 'histories', 'replays', 'pool', 'settings'] as StoreName[]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = run(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

const put = <T>(store: StoreName, value: T) => request<IDBValidKey>(store, 'readwrite', (s) => s.put(value));
const get = <T>(store: StoreName, id: string) => request<T | undefined>(store, 'readonly', (s) => s.get(id));
const getAll = <T>(store: StoreName) => request<T[]>(store, 'readonly', (s) => s.getAll());
const remove = (store: StoreName, id: string) => request<undefined>(store, 'readwrite', (s) => s.delete(id));

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- キャラ ----

export async function saveCharacter(id: string, c: Character, source: StoredCharacter['source'] = 'mine'): Promise<void> {
  await put<StoredCharacter>('characters', { id, source, json: characterToJson(c), updatedAt: Date.now() });
}

export async function listCharacters(): Promise<StoredCharacter[]> {
  const all = await getAll<StoredCharacter>('characters');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadCharacter(id: string): Promise<{ character: Character; source: StoredCharacter['source'] } | null> {
  const s = await get<StoredCharacter>('characters', id);
  if (!s) return null;
  const character = parseCharacter(s.json);
  if (s.source === 'received') character.readOnly = true;
  return { character, source: s.source };
}

export async function deleteCharacter(id: string): Promise<void> {
  await remove('characters', id);
}

// ---- 学習履歴 ----

export async function loadHistory(charId: string, task: TaskName): Promise<HistoryPoint[]> {
  return (await get<StoredHistory>('histories', `${charId}:${task}`))?.points ?? [];
}

export async function saveHistory(charId: string, task: TaskName, points: HistoryPoint[]): Promise<void> {
  await put<StoredHistory>('histories', { id: `${charId}:${task}`, points });
}

// ---- リプレイ ----

export async function saveReplay(r: StoredReplay): Promise<void> {
  await put('replays', r);
}

export async function listReplays(): Promise<StoredReplay[]> {
  return (await getAll<StoredReplay>('replays')).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteReplay(id: string): Promise<void> {
  await remove('replays', id);
}

// ---- 対戦相手プール ----

export async function addToPool(name: string, c: Character): Promise<PoolEntry> {
  const entry: PoolEntry = { id: newId(), name, json: characterToJson(c), addedAt: Date.now() };
  await put('pool', entry);
  return entry;
}

export async function listPool(): Promise<PoolEntry[]> {
  return (await getAll<PoolEntry>('pool')).sort((a, b) => a.addedAt - b.addedAt);
}

export async function removeFromPool(id: string): Promise<void> {
  await remove('pool', id);
}

// ---- 設定 ----

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await get<{ id: string; value: T }>('settings', key))?.value;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await put('settings', { id: key, value });
}
