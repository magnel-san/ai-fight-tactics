// トレーニング画面(仕様書セクション9・10)。今はメニュー1「目標地点への移動」のみ。
// 学習はWorkerで進め、画面では最新の最優秀個体のエピソードをシードから再現して観戦する。
import { useEffect, useRef, useState } from 'react';
import { createMotorGenome } from '../../core/brain/motor';
import { MOVE_TASK, TRAINING } from '../../core/config';
import { jointCount, type Blueprint } from '../../core/creature/blueprint';
import { Rng } from '../../core/math/rng';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import { MoveEpisode } from '../../core/training/move';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { Trainer, type GenerationReport } from '../../training/Trainer';
import { defaultWorkerCount } from '../../training/WorkerPool';
import { FitnessChart } from './FitnessChart';

export interface MotorProgress {
  genome: Float64Array;
  generations: number;
  passed: boolean;
}

interface Props {
  blueprint: Blueprint;
  motor: MotorProgress | null;
  onMotorChange(m: MotorProgress): void;
}

type Speed = 1 | 4 | 0;

/** UI側で使うシード(core の外なので Math.random を使ってよい) */
const randomSeed = () => (Math.random() * 2 ** 32) | 0;

export function TrainScene({ blueprint, motor, onMotorChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const trainerRef = useRef<Trainer | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [history, setHistory] = useState<GenerationReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [replay, setReplay] = useState<{ generation: number; reached: boolean | null }>({ generation: -1, reached: null });

  // 観戦で次に再生するもの(Trainer のコールバックから更新する)
  const latest = useRef<{ genome: Float64Array; seeds: number[]; generation: number; cursor: number }>({
    genome: motor?.genome ?? createMotorGenome(jointCount(blueprint), new Rng(randomSeed())),
    seeds: [randomSeed()],
    generation: motor ? motor.generations - 1 : -1,
    cursor: 0,
  });
  const motorRef = useRef(motor);
  motorRef.current = motor;
  const historyRef = useRef(history);
  historyRef.current = history;

  // 3D表示と Rapier の準備
  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewerRef.current = viewer;
    let cancelled = false;

    const playNext = () => {
      const R = rapierRef.current;
      if (!R) return;
      const l = latest.current;
      const index = l.cursor % l.seeds.length;
      l.cursor++;
      // Workerで評価したのと同じシード・同じ方向の割り当てで再現する
      const ep = new MoveEpisode(R, blueprint, l.genome, l.seeds[index], { index, count: l.seeds.length });
      viewer.setEpisode(ep);
      setReplay({ generation: l.generation, reached: null });
    };
    viewer.onEpisodeEnd = () => {
      const ep = viewer.currentEpisode;
      if (ep) setReplay((r) => ({ ...r, reached: ep.result().reached }));
      playNext();
    };

    initRapier().then((R) => {
      if (cancelled) return;
      rapierRef.current = R;
      playNext();
    });
    return () => {
      cancelled = true;
      viewer.dispose();
      viewerRef.current = null;
    };
  }, [blueprint]);

  // 終了時に学習を止める
  useEffect(
    () => () => {
      trainerRef.current?.dispose();
      trainerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.speed = speed;
  }, [speed]);

  const start = () => {
    setError(null);
    if (!trainerRef.current) {
      const initial = motorRef.current?.genome ?? latest.current.genome;
      trainerRef.current = new Trainer(
        'move',
        blueprint,
        initial,
        randomSeed(),
        (r) => {
          const prev = motorRef.current;
          const generations = (prev?.generations ?? 0) + 1;
          onMotorChange({ genome: r.champion, generations, passed: (prev?.passed ?? false) || r.passed });
          setHistory((h) => [...h, r]);
          latest.current = { genome: r.champion, seeds: r.seeds, generation: generations - 1, cursor: 0 };
        },
        (e) => {
          setError(e.message);
          setRunning(false);
        },
      );
    }
    trainerRef.current.start();
    setRunning(true);
  };

  const stop = async () => {
    setRunning(false);
    await trainerRef.current?.stop();
  };

  const last = history[history.length - 1];
  const totalSeconds = history.reduce((s, r) => s + r.seconds, 0);
  const passed = motor?.passed ?? false;
  const lastConfirm = [...history].reverse().find((r) => r.confirm !== null);

  return (
    <div className="train">
      <aside className="panel">
        <h2>トレーニング</h2>
        <div className="menu-item selected">
          <div className="menu-title">1. 目標地点への移動</div>
          <div className="menu-note">運動脳を鍛える。{MOVE_TASK.targetDistMin}〜{MOVE_TASK.targetDistMax}m 先の目標へ向かう</div>
          <div className={`badge ${passed ? 'ok' : ''}`}>{passed ? '合格' : `合格条件:3回中${MOVE_TASK.passCount}回、${MOVE_TASK.timeLimit}秒以内に到達`}</div>
        </div>

        <div className="row">
          {running ? (
            <button onClick={stop}>停止</button>
          ) : (
            <button className="primary" onClick={start}>
              {history.length > 0 || motor ? '再開' : '学習開始'}
            </button>
          )}
        </div>
        {error && <p className="message error">{error}</p>}

        <h2>状況</h2>
        <dl className="stats">
          <dt>世代</dt>
          <dd>{motor?.generations ?? 0}</dd>
          <dt>最高</dt>
          <dd>{last ? last.best.toFixed(2) : '-'}</dd>
          <dt>平均</dt>
          <dd>{last ? last.mean.toFixed(2) : '-'}</dd>
          <dt>到達</dt>
          <dd>{last ? `最優秀個体 ${last.bestReached} / ${TRAINING.episodesPerGeneration}` : '-'}</dd>
          <dt>合格確認</dt>
          <dd>
            {lastConfirm
              ? `第${lastConfirm.generation + 1}世代:${lastConfirm.confirm!.reached} / ${lastConfirm.confirm!.episodes} 回到達(${MOVE_TASK.confirmPassCount}回で合格)`
              : '-'}
          </dd>
          <dt>σ</dt>
          <dd>{last ? last.sigma.toFixed(3) : TRAINING.sigmaInit}</dd>
          <dt>速さ</dt>
          <dd>
            {last ? `${last.seconds.toFixed(1)} 秒/世代` : '-'}(Worker {defaultWorkerCount()})
          </dd>
          <dt>学習時間</dt>
          <dd>{Math.floor(totalSeconds / 60)}分{Math.round(totalSeconds % 60)}秒</dd>
        </dl>

        <h2>成績グラフ</h2>
        <FitnessChart history={history} />
      </aside>

      <div className="viewport">
        <canvas ref={canvasRef} />
        <div className="hud">
          {replay.generation < 0 ? '学習前の動き' : `第${replay.generation + 1}世代の最優秀個体`}
          {replay.reached !== null && (replay.reached ? '・到達!' : '・時間切れ')}
        </div>
        <div className="speed">
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
