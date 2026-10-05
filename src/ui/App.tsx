// トップ画面。今はキャラクリエイトと試運転の2つを切り替える。
import { useState } from 'react';
import type { Blueprint } from '../core/creature/blueprint';
import { QUADRUPED } from '../core/creature/samples';
import { CreateScene } from '../scenes/create/CreateScene';
import { DeterminismCheck } from './DeterminismCheck';
import { PhysicsPreview } from './PhysicsPreview';

type Tab = 'create' | 'test';

export function App() {
  const [tab, setTab] = useState<Tab>('create');
  const [blueprint, setBlueprint] = useState<Blueprint>(QUADRUPED);

  return (
    <div className="app">
      <header className="topbar">
        <h1>AI Fight Tactics</h1>
        <nav>
          <button className={tab === 'create' ? 'selected' : ''} onClick={() => setTab('create')}>
            キャラクリエイト
          </button>
          <button className={tab === 'test' ? 'selected' : ''} onClick={() => setTab('test')}>
            試運転
          </button>
        </nav>
        <DeterminismCheck />
      </header>
      <main className="content">
        {/* 試運転から戻っても取り消し履歴やカメラが残るよう、キャラクリエイトは隠すだけにする */}
        <div className="tab-page" hidden={tab !== 'create'}>
          <CreateScene blueprint={blueprint} onChange={setBlueprint} active={tab === 'create'} />
        </div>
        {tab === 'test' && (
          <div className="test">
            <PhysicsPreview blueprint={blueprint} />
          </div>
        )}
      </main>
    </div>
  );
}
