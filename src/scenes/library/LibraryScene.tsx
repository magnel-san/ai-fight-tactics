// マイキャラ画面:保存したキャラの切り替え・名前の変更・共有(URL・ファイル)、受け取ったキャラ、
// 押し合いトレーニングの対戦相手プール、保存したリプレイの一覧。
import { useEffect, useRef, useState } from 'react';
import { jointCount, totalCost } from '../../core/creature/blueprint';
import { parseCharacter } from '../../core/codec';
import { TASKS } from '../../core/training/tasks';
import { deleteReplay, listReplays, type StoredReplay } from '../../storage/db';
import { downloadCharacter, readCharacterFile, shareUrl } from '../../storage/share';
import type { CharacterStore } from '../../ui/useCharacterStore';

interface Props {
  store: CharacterStore;
  active: boolean;
  onPlayReplay(r: StoredReplay): void;
  onBattle(characterId: string): void;
}

export function LibraryScene({ store, active, onPlayReplay, onBattle }: Props) {
  const { character } = store;
  const [url, setUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [replays, setReplays] = useState<StoredReplay[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const importAs = useRef<'mine' | 'received'>('received');

  useEffect(() => {
    if (active) void listReplays().then(setReplays);
  }, [active]);

  const mine = store.library.filter((s) => s.source === 'mine');
  const received = store.library.filter((s) => s.source === 'received');

  const makeUrl = async () => {
    try {
      const u = await shareUrl(character);
      setUrl(u);
      try {
        await navigator.clipboard.writeText(u);
        setMessage({ text: `共有URLをコピーしました(${u.length.toLocaleString()}文字)`, error: false });
      } catch {
        setMessage({ text: '共有URLを作りました。下の欄からコピーしてください', error: false });
      }
    } catch (e) {
      setMessage({ text: `共有URLを作れませんでした:${(e as Error).message}`, error: true });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const c = await readCharacterFile(file);
      await store.importCharacter(c, importAs.current);
      setMessage({ text: `「${c.name}」を${importAs.current === 'mine' ? '自分のキャラとして' : '受け取ったキャラとして'}読み込みました`, error: false });
    } catch (e) {
      setMessage({ text: `読み込めませんでした:${(e as Error).message}`, error: true });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const summary = (json: (typeof store.library)[number]['json']) => {
    try {
      const c = parseCharacter(json);
      return `コスト ${totalCost(c.blueprint)}・関節 ${jointCount(c.blueprint)}・合格 ${c.progress.passed.map((t) => TASKS[t].label).join('、') || 'なし'}`;
    } catch {
      return '読めないデータ';
    }
  };

  return (
    <div className="library">
      <section className="card">
        <h2>編集中のキャラ</h2>
        <label className="field">
          名前
          <input
            type="text"
            value={character.name}
            maxLength={40}
            onChange={(e) => store.setCharacter((c) => ({ ...c, name: e.target.value }))}
          />
        </label>
        <p className="muted">
          コスト {totalCost(character.blueprint)}・関節 {jointCount(character.blueprint)}・合格:
          {character.progress.passed.map((t) => TASKS[t].label).join('、') || 'なし'}
        </p>
        <div className="row wrap">
          <button className="primary" onClick={makeUrl}>
            共有URLを作る
          </button>
          <button onClick={() => downloadCharacter(character)}>ファイルに書き出す</button>
          <button onClick={() => store.duplicate()}>複製</button>
          <button onClick={() => store.create()}>新しいキャラ</button>
        </div>
        {url && <textarea className="share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />}
        {message && <p className={message.error ? 'message error' : 'message'}>{message.text}</p>}
      </section>

      <section className="card">
        <h2>自分のキャラ</h2>
        <ul className="list">
          {mine.map((s) => (
            <li key={s.id} className={s.id === store.activeId ? 'current' : ''}>
              <div>
                <div className="name">{s.json.name}</div>
                <div className="muted small">{summary(s.json)}</div>
              </div>
              <div className="actions">
                {s.id === store.activeId ? (
                  <span className="badge ok">編集中</span>
                ) : (
                  <>
                    <button onClick={() => store.select(s.id)}>開く</button>
                    <button onClick={() => onBattle(s.id)}>対戦</button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`「${s.json.name}」を削除しますか?`)) void store.remove(s.id);
                      }}
                    >
                      削除
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <button
            onClick={() => {
              importAs.current = 'mine';
              fileRef.current?.click();
            }}
          >
            自分のキャラとしてファイルを読み込む
          </button>
        </div>
      </section>

      <section className="card">
        <h2>受け取ったキャラ</h2>
        <p className="muted small">友人から受け取ったキャラは読み取り専用です。対戦と、押し合いトレーニングの相手への登録ができます。</p>
        <ul className="list">
          {received.length === 0 && <li className="muted">まだありません。共有URLを開くか、ファイルを読み込んでください。</li>}
          {received.map((s) => (
            <li key={s.id}>
              <div>
                <div className="name">{s.json.name}</div>
                <div className="muted small">{summary(s.json)}</div>
              </div>
              <div className="actions">
                <button onClick={() => onBattle(s.id)}>対戦</button>
                <button onClick={() => void store.addPool(s.json.name, parseCharacter(s.json))}>トレーニングの相手に登録</button>
                <button className="danger" onClick={() => void store.remove(s.id)}>
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <button
            onClick={() => {
              importAs.current = 'received';
              fileRef.current?.click();
            }}
          >
            友人のキャラのファイルを読み込む
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </section>

      <section className="card">
        <h2>押し合いトレーニングの相手(対戦相手プール)</h2>
        <p className="muted small">標準BOTに勝ったあと、ここに登録したキャラとも押し合いの練習をします。</p>
        <ul className="list">
          {store.pool.length === 0 && <li className="muted">まだありません。</li>}
          {store.pool.map((p) => (
            <li key={p.id}>
              <div className="name">{p.name}</div>
              <div className="actions">
                <button className="danger" onClick={() => void store.removePool(p.id)}>
                  外す
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="row wrap">
          <button onClick={() => void store.addPool(`${character.name}(${new Date().toLocaleDateString()})`, character)}>
            今のキャラを登録(過去の自分と練習する)
          </button>
        </div>
      </section>

      <section className="card">
        <h2>リプレイ</h2>
        <ul className="list">
          {replays.length === 0 && <li className="muted">まだありません。バトルの後や、トレーニングのマイルストーンで自動保存されます。</li>}
          {replays.map((r) => (
            <li key={r.id}>
              <div>
                <div className="name">{r.title}</div>
                <div className="muted small">
                  {r.kind === 'battle' ? 'バトル' : 'マイルストーン'}・{new Date(r.createdAt).toLocaleString()}
                </div>
              </div>
              <div className="actions">
                <button onClick={() => onPlayReplay(r)}>再生</button>
                <button
                  className="danger"
                  onClick={async () => {
                    await deleteReplay(r.id);
                    setReplays(await listReplays());
                  }}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
