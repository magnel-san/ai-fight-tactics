// トップ画面。あそびかた・キャラ作成・トレーニング・対戦・オンライン・マイキャラを切り替える。
// 対戦(バトル・かけっこ・サッカー・ランダムマッチ)とオンライン(トーナメント配信・ランキング・出場登録・キャラ交換)は、
// タブの中でさらに切り替える。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { battleFighter, rebuildBody } from '../core/character';
import { parseCharacter } from '../core/codec';
import type { Blueprint } from '../core/creature/blueprint';
import type { FighterData } from '../core/training/tasks';
import { pushOpponents } from '../data/bots';
import { BattleScene, type BattleRecord, type OpponentEntry } from '../scenes/battle/BattleScene';
import { CreateScene } from '../scenes/create/CreateScene';
import { EVENT_REQUIRED_TASK, EventsScene, type EventMode } from '../scenes/events/EventsScene';
import { GuideScene, type GuideTarget } from '../scenes/guide/GuideScene';
import { LibraryScene } from '../scenes/library/LibraryScene';
import { OnlineScene } from '../scenes/online/OnlineScene';
import { RankedScene, type RankedView } from '../scenes/ranked/RankedScene';
import { TrainScene, type TrainReplay } from '../scenes/train/TrainScene';
import { getSetting, newId, saveCharacter, saveReplay, setSetting, type StoredReplay } from '../storage/db';
import type { Opponent } from '../training/Trainer';
import { DeterminismCheck } from './DeterminismCheck';
import { useCharacterStore } from './useCharacterStore';

type Tab = 'guide' | 'create' | 'train' | 'battle' | 'online' | 'library';
type BattleSub = 'battle' | EventMode;
type OnlineSub = RankedView | 'exchange';

const TABS: { id: Tab; label: string }[] = [
  { id: 'guide', label: 'あそびかた' },
  { id: 'create', label: 'キャラ作成' },
  { id: 'train', label: 'トレーニング' },
  { id: 'battle', label: '対戦' },
  { id: 'online', label: 'オンライン' },
  { id: 'library', label: 'マイキャラ' },
];

const BATTLE_SUBS: { id: BattleSub; label: string; note: string }[] = [
  { id: 'battle', label: 'バトル', note: '崩れるステージで1対1' },
  { id: 'race', label: 'かけっこ', note: 'ゴールまでのタイムを競う' },
  { id: 'jump', label: 'ジャンプ', note: 'どれだけ高く跳べるかを競う' },
  { id: 'soccer', label: 'サッカー', note: '3対3でボールを押し込む' },
  { id: 'random', label: 'ランダムマッチ', note: 'オンラインの相手と自動で対戦(レートあり)' },
];

const ONLINE_SUBS: { id: OnlineSub; label: string; note: string }[] = [
  { id: 'live', label: 'トーナメント配信', note: '30分ごとの自動トーナメントを観戦' },
  { id: 'ranking', label: 'ランキング', note: 'レート・勝利数・かけっこの記録' },
  { id: 'entry', label: '出場登録', note: 'プレイヤー名とトーナメントに出すモンスター' },
  { id: 'exchange', label: 'キャラ交換', note: 'キャラを公開して、ほかの人のキャラと練習試合' },
];

const BOTS = pushOpponents();

export function App() {
  const store = useCharacterStore();
  const { character, setCharacter } = store;
  const [tab, setTab] = useState<Tab>('create');
  const [battleSub, setBattleSub] = useState<BattleSub>('battle');
  const [onlineSub, setOnlineSub] = useState<OnlineSub>('live');

  // 初めて開いたときは「あそびかた」を表示する
  useEffect(() => {
    void getSetting<boolean>('seen-guide').then((seen) => {
      if (!seen) {
        setTab('guide');
        void setSetting('seen-guide', true);
      }
    });
  }, []);

  const openBattle = (sub: BattleSub = 'battle') => {
    setBattleSub(sub);
    setTab('battle');
  };

  const go = (target: GuideTarget) => {
    if (target === 'battle' || target === 'race') openBattle(target);
    else if (target === 'ranked-entry' || target === 'ranked-live') {
      setOnlineSub(target === 'ranked-entry' ? 'entry' : 'live');
      setTab('online');
    } else setTab(target);
  };
  /** 体を組み直した回数。トレーニング画面を作り直すのに使う */
  const [bodyVersion, setBodyVersion] = useState(0);
  const [battleReplay, setBattleReplay] = useState<BattleRecord | null>(null);
  const [trainReplay, setTrainReplay] = useState<TrainReplay | null>(null);
  const [preferredOpponent, setPreferredOpponent] = useState<string | null>(null);

  // 共有URLで受け取ったリプレイはバトル画面で再生する
  useEffect(() => {
    if (store.ready && store.sharedReplay) {
      setBattleReplay(store.sharedReplay);
      openBattle();
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
        // 運動脳があれば戦える(判断脳がなければ突進する)
        const data = battleFighter(c);
        if (!data) continue;
        list.push({
          id: s.id,
          label: c.name,
          kind: s.source === 'mine' ? '保存キャラ' : '受け取ったキャラ',
          data,
          passed: c.progress.passed,
        });
      } catch {
        // 読めないデータは一覧に出さない
      }
    }
    // マイキャラ画面の「対戦」で選んだ相手を先頭にする
    if (preferredOpponent) list.sort((a, b) => (a.id === preferredOpponent ? -1 : b.id === preferredOpponent ? 1 : 0));
    return list;
  }, [store.library, store.activeId, preferredOpponent]);

  // 種目に参加できるのは「対象を追う」に合格したキャラだけ(BOT は合格済み)
  const eventEntries = useMemo(() => battleOpponents.filter((e) => !e.passed || e.passed.includes(EVENT_REQUIRED_TASK)), [battleOpponents]);

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
      openBattle();
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
        <span className="current-char" title="いま育てているキャラ(マイキャラで切り替え)">
          {character.name}
          <span className="muted small">
            {' '}
            ・合格 {character.progress.passed.length}
          </span>
        </span>
        <DeterminismCheck />
      </header>
      {tab === 'battle' && (
        <nav className="subtabs">
          {BATTLE_SUBS.map((x) => (
            <button key={x.id} className={battleSub === x.id ? 'selected' : ''} onClick={() => setBattleSub(x.id)} title={x.note}>
              {x.label}
            </button>
          ))}
        </nav>
      )}
      {tab === 'online' && (
        <nav className="subtabs">
          {ONLINE_SUBS.map((x) => (
            <button key={x.id} className={onlineSub === x.id ? 'selected' : ''} onClick={() => setOnlineSub(x.id)} title={x.note}>
              {x.label}
            </button>
          ))}
        </nav>
      )}
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
            <div className="tab-page scroll" hidden={tab !== 'guide'}>
              <GuideScene character={character} onGo={go} />
            </div>
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
            <div className="tab-page" hidden={tab !== 'battle' || battleSub !== 'battle'}>
              <BattleScene
                character={character}
                opponents={battleOpponents}
                active={tab === 'battle' && battleSub === 'battle'}
                onFinished={onBattleFinished}
                replay={battleReplay}
                onAddToPool={addOpponentToPool}
              />
            </div>
            <div className="tab-page" hidden={tab !== 'battle' || battleSub === 'battle'}>
              <EventsScene
                charId={store.activeId}
                character={character}
                entries={eventEntries}
                active={tab === 'battle' && battleSub !== 'battle'}
                mode={battleSub === 'battle' ? 'race' : battleSub}
              />
            </div>
            <div className="tab-page" hidden={tab !== 'online' || onlineSub === 'exchange'}>
              <RankedScene
                charId={store.activeId}
                character={character}
                active={tab === 'online' && onlineSub !== 'exchange'}
                view={onlineSub === 'exchange' ? 'live' : onlineSub}
              />
            </div>
            <div className="tab-page scroll" hidden={tab !== 'library'}>
              <LibraryScene
                store={store}
                active={tab === 'library'}
                onPlayReplay={playReplay}
                onBattle={(id) => {
                  setPreferredOpponent(id);
                  openBattle();
                }}
              />
            </div>
            <div className="tab-page scroll" hidden={tab !== 'online' || onlineSub !== 'exchange'}>
              <OnlineScene
                charId={store.activeId}
                character={character}
                active={tab === 'online' && onlineSub === 'exchange'}
                onBattle={async (c) => {
                  // オンラインで見つけた相手は「受け取ったキャラ」として保存して対戦する
                  const id = newId();
                  await saveCharacter(id, { ...c, readOnly: true }, 'received');
                  await store.refresh();
                  setPreferredOpponent(id);
                  openBattle();
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
