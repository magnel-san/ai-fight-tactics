// トップ画面。キャラクリエイト・トレーニング・バトル・マイキャラを切り替える。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { rebuildBody } from '../core/character';
import { parseCharacter } from '../core/codec';
import type { Blueprint } from '../core/creature/blueprint';
import type { FighterData } from '../core/training/tasks';
import { pushOpponents } from '../data/bots';
import { BattleScene, type BattleRecord, type OpponentEntry } from '../scenes/battle/BattleScene';
import { CreateScene } from '../scenes/create/CreateScene';
import { EventsScene } from '../scenes/events/EventsScene';
import { LibraryScene } from '../scenes/library/LibraryScene';
import { OnlineScene } from '../scenes/online/OnlineScene';
import { TrainScene, type TrainReplay } from '../scenes/train/TrainScene';
import { newId, saveCharacter, saveReplay, type StoredReplay } from '../storage/db';
import type { Opponent } from '../training/Trainer';
import { DeterminismCheck } from './DeterminismCheck';
import { useCharacterStore } from './useCharacterStore';

type Tab = 'create' | 'train' | 'battle' | 'events' | 'library' | 'online';

const TABS: { id: Tab; label: string }[] = [
  { id: 'create', label: 'キャラクリエイト' },
  { id: 'train', label: 'トレーニング' },
  { id: 'battle', label: 'バトル' },
  { id: 'events', label: '種目' },
  { id: 'library', label: 'マイキャラ' },
  { id: 'online', label: 'オンライン' },
];

const BOTS = pushOpponents();

export function App() {
  const store = useCharacterStore();
  const { character, setCharacter } = store;
  const [tab, setTab] = useState<Tab>('create');
  /** 体を組み直した回数。トレーニング画面を作り直すのに使う */
  const [bodyVersion, setBodyVersion] = useState(0);
  const [battleReplay, setBattleReplay] = useState<BattleRecord | null>(null);
  const [trainReplay, setTrainReplay] = useState<TrainReplay | null>(null);
  const [preferredOpponent, setPreferredOpponent] = useState<string | null>(null);

  // 共有URLで受け取ったリプレイはバトル画面で再生する
  useEffect(() => {
    if (store.ready && store.sharedReplay) {
      setBattleReplay(store.sharedReplay);
      setTab('battle');
    }
  }, [store.ready, store.sharedReplay]);

  // 体を組み直すと運動脳はリセットする(仕様書セクション4)
  const setBlueprint = useCallback(
    (bp: Blueprint) => {
      setCharacter((c) => rebuildBody(c, bp));
      setBodyVersion((v) => v + 1);
    },
    [setCharacter],
  );

  // バトルの相手:BOT、自分の他の保存キャラ、受け取ったキャラ
  const battleOpponents = useMemo<OpponentEntry[]>(() => {
    const list: OpponentEntry[] = BOTS.map((o, i) => ({ id: `bot-${i}`, label: o.label, kind: 'BOT', data: o.data }));
    for (const s of store.library) {
      if (s.id === store.activeId) continue;
      try {
        const c = parseCharacter(s.json);
        if (!c.motor || !c.decision) continue;
        list.push({
          id: s.id,
          label: c.name,
          kind: s.source === 'mine' ? '保存キャラ' : '受け取ったキャラ',
          data: { blueprint: c.blueprint, motor: c.motor, decision: c.decision, controller: 'brain' },
        });
      } catch {
        // 読めないデータは一覧に出さない
      }
    }
    // マイキャラ画面の「対戦」で選んだ相手を先頭にする
    if (preferredOpponent) list.sort((a, b) => (a.id === preferredOpponent ? -1 : b.id === preferredOpponent ? 1 : 0));
    return list;
  }, [store.library, store.activeId, preferredOpponent]);

  // ライバル練習試合の相手:対戦相手プール(受け取ったキャラ・過去の自分など)
  const rivalOpponents = useMemo<Opponent[]>(() => {
    const pool: Opponent[] = [];
    for (const p of store.pool) {
      try {
        const c = parseCharacter(p.json);
        if (c.motor && c.decision) pool.push({ label: p.name, data: { blueprint: c.blueprint, motor: c.motor, decision: c.decision, controller: 'brain' } });
      } catch {
        // 読めないデータは使わない
      }
    }
    return pool;
  }, [store.pool]);

  const onBattleFinished = useCallback((rec: BattleRecord) => {
    if (!rec.result) return;
    const r = rec.result;
    const outcome = r.winner === 0 ? '勝ち' : r.winner === 1 ? '負け' : '引き分け';
    void saveReplay({ id: newId(), kind: 'battle', title: `${rec.names[0]} vs ${rec.names[1]}(${outcome})`, createdAt: Date.now(), data: rec });
  }, []);

  const playReplay = (r: StoredReplay) => {
    const data = r.data as BattleRecord | TrainReplay;
    if ('type' in data && data.type === 'train') {
      setTrainReplay({ ...data, title: r.title });
      setTab('train');
    } else {
      setBattleReplay({ ...(data as BattleRecord) });
      setTab('battle');
    }
  };

  const addOpponentToPool = (entry: OpponentEntry) => {
    const d: FighterData = entry.data;
    void store.addPool(entry.label, {
      name: entry.label,
      blueprint: d.blueprint,
      motor: d.motor,
      decision: d.decision,
      progress: { passed: [], generations: {} },
    });
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1>AI Fight Tactics</h1>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'selected' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className="current-char" title="編集中のキャラ">
          {character.name}
        </span>
        <DeterminismCheck />
      </header>
      {store.received && (
        <div className="banner">
          「{store.received}」を受け取りました。マイキャラの「受け取ったキャラ」から対戦できます。
          <button onClick={() => setTab('library')}>マイキャラを開く</button>
          <button onClick={store.dismissReceived}>閉じる</button>
        </div>
      )}
      {store.error && <div className="banner error">{store.error}</div>}
      <main className="content">
        {!store.ready ? (
          <p className="loading">読み込み中…</p>
        ) : (
          <>
            {/* 画面を切り替えても取り消し履歴や学習が続くよう、各画面は隠すだけにする */}
            <div className="tab-page" hidden={tab !== 'create'}>
              <CreateScene key={store.activeId} blueprint={character.blueprint} onChange={setBlueprint} active={tab === 'create'} />
            </div>
            <div className="tab-page" hidden={tab !== 'train'}>
              <TrainScene
                key={`${store.activeId}:${bodyVersion}`}
                charId={store.activeId}
                character={character}
                onChange={setCharacter}
                opponents={BOTS}
                rivals={rivalOpponents}
                active={tab === 'train'}
                replayRequest={trainReplay}
              />
            </div>
            <div className="tab-page" hidden={tab !== 'battle'}>
              <BattleScene
                character={character}
                opponents={battleOpponents}
                active={tab === 'battle'}
                onFinished={onBattleFinished}
                replay={battleReplay}
                onAddToPool={addOpponentToPool}
              />
            </div>
            <div className="tab-page" hidden={tab !== 'events'}>
              <EventsScene character={character} entries={battleOpponents} active={tab === 'events'} />
            </div>
            <div className="tab-page scroll" hidden={tab !== 'library'}>
              <LibraryScene
                store={store}
                active={tab === 'library'}
                onPlayReplay={playReplay}
                onBattle={(id) => {
                  setPreferredOpponent(id);
                  setTab('battle');
                }}
              />
            </div>
            <div className="tab-page scroll" hidden={tab !== 'online'}>
              <OnlineScene
                charId={store.activeId}
                character={character}
                active={tab === 'online'}
                onBattle={async (c) => {
                  // オンラインで見つけた相手は「受け取ったキャラ」として保存して対戦する
                  const id = newId();
                  await saveCharacter(id, { ...c, readOnly: true }, 'received');
                  await store.refresh();
                  setPreferredOpponent(id);
                  setTab('battle');
                }}
                onAddToPool={(c) => void store.addPool(c.name, c)}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
