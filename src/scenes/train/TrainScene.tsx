// トレーニング画面(仕様書セクション9・10)。
// メニューを順に解放しながら学習させる。学習はWorkerで進め、画面では最新の世代の最優秀個体のエピソードを
// シードから再現して観戦する(上位個体は半透明のゴーストで重ねる)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createDecisionGenome } from '../../core/brain/decision';
import { createMotorGenome } from '../../core/brain/motor';
import type { Character } from '../../core/character';
import { TRAINING } from '../../core/config';
import { jointCount } from '../../core/creature/blueprint';
import { Rng } from '../../core/math/rng';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import type { Episode, EpisodeFlags } from '../../core/training/episode';
import type { Sector } from '../../core/training/move';
import { isUnlocked, TASK_ORDER, TASKS, type TaskName, type TaskSetup } from '../../core/training/tasks';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { loadHistory, newId, saveHistory, saveReplay, type HistoryPoint } from '../../storage/db';
import { Trainer, type GenerationReport, type Opponent } from '../../training/Trainer';
import { defaultWorkerCount } from '../../training/WorkerPool';
import { AwayHighlights, BrainPanel, CompareView, MILESTONE_LABELS, Toasts, type AwaySummary, type Toast } from './extras';
import { FitnessChart } from './FitnessChart';

/** トレーニングのエピソードのリプレイ(マイルストーンの場面など) */
export interface TrainReplay {
  type: 'train';
  task: TaskName;
  setup: TaskSetup;
  genome: Float64Array;
  seed: number;
  sector: Sector;
  title?: string;
}

interface Props {
  charId: string;
  character: Character;
  onChange(update: (c: Character) => Character): void;
  /** 押し合いの相手(弱い順。標準BOTのあとに対戦相手プール) */
  opponents: Opponent[];
  active: boolean;
  /** 再生したいリプレイ(マイルストーンなど) */
  replayRequest: TrainReplay | null;
}

type Speed = 1 | 4 | 0;

/** UI側で使うシード(core の外なので Math.random を使ってよい) */
const randomSeed = () => (Math.random() * 2 ** 32) | 0;

/** 留守中のハイライトを出す、タブを離れていた時間の下限 [ms] */
const AWAY_MIN_MS = 30_000;

/** 再生するもの */
interface ReplaySource {
  task: TaskName;
  genome: Float64Array;
  ghosts: Float64Array[];
  seeds: number[];
  sectors?: Sector[];
  setup: TaskSetup;
  label: string;
  cursor: number;
  /** 1回だけ再生して、その後は学習中の最新個体に戻る */
  once?: boolean;
}

function setupFor(c: Character, task: TaskName): TaskSetup {
  return { blueprint: c.blueprint, motor: c.motor, decision: c.decision, level: task === 'survive' ? (c.progress.surviveLevel ?? 1) : 3, opponent: null };
}

/** 鍛える脳が運動脳なら、setup の運動脳を遺伝子に差し替える */
function withGenome(setup: TaskSetup, task: TaskName, genome: Float64Array): TaskSetup {
  return TASKS[task].brain === 'motor' ? { ...setup, motor: genome } : setup;
}

export function TrainScene({ charId, character, onChange, opponents, active, replayRequest }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const trainerRef = useRef<Trainer | null>(null);
  const episodeRef = useRef<Episode | null>(null);
  const [task, setTask] = useState<TaskName>(() => TASK_ORDER.find((t) => isUnlocked(t, character.progress.passed) && !character.progress.passed.includes(t)) ?? 'move');
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [showGhosts, setShowGhosts] = useState(true);
  const [showBrain, setShowBrain] = useState(false);
  const [reports, setReports] = useState<Partial<Record<TaskName, GenerationReport[]>>>({});
  const [points, setPoints] = useState<Partial<Record<TaskName, HistoryPoint[]>>>({});
  const [firstChampions, setFirstChampions] = useState<Partial<Record<TaskName, Float64Array>>>({});
  const [error, setError] = useState<string | null>(null);
  const [replayLabel, setReplayLabel] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [away, setAway] = useState<AwaySummary | null>(null);
  const [comparing, setComparing] = useState(false);
  const [population, setPopulation] = useState<number>(TRAINING.population);

  const characterRef = useRef(character);
  characterRef.current = character;
  const ghostsRef = useRef(showGhosts);
  ghostsRef.current = showGhosts;
  const replay = useRef<ReplaySource | null>(null);
  const latestTraining = useRef<ReplaySource | null>(null);
  const playNextRef = useRef<() => void>(() => {});

  const def = TASKS[task];
  const sessionReports = reports[task] ?? [];
  const history = points[task] ?? [];
  const passedList = character.progress.passed;

  // 保存してある学習履歴を読む
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded: Partial<Record<TaskName, HistoryPoint[]>> = {};
      for (const t of TASK_ORDER) loaded[t] = await loadHistory(charId, t);
      if (!cancelled) setPoints(loaded);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [charId]);

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
    replay.current = { task: t, genome: currentGenome(c, t), ghosts: [], seeds: [randomSeed()], setup, label: '今の脳の動き', cursor: 0 };
    latestTraining.current = null;
  };

  // 3D表示と Rapier の準備
  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewerRef.current = viewer;
    viewer.onFrame = (ep) => {
      episodeRef.current = ep;
    };
    let cancelled = false;

    const playNext = () => {
      const R = rapierRef.current;
      let r = replay.current;
      if (r?.once && r.cursor > 0) {
        // 1回だけの再生が終わったら、学習中の最新個体に戻る
        r = replay.current = latestTraining.current;
      }
      if (!R || !r) return;
      const d = TASKS[r.task];
      const index = r.cursor % r.seeds.length;
      r.cursor++;
      const sector = r.sectors?.[index] ?? { index, count: r.seeds.length };
      const make = (g: Float64Array): Episode => d.createEpisode(R, withGenome(r!.setup, r!.task, g), g, r!.seeds[index], sector, 'train');
      try {
        const main = make(r.genome);
        // 押し合いは相手がいて重ねると見づらいので、ゴーストは1体のメニューだけ
        const ghosts = ghostsRef.current && main.fighters.length === 1 ? r.ghosts.slice(1).map(make) : [];
        viewer.setEpisodes(main, ghosts);
        setReplayLabel(`${r.label}${ghosts.length ? `(上位${ghosts.length + 1}体を重ねて表示)` : ''}`);
      } catch (e) {
        setError(String(e));
      }
    };
    playNextRef.current = playNext;
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

  // 外から渡されたリプレイ(マイルストーンなど)を1回再生する
  useEffect(() => {
    if (!replayRequest) return;
    replay.current = {
      task: replayRequest.task,
      genome: replayRequest.genome,
      ghosts: [],
      seeds: [replayRequest.seed],
      sectors: [replayRequest.sector],
      setup: replayRequest.setup,
      label: replayRequest.title ?? 'リプレイ',
      cursor: 0,
      once: true,
    };
    playNextRef.current();
  }, [replayRequest]);

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

  // 放置学習:タブを離れている間も Worker で学習は続く。戻ってきたら留守中のハイライトを出す
  const awaySnapshot = useRef<{ at: number; generations: number; best: number | null; milestones: string[]; passed: string[] } | null>(null);
  useEffect(() => {
    const onVisibility = () => {
      const c = characterRef.current;
      const gens = Object.values(c.progress.generations).reduce((s, g) => s + (g ?? 0), 0);
      if (document.hidden) {
        if (!trainerRef.current?.isRunning) return;
        const last = points[task]?.[points[task]!.length - 1];
        awaySnapshot.current = { at: Date.now(), generations: gens, best: last?.best ?? null, milestones: [...(c.progress.milestones ?? [])], passed: [...c.progress.passed] };
      } else if (awaySnapshot.current) {
        const s = awaySnapshot.current;
        awaySnapshot.current = null;
        if (Date.now() - s.at < AWAY_MIN_MS || gens === s.generations) return;
        const now = points[task]?.[points[task]!.length - 1];
        setAway({
          minutes: Math.max(1, Math.round((Date.now() - s.at) / 60000)),
          generations: gens - s.generations,
          bestBefore: s.best,
          bestAfter: now?.best ?? null,
          milestones: (c.progress.milestones ?? []).filter((m) => !s.milestones.includes(m)).map((m) => MILESTONE_LABELS[m as keyof EpisodeFlags] ?? m),
          passed: c.progress.passed.filter((t) => !s.passed.includes(t)).map((t) => TASKS[t].label),
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [points, task]);

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
    playNextRef.current();
  };

  const dismissToast = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

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
      setError('押し合いの相手(標準BOT)のデータがありません');
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
        (r) => onReport(t, baseGeneration, r),
        (e) => {
          setError(e.message);
          setRunning(false);
        },
        t === 'push' ? opponents : [],
        c.progress.passed.includes(t),
        undefined,
        population,
      );
      trainerRef.current = trainer;
      trainer.start();
      setRunning(true);
    } catch (e) {
      setError(String(e));
    }
  };

  /** 1世代ごとの報告:脳と育成状況の更新、履歴の保存、マイルストーン、観戦の差し替え */
  const onReport = (t: TaskName, baseGeneration: number, r: GenerationReport) => {
    const d = TASKS[t];
    const c = characterRef.current;
    const generation = baseGeneration + r.generation;

    // マイルストーン(そのキャラで初めて起きたこと)
    const known = c.progress.milestones ?? [];
    const fresh = (Object.keys(r.moments) as (keyof EpisodeFlags)[]).filter((k) => !known.includes(k));
    for (const k of fresh) {
      const m = r.moments[k]!;
      const title = `${MILESTONE_LABELS[k]}(${c.name}・${d.label} 第${generation + 1}世代)`;
      setToasts((ts) => [...ts, { id: Date.now() + Math.random(), title: MILESTONE_LABELS[k], detail: `${d.label} 第${generation + 1}世代。リプレイを保存しました` }]);
      const data: TrainReplay = { type: 'train', task: t, setup: withGenome(r.setup, t, m.genome), genome: m.genome, seed: m.seed, sector: m.sector, title };
      void saveReplay({ id: newId(), kind: 'milestone', title, createdAt: Date.now(), data });
    }

    onChange((prev) => {
      const generations = { ...prev.progress.generations, [t]: (prev.progress.generations[t] ?? 0) + 1 };
      const passed = r.passed && !prev.progress.passed.includes(t) ? [...prev.progress.passed, t] : prev.progress.passed;
      const milestones = [...(prev.progress.milestones ?? []), ...fresh.filter((k) => !(prev.progress.milestones ?? []).includes(k))];
      const next: Character = { ...prev, progress: { ...prev.progress, generations, passed, milestones } };
      if (d.brain === 'motor') next.motor = r.champion;
      else {
        next.decision = r.champion;
        next.decisionStale = false;
      }
      if (t === 'survive') next.progress.surviveLevel = r.setup.level;
      return next;
    });
    if (r.passed && !c.progress.passed.includes(t)) {
      setToasts((ts) => [...ts, { id: Date.now() + Math.random(), title: `「${d.label}」に合格!`, detail: r.confirm?.text ?? '' }]);
    }

    setReports((h) => ({ ...h, [t]: [...(h[t] ?? []), r] }));
    setPoints((p) => {
      const list = [...(p[t] ?? []), { best: r.best, mean: r.mean, passed: r.passed }];
      void saveHistory(charId, t, list);
      return { ...p, [t]: list };
    });
    setFirstChampions((f) => (f[t] ? f : { ...f, [t]: r.champion }));

    const source: ReplaySource = {
      task: t,
      genome: r.champion,
      ghosts: r.top,
      seeds: r.seeds,
      setup: withGenome(r.setup, t, r.champion),
      label: `第${generation + 1}世代の最優秀個体`,
      cursor: 0,
    };
    latestTraining.current = source;
    if (!replay.current?.once) replay.current = source;
  };

  const makeCompare = useCallback(
    (side: 0 | 1): Episode | null => {
      const R = rapierRef.current;
      const last = sessionReports[sessionReports.length - 1];
      const first = firstChampions[task];
      if (!R || !last || !first) return null;
      const g = side === 0 ? first : last.champion;
      return TASKS[task].createEpisode(R, withGenome(last.setup, task, g), g, last.seeds[0], { index: 0, count: last.seeds.length }, 'train');
    },
    [sessionReports, firstChampions, task],
  );

  const last = sessionReports[sessionReports.length - 1];
  const lastConfirm = [...sessionReports].reverse().find((r) => r.confirm !== null);
  const totalSeconds = sessionReports.reduce((s, r) => s + r.seconds, 0);
  const passed = passedList.includes(task);
  const locked = !isUnlocked(task, passedList) || !!character.readOnly;
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

        <label className="inline-field" title="多いほど1世代に時間がかかるが、上達しやすい">
          個体数
          <select value={population} disabled={running} onChange={(e) => setPopulation(Number(e.target.value))}>
            {[TRAINING.populationMin, TRAINING.population, TRAINING.populationMax].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          {running ? (
            <button onClick={stop}>停止</button>
          ) : (
            <button className="primary" onClick={start} disabled={locked}>
              {generations > 0 ? '学習を再開' : '学習開始'}
            </button>
          )}
          <button onClick={() => setComparing(true)} disabled={!firstChampions[task] || sessionReports.length < 2} title="第1世代と最新世代を同じシードで並べて再生します">
            比較リプレイ
          </button>
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
          <label className="ghost-toggle">
            <input type="checkbox" checked={showBrain} onChange={(e) => setShowBrain(e.target.checked)} />
            脳の様子
          </label>
          {([1, 4, 0] as Speed[]).map((s) => (
            <button key={s} className={speed === s ? 'selected' : ''} onClick={() => setSpeed(s)}>
              {s === 0 ? '描画なし' : `${s}倍`}
            </button>
          ))}
        </div>
        {showBrain && (
          <div className="brain-wrap">
            <BrainPanel episodeRef={episodeRef} />
          </div>
        )}
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </div>
      {away && <AwayHighlights summary={away} onClose={() => setAway(null)} />}
      {comparing && (
        <CompareView
          make={makeCompare}
          labels={[`第${(character.progress.generations[task] ?? 0) - sessionReports.length + 1}世代`, `第${character.progress.generations[task] ?? 0}世代`]}
          onClose={() => setComparing(false)}
        />
      )}
    </div>
  );
}
