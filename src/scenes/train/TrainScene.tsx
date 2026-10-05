// トレーニング画面(仕様書セクション9・10)。
// メニューを順に解放しながら学習させる。学習はWorkerで進め、画面では最新の世代の最優秀個体のエピソードを
// シードから再現して観戦する(上位個体は半透明のゴーストで重ねる)。
import { useEffect, useRef, useState } from 'react';
import { createDecisionGenome } from '../../core/brain/decision';
import { createMotorGenome } from '../../core/brain/motor';
import type { Character } from '../../core/character';
import { TRAINING } from '../../core/config';
import { jointCount } from '../../core/creature/blueprint';
import { Rng } from '../../core/math/rng';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import type { Episode } from '../../core/training/episode';
import { isUnlocked, TASK_ORDER, TASKS, type TaskName, type TaskSetup } from '../../core/training/tasks';
import { pushOpponents } from '../../data/bots';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { Trainer, type GenerationReport } from '../../training/Trainer';
import { defaultWorkerCount } from '../../training/WorkerPool';
import { FitnessChart } from './FitnessChart';

interface Props {
  character: Character;
  onChange(update: (c: Character) => Character): void;
  /** 表示中か */
  active: boolean;
}

type Speed = 1 | 4 | 0;

/** UI側で使うシード(core の外なので Math.random を使ってよい) */
const randomSeed = () => (Math.random() * 2 ** 32) | 0;

/** 再生するもの */
interface ReplaySource {
  task: TaskName;
  genome: Float64Array;
  ghosts: Float64Array[];
  seeds: number[];
  setup: TaskSetup;
  generation: number;
  cursor: number;
}

function setupFor(c: Character, task: TaskName): TaskSetup {
  return { blueprint: c.blueprint, motor: c.motor, decision: c.decision, level: task === 'survive' ? (c.progress.surviveLevel ?? 1) : 3, opponent: null };
}

export function TrainScene({ character, onChange, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const trainerRef = useRef<Trainer | null>(null);
  const [task, setTask] = useState<TaskName>(() => TASK_ORDER.find((t) => isUnlocked(t, character.progress.passed) && !character.progress.passed.includes(t)) ?? 'move');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [showGhosts, setShowGhosts] = useState(true);
  const [histories, setHistories] = useState<Partial<Record<TaskName, GenerationReport[]>>>({});
  const [error, setError] = useState<string | null>(null);
  const [replayLabel, setReplayLabel] = useState('');

  const characterRef = useRef(character);
  characterRef.current = character;
  const ghostsRef = useRef(showGhosts);
  ghostsRef.current = showGhosts;
  const replay = useRef<ReplaySource | null>(null);

  const def = TASKS[task];
  const history = histories[task] ?? [];
  const passedList = character.progress.passed;
  const opponents = pushOpponents();

  /** 鍛える脳の現在の遺伝子(なければ新しく作る) */
  const currentGenome = (c: Character, t: TaskName): Float64Array =>
    TASKS[t].brain === 'motor'
      ? (c.motor ?? createMotorGenome(jointCount(c.blueprint), new Rng(randomSeed())))
      : (c.decision ?? createDecisionGenome(new Rng(randomSeed())));

  /** まだ学習していないとき、今の脳の動きを見せる */
  const resetReplay = (t: TaskName) => {
    const c = characterRef.current;
    if (TASKS[t].brain === 'decision' && !c.motor) {
      replay.current = null;
      return;
    }
    const setup = setupFor(c, t);
    if (t === 'push') setup.opponent = opponents[0]?.data ?? null;
    replay.current = {
      task: t,
      genome: currentGenome(c, t),
      ghosts: [],
      seeds: [randomSeed()],
      setup,
      generation: -1,
      cursor: 0,
    };
  };

  // 3D表示と Rapier の準備
  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewerRef.current = viewer;
    let cancelled = false;

    const playNext = () => {
      const R = rapierRef.current;
      const r = replay.current;
      if (!R || !r) return;
      const d = TASKS[r.task];
      const index = r.cursor % r.seeds.length;
      r.cursor++;
      const sector = { index, count: r.seeds.length };
      const make = (g: Float64Array): Episode => {
        const setup = d.brain === 'motor' ? { ...r.setup, motor: g } : r.setup;
        return d.createEpisode(R, setup, g, r.seeds[index], sector, 'train');
      };
      try {
        const main = make(r.genome);
        // 押し合いは相手がいて重ねると見づらいので、ゴーストは1体のメニューだけ
        const ghosts = ghostsRef.current && main.fighters.length === 1 ? r.ghosts.slice(1).map(make) : [];
        viewer.setEpisodes(main, ghosts);
        setReplayLabel(r.generation < 0 ? '学習前の動き' : `第${r.generation + 1}世代の最優秀個体${ghosts.length ? `(上位${ghosts.length + 1}体)` : ''}`);
      } catch (e) {
        setError(String(e));
      }
    };
    viewer.onEpisodeEnd = playNext;

    initRapier().then((R) => {
      if (cancelled) return;
      rapierRef.current = R;
      resetReplay(task);
      playNext();
    });
    return () => {
      cancelled = true;
      viewer.dispose();
      viewerRef.current = null;
    };
    // 表示は最初に1回だけ作る。再生内容は replay.current で差し替える
  }, []);

  // 終了時に学習を止める
  useEffect(
    () => () => {
      trainerRef.current?.dispose();
      trainerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.speed = active ? speed : 0;
  }, [speed, active]);

  const stop = async () => {
    setRunning(false);
    const t = trainerRef.current;
    trainerRef.current = null;
    await t?.stop();
    t?.dispose();
  };

  const selectTask = async (t: TaskName) => {
    if (t === task) return;
    await stop();
    setTask(t);
    setError(null);
    resetReplay(t);
  };

  const start = () => {
    setError(null);
    const c = characterRef.current;
    const t = task;
    const d = TASKS[t];
    if (d.brain === 'decision' && !c.motor) {
      setError('先に運動脳を鍛えてください');
      return;
    }
    if (t === 'push' && opponents.length === 0) {
      setError('標準BOTのデータがまだありません');
      return;
    }
    // この学習を始める前までの世代数(観戦の表示に使う)
    const baseGeneration = c.progress.generations[t] ?? 0;
    try {
      const trainer = new Trainer(
        t,
        setupFor(c, t),
        currentGenome(c, t),
        randomSeed(),
        (r) => {
          onChange((prev) => {
            const generations = { ...prev.progress.generations, [t]: (prev.progress.generations[t] ?? 0) + 1 };
            const passed = r.passed && !prev.progress.passed.includes(t) ? [...prev.progress.passed, t] : prev.progress.passed;
            const next: Character = { ...prev, progress: { ...prev.progress, generations, passed } };
            if (d.brain === 'motor') next.motor = r.champion;
            else {
              next.decision = r.champion;
              next.decisionStale = false;
            }
            if (t === 'survive') next.progress.surviveLevel = r.setup.level;
            return next;
          });
          setHistories((h) => ({ ...h, [t]: [...(h[t] ?? []), r] }));
          replay.current = {
            task: t,
            genome: r.champion,
            ghosts: r.top,
            seeds: r.seeds,
            setup: d.brain === 'motor' ? { ...r.setup, motor: r.champion } : r.setup,
            generation: baseGeneration + r.generation,
            cursor: 0,
          };
        },
        (e) => {
          setError(e.message);
          setRunning(false);
        },
        t === 'push' ? opponents : [],
        c.progress.passed.includes(t),
      );
      trainerRef.current = trainer;
      trainer.start();
      setRunning(true);
    } catch (e) {
      setError(String(e));
    }
  };

  const last = history[history.length - 1];
  const lastConfirm = [...history].reverse().find((r) => r.confirm !== null);
  const totalSeconds = history.reduce((s, r) => s + r.seconds, 0);
  const passed = passedList.includes(task);
  const locked = !isUnlocked(task, passedList);
  const generations = character.progress.generations[task] ?? 0;

  return (
    <div className="train">
      <aside className="panel">
        <h2>トレーニング</h2>
        {character.decisionStale && <p className="message">体を組み直したので、判断脳の再トレーニングをおすすめします</p>}
        <div className="menu-list">
          {TASK_ORDER.map((t, i) => {
            const d = TASKS[t];
            const unlocked = isUnlocked(t, passedList);
            return (
              <button
                key={t}
                className={`menu-item${t === task ? ' selected' : ''}`}
                disabled={!unlocked}
                onClick={() => selectTask(t)}
                title={unlocked ? d.note : '前のメニューに合格すると解放されます'}
              >
                <span className="menu-title">
                  {i + 1}. {d.label}
                  {t === 'holes' && <span className="optional">任意</span>}
                </span>
                <span className="menu-meta">
                  {!unlocked ? '🔒 未解放' : passedList.includes(t) ? '✔ 合格' : `${d.brain === 'motor' ? '運動脳' : '判断脳'}`}
                  {(character.progress.generations[t] ?? 0) > 0 && ` ・${character.progress.generations[t]}世代`}
                </span>
              </button>
            );
          })}
        </div>

        <div className="menu-detail">
          <div className="menu-note">{def.note}</div>
          <div className={`badge ${passed ? 'ok' : ''}`}>{passed ? '合格' : `合格条件:${def.passCondition}`}</div>
        </div>

        <div className="row">
          {running ? (
            <button onClick={stop}>停止</button>
          ) : (
            <button className="primary" onClick={start} disabled={locked}>
              {generations > 0 ? '学習を再開' : '学習開始'}
            </button>
          )}
        </div>
        {error && <p className="message error">{error}</p>}

        <h2>状況</h2>
        <dl className="stats">
          <dt>世代</dt>
          <dd>{generations}</dd>
          {last?.stageLabel && (
            <>
              <dt>段階</dt>
              <dd>{last.stageLabel}</dd>
            </>
          )}
          <dt>最高 / 平均</dt>
          <dd>{last ? `${last.best.toFixed(2)} / ${last.mean.toFixed(2)}` : '-'}</dd>
          <dt>合格確認</dt>
          <dd>{lastConfirm ? `${lastConfirm.stageLabel ? `${lastConfirm.stageLabel}:` : ''}${lastConfirm.confirm!.text}` : '-'}</dd>
          <dt>σ</dt>
          <dd>{last ? last.sigma.toFixed(3) : TRAINING.sigmaInit}</dd>
          <dt>速さ</dt>
          <dd>
            {last ? `${last.seconds.toFixed(1)} 秒/世代` : '-'}(Worker {defaultWorkerCount()})
          </dd>
          <dt>学習時間</dt>
          <dd>
            {Math.floor(totalSeconds / 60)}分{Math.round(totalSeconds % 60)}秒
          </dd>
        </dl>

        <h2>成績グラフ</h2>
        <FitnessChart history={history} />
      </aside>

      <div className="viewport">
        <canvas ref={canvasRef} />
        <div className="hud">{replayLabel || '運動脳を鍛えると、ここに動きが表示されます'}</div>
        <div className="speed">
          <label className="ghost-toggle">
            <input type="checkbox" checked={showGhosts} onChange={(e) => setShowGhosts(e.target.checked)} />
            ゴースト
          </label>
          {([1, 4, 0] as Speed[]).map((s) => (
            <button key={s} className={speed === s ? 'selected' : ''} onClick={() => setSpeed(s)}>
              {s === 0 ? '描画なし' : `${s}倍`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
