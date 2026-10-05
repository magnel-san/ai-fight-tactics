// トップ画面。キャラクリエイト・トレーニング・バトル・試運転を切り替える。
import { useCallback, useState } from 'react';
import { newCharacter, rebuildBody, type Character } from '../core/character';
import type { Blueprint } from '../core/creature/blueprint';
import { QUADRUPED } from '../core/creature/samples';
import { CreateScene } from '../scenes/create/CreateScene';
import { TrainScene } from '../scenes/train/TrainScene';
import { DeterminismCheck } from './DeterminismCheck';
import { PhysicsPreview } from './PhysicsPreview';

type Tab = 'create' | 'train' | 'test';

const TABS: { id: Tab; label: string }[] = [
  { id: 'create', label: 'キャラクリエイト' },
  { id: 'train', label: 'トレーニング' },
  { id: 'test', label: '試運転' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('create');
  const [character, setCharacter] = useState<Character>(() => newCharacter('ころがりくん', QUADRUPED));
  /** 体を組み直した回数。トレーニング画面を作り直すのに使う */
  const [bodyVersion, setBodyVersion] = useState(0);

  // 体を組み直すと運動脳はリセットする(仕様書セクション4)
  const setBlueprint = useCallback((bp: Blueprint) => {
    setCharacter((c) => rebuildBody(c, bp));
    setBodyVersion((v) => v + 1);
  }, []);

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
        <DeterminismCheck />
      </header>
      <main className="content">
        {/* 画面を切り替えても取り消し履歴や学習が続くよう、キャラクリエイトとトレーニングは隠すだけにする */}
        <div className="tab-page" hidden={tab !== 'create'}>
          <CreateScene blueprint={character.blueprint} onChange={setBlueprint} active={tab === 'create'} />
        </div>
        <div className="tab-page" hidden={tab !== 'train'}>
          <TrainScene key={bodyVersion} character={character} onChange={setCharacter} active={tab === 'train'} />
        </div>
        {tab === 'test' && (
          <div className="test">
            <PhysicsPreview blueprint={character.blueprint} />
          </div>
        )}
      </main>
    </div>
  );
}
