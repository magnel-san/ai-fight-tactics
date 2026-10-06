// オンライン機能(仕様書セクション2「オンライン(後期)」):Supabase へのキャラ登録と、対戦相手の取得。
// 対戦はすべて自分のブラウザ内で行い、サーバーにはキャラのデータだけを置く(非同期対戦)。
// 取得したキャラは信用せず、parseCharacter() で検証してから使う。
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Character } from '../core/character';
import { characterToJson, parseCharacter } from '../core/codec';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** 環境変数が設定されていればオンライン機能を使える */
export const onlineConfigured = !!URL && !!KEY;

let client: SupabaseClient | null = null;

export function supabaseClient(): SupabaseClient {
  if (!onlineConfigured) throw new Error('オンライン機能が設定されていません');
  client ??= createClient(URL!, KEY!, { auth: { persistSession: true } });
  return client;
}

/** サーバーのエラーを、わかりやすい文に直す */
export function serverError(error: { code?: string; message: string }): Error {
  // check 制約の違反:データが大きすぎる・ブロックが多すぎる、またはサーバーの設定(SQL)が古い
  if (error.code === '23514') {
    return new Error(
      'サーバーの条件に合わないため登録できませんでした。サーバーの設定が古い場合は、Supabase の SQL Editor で supabase/fix-format-version.sql を実行してください',
    );
  }
  return new Error(error.message);
}

/** 匿名ログイン(ブラウザごとに1人のユーザーになる) */
export async function ensureSession(): Promise<string> {
  const sb = supabaseClient();
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: signed, error } = await sb.auth.signInAnonymously();
  if (error || !signed.user) throw new Error(`ログインできませんでした:${error?.message ?? '不明なエラー'}`);
  return signed.user.id;
}

export interface OnlineCharacter {
  id: string;
  name: string;
  character: Character;
  mine: boolean;
  updatedAt: string;
}

interface Row {
  id: string;
  owner: string;
  name: string;
  data: unknown;
  updated_at: string;
}

function toOnline(row: Row, me: string): OnlineCharacter | null {
  try {
    return { id: row.id, name: row.name, character: parseCharacter(row.data), mine: row.owner === me, updatedAt: row.updated_at };
  } catch {
    // 形式の合わないデータ(古い・壊れている・不正)は無視する
    return null;
  }
}

/** キャラを登録する(すでに登録したキャラなら上書きする) */
export async function registerCharacter(c: Character, onlineId?: string): Promise<string> {
  if (!c.motor || !c.decision) throw new Error('運動脳と判断脳を鍛えたキャラだけ登録できます');
  await ensureSession();
  const json = characterToJson({ ...c, readOnly: false });
  const sb = supabaseClient();
  if (onlineId) {
    const { error } = await sb.from('characters').update({ name: c.name, data: json }).eq('id', onlineId);
    if (error) throw serverError(error);
    return onlineId;
  }
  const { data, error } = await sb.from('characters').insert({ name: c.name, data: json }).select('id').single();
  if (error) throw serverError(error);
  return (data as { id: string }).id;
}

/** 自分が登録したキャラの一覧(名前と更新日時だけ。キャラのデータ本体は取得しない) */
export interface MyOnlineCharacter {
  id: string;
  name: string;
  updatedAt: string;
}

export async function myCharacters(): Promise<MyOnlineCharacter[]> {
  const me = await ensureSession();
  const { data, error } = await supabaseClient().from('characters').select('id, name, updated_at').eq('owner', me).order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data as { id: string; name: string; updated_at: string }[]).map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }));
}

/** ランダムな対戦相手(自分以外のキャラ) */
export async function randomOpponents(n = 8): Promise<OnlineCharacter[]> {
  const me = await ensureSession();
  const { data, error } = await supabaseClient().rpc('random_characters', { n });
  if (error) throw new Error(error.message);
  return (data as Row[]).map((r) => toOnline(r, me)).filter((x): x is OnlineCharacter => x !== null);
}

export async function unregister(id: string): Promise<void> {
  await ensureSession();
  const { error } = await supabaseClient().from('characters').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
