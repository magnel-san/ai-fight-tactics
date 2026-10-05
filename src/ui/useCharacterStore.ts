// キャラの保存と切り替えをまとめたフック。
// 編集中のキャラは変更のたびに少し待ってから IndexedDB へ自動保存する(学習中は世代ごとに保存される)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { newCharacter, type Character } from '../core/character';
import { QUADRUPED } from '../core/creature/samples';
import {
  addToPool,
  deleteCharacter,
  listCharacters,
  listPool,
  loadCharacter,
  newId,
  removeFromPool,
  saveCharacter,
  setSetting,
  getSetting,
  type PoolEntry,
  type StoredCharacter,
} from '../storage/db';
import { clearShareHash, decodeReplayCode, decodeShareCode, replayCodeFromLocation, shareCodeFromLocation, type SharedReplay } from '../storage/share';

const SAVE_DELAY = 800;

export interface CharacterStore {
  ready: boolean;
  activeId: string;
  character: Character;
  setCharacter(update: Character | ((c: Character) => Character)): void;
  library: StoredCharacter[];
  pool: PoolEntry[];
  /** 共有URLで受け取ったキャラの名前(受け取った直後の案内用) */
  received: string | null;
  /** 共有URLで受け取った試合のリプレイ */
  sharedReplay: SharedReplay | null;
  dismissReceived(): void;
  error: string | null;
  create(): Promise<void>;
  select(id: string): Promise<void>;
  duplicate(): Promise<void>;
  remove(id: string): Promise<void>;
  importCharacter(c: Character, source: StoredCharacter['source']): Promise<void>;
  addPool(name: string, c: Character): Promise<void>;
  removePool(id: string): Promise<void>;
  refresh(): Promise<void>;
}

export function useCharacterStore(): CharacterStore {
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [character, setCharacterState] = useState<Character>(() => newCharacter('ころがりくん', QUADRUPED));
  const [library, setLibrary] = useState<StoredCharacter[]>([]);
  const [pool, setPool] = useState<PoolEntry[]>([]);
  const [received, setReceived] = useState<string | null>(null);
  const [sharedReplay, setSharedReplay] = useState<SharedReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdRef = useRef('');
  activeIdRef.current = activeId;
  const characterRef = useRef(character);
  characterRef.current = character;

  const refresh = useCallback(async () => {
    setLibrary(await listCharacters());
    setPool(await listPool());
  }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (activeIdRef.current) await saveCharacter(activeIdRef.current, characterRef.current);
  }, []);

  // 起動時:共有URLで来たキャラを受け取り、前回のキャラを開く
  // (開発時の StrictMode では effect が2回呼ばれるので、1回だけ実行する)
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const code = shareCodeFromLocation();
        if (code) {
          try {
            const c = await decodeShareCode(code);
            await saveCharacter(newId(), { ...c, readOnly: true }, 'received');
            setReceived(c.name);
          } catch (e) {
            setError(`共有されたキャラを読めませんでした:${(e as Error).message}`);
          }
          clearShareHash();
        }
        const replayCode = replayCodeFromLocation();
        if (replayCode) {
          try {
            setSharedReplay(await decodeReplayCode(replayCode));
          } catch (e) {
            setError(`共有されたリプレイを読めませんでした:${(e as Error).message}`);
          }
          clearShareHash();
        }
        const lastId = await getSetting<string>('activeId');
        const loaded = lastId ? await loadCharacter(lastId) : null;
        if (loaded && loaded.source === 'mine') {
          setActiveId(lastId!);
          setCharacterState(loaded.character);
        } else {
          const id = newId();
          await saveCharacter(id, characterRef.current);
          await setSetting('activeId', id);
          setActiveId(id);
        }
        await refresh();
      } catch (e) {
        setError(`保存データを開けませんでした(このブラウザでは保存できないかもしれません):${(e as Error).message}`);
      }
      setReady(true);
    })();
  }, [refresh]);

  // ページを閉じる前に保存する
  useEffect(() => {
    const onHide = () => void flush();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [flush]);

  const setCharacter = useCallback(
    (update: Character | ((c: Character) => Character)) => {
      setCharacterState((prev) => (typeof update === 'function' ? update(prev) : update));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        if (activeIdRef.current) {
          void saveCharacter(activeIdRef.current, characterRef.current).then(refresh, (e) => setError(String(e)));
        }
      }, SAVE_DELAY);
    },
    [refresh],
  );

  const open = useCallback(
    async (id: string, c: Character) => {
      setActiveId(id);
      setCharacterState(c);
      await setSetting('activeId', id);
      await refresh();
    },
    [refresh],
  );

  return {
    ready,
    activeId,
    character,
    setCharacter,
    library,
    pool,
    received,
    sharedReplay,
    dismissReceived: () => setReceived(null),
    error,
    async create() {
      await flush();
      const c = newCharacter('新しいキャラ', QUADRUPED);
      const id = newId();
      await saveCharacter(id, c);
      await open(id, c);
    },
    async select(id) {
      if (id === activeIdRef.current) return;
      await flush();
      const loaded = await loadCharacter(id);
      if (!loaded) return;
      if (loaded.source === 'received') {
        setError('受け取ったキャラは読み取り専用です(対戦と対戦相手プールへの登録ができます)');
        return;
      }
      await open(id, loaded.character);
    },
    async duplicate() {
      await flush();
      const c = { ...characterRef.current, name: `${characterRef.current.name}のコピー` };
      const id = newId();
      await saveCharacter(id, c);
      await open(id, c);
    },
    async remove(id) {
      await deleteCharacter(id);
      if (id === activeIdRef.current) {
        const rest = (await listCharacters()).filter((s) => s.source === 'mine');
        if (rest.length > 0) {
          const loaded = await loadCharacter(rest[0].id);
          if (loaded) await open(rest[0].id, loaded.character);
        } else {
          const c = newCharacter('ころがりくん', QUADRUPED);
          const nid = newId();
          await saveCharacter(nid, c);
          await open(nid, c);
        }
      }
      await refresh();
    },
    async importCharacter(c, source) {
      await saveCharacter(newId(), { ...c, readOnly: source === 'received' }, source);
      await refresh();
    },
    async addPool(name, c) {
      await addToPool(name, c);
      await refresh();
    },
    async removePool(id) {
      await removeFromPool(id);
      await refresh();
    },
    refresh,
  };
}
