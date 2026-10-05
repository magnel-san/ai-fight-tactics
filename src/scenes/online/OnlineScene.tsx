// オンライン画面:キャラを登録して、ほかのプレイヤーのキャラと非同期で対戦する。
// 対戦は自分のブラウザ内で行う。取得したキャラは「受け取ったキャラ」として保存して対戦できる。
import { useEffect, useState } from 'react';
import type { Character } from '../../core/character';
import { jointCount, totalCost } from '../../core/creature/blueprint';
import { TASKS } from '../../core/training/tasks';
import { myCharacters, onlineConfigured, randomOpponents, registerCharacter, unregister, type OnlineCharacter } from '../../online/client';
import { getSetting, setSetting } from '../../storage/db';

interface Props {
  charId: string;
  character: Character;
  active: boolean;
  /** 取得したキャラを受け取ったキャラとして保存し、対戦画面を開く */
  onBattle(c: Character): void;
  onAddToPool(c: Character): void;
}

export function OnlineScene({ charId, character, active, onBattle, onAddToPool }: Props) {
  const [mine, setMine] = useState<OnlineCharacter[]>([]);
  const [found, setFound] = useState<OnlineCharacter[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
    setBusy(false);
  };

  useEffect(() => {
    if (active && onlineConfigured) void run(async () => setMine(await myCharacters()));
  }, [active]);

  if (!onlineConfigured) {
    return (
      <div className="library">
        <section className="card">
          <h2>オンライン対戦(準備中)</h2>
          <p>
            オンライン機能を使うには、Supabase のプロジェクトが必要です。手順は <code>docs/ONLINE.md</code> にまとめてあります。
          </p>
          <ol className="help">
            <li>Supabase でプロジェクトを作り、匿名ログインを有効にする</li>
            <li>
              <code>supabase/schema.sql</code> を SQL Editor で実行する
            </li>
            <li>
              <code>.env.example</code> を <code>.env.local</code> にコピーして、URL とキーを書き込む
            </li>
            <li>開発サーバーを起動し直す(公開する場合はビルドし直す)</li>
          </ol>
        </section>
      </div>
    );
  }

  const ready = !!character.motor && !!character.decision;

  return (
    <div className="library">
      <section className="card">
        <h2>キャラを登録</h2>
        <p className="muted small">登録したキャラは、ほかのプレイヤーの対戦相手になります。対戦はそれぞれのブラウザの中で行われます。</p>
        <div className="row wrap">
          <button
            className="primary"
            disabled={!ready || busy}
            onClick={() =>
              run(async () => {
                const key = `online:${charId}`;
                const existing = await getSetting<string>(key);
                let id: string;
                try {
                  id = await registerCharacter(character, existing);
                } catch (e) {
                  // サーバー側で消えていたら新しく登録し直す
                  if (!existing) throw e;
                  id = await registerCharacter(character);
                }
                await setSetting(key, id);
                setMine(await myCharacters());
                setMessage({ text: `「${character.name}」を${existing ? '更新' : '登録'}しました`, error: false });
              })
            }
          >
            「{character.name}」を登録・更新
          </button>
        </div>
        {!ready && <p className="message">運動脳と判断脳を鍛えたキャラだけ登録できます</p>}
        {message && <p className={message.error ? 'message error' : 'message'}>{message.text}</p>}
        <h3>登録済み</h3>
        <ul className="list">
          {mine.length === 0 && <li className="muted">まだありません</li>}
          {mine.map((m) => (
            <li key={m.id}>
              <div>
                <div className="name">{m.name}</div>
                <div className="muted small">{new Date(m.updatedAt).toLocaleString()}</div>
              </div>
              <div className="actions">
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await unregister(m.id);
                      setMine(await myCharacters());
                    })
                  }
                >
                  登録を消す
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>対戦相手を探す</h2>
        <div className="row wrap">
          <button disabled={busy} onClick={() => run(async () => setFound(await randomOpponents(8)))}>
            ランダムに探す
          </button>
        </div>
        <ul className="list">
          {found.map((f) => (
            <li key={f.id}>
              <div>
                <div className="name">{f.name}</div>
                <div className="muted small">
                  コスト {totalCost(f.character.blueprint)}・関節 {jointCount(f.character.blueprint)}・合格{' '}
                  {f.character.progress.passed.map((t) => TASKS[t].label).join('、') || 'なし'}
                </div>
              </div>
              <div className="actions">
                <button onClick={() => onBattle(f.character)}>対戦</button>
                <button onClick={() => onAddToPool(f.character)}>トレーニングの相手に登録</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
