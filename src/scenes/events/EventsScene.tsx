// 種目の画面:かけっこ(最大4体)とサッカー(3対3)と、オンラインのランダムマッチ(1対1のバトル)。
// かけっことサッカーは運動脳だけで動く。
// 参加できるのは、トレーニング「対象を追う」に合格したキャラだけ(指令の方向へまっすぐ進めないと競技にならないため)。
// 参加するキャラは、自分のキャラと、バトルの対戦相手の一覧(BOT・保存キャラ・受け取ったキャラ)から選ぶ。
import { useEffect, useRef, useState } from 'react';
import { canEnter, ENTRY_REQUIRED_TASK, type Character } from '../../core/character';
import { RACE, SOCCER } from '../../core/config';
import { RaceEpisode, type RaceResult } from '../../core/events/race';
import { SoccerEpisode, type SoccerResult } from '../../core/events/soccer';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import { TASKS, type FighterData, type TaskName } from '../../core/training/tasks';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { TEAM_COLORS } from '../../render/creatureMesh';
import type { OpponentEntry } from '../battle/BattleScene';
import { RandomMatchPanel } from './RandomMatchPanel';

interface Props {
  /** いまのキャラの id(ランダムマッチでモンスターの識別子にする) */
  charId: string;
  character: Character;
  /** 参加できる相手(バトルの対戦相手の一覧と同じ) */
  entries: OpponentEntry[];
  active: boolean;
}

type Mode = 'race' | 'soccer' | 'random';
const NONE = '';
const ME = '__me__';
const randomSeed = () => (Math.random() * 2 ** 32) | 0;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** 種目に参加するために合格が必要なトレーニング(トーナメント・ランダムマッチと同じ) */
export const EVENT_REQUIRED_TASK: TaskName = ENTRY_REQUIRED_TASK;

export function EventsScene({ charId, character, entries, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const [mode, setMode] = useState<Mode>('race');
  const [speed, setSpeed] = useState<1 | 4>(1);
  // かけっこ:自分 + 最大3体
  const [runners, setRunners] = useState<string[]>([entries[1]?.id ?? entries[0]?.id ?? NONE, entries[0]?.id ?? NONE, NONE]);
  // サッカー:チームA(自分 + 2体)とチームB(3体)
  const [teamA, setTeamA] = useState<string[]>([ME, entries[1]?.id ?? NONE, entries[1]?.id ?? NONE]);
  const [teamB, setTeamB] = useState<string[]>([entries[0]?.id ?? NONE, entries[0]?.id ?? NONE, entries[0]?.id ?? NONE]);
  const [race, setRace] = useState<{ names: string[]; result: RaceResult | null; time: number } | null>(null);
  const [soccer, setSoccer] = useState<{ names: string[][]; result: SoccerResult; time: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastHud = useRef(0);

  const ready = canEnter(character);

  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewer.endPause = Infinity;
    viewerRef.current = viewer;
    let cancelled = false;
    initRapier().then((R) => {
      if (!cancelled) rapierRef.current = R;
    });
    return () => {
      cancelled = true;
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.speed = active ? speed : 0;
  }, [speed, active]);

  /** 選んだIDのキャラのデータと名前 */
  const pick = (id: string): { name: string; data: FighterData } | null => {
    if (id === ME) {
      return ready && character.motor
        ? { name: character.name, data: { blueprint: character.blueprint, motor: character.motor, decision: character.decision, controller: 'brain' } }
        : null;
    }
    const e = entries.find((x) => x.id === id);
    return e ? { name: e.label, data: e.data } : null;
  };

  const startRace = () => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer) return;
    setError(null);
    setSoccer(null);
    const chosen = [ME, ...runners].map(pick).filter((x): x is NonNullable<typeof x> => x !== null);
    if (chosen.length === 0) {
      setError(`トレーニング「${TASKS[EVENT_REQUIRED_TASK].label}」に合格したキャラが必要です`);
      return;
    }
    const ep = new RaceEpisode(R, chosen.map((c) => c.data), randomSeed());
    const names = chosen.map((c) => c.name);
    setRace({ names, result: null, time: 0 });
    viewer.onFrame = (e) => {
      const r = e as RaceEpisode;
      const now = performance.now();
      if (now - lastHud.current > 150 || r.done) {
        lastHud.current = now;
        setRace({ names, result: r.result(), time: r.time });
      }
    };
    viewer.setEpisodes(ep);
  };

  const startSoccer = () => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer) return;
    setError(null);
    setRace(null);
    const a = teamA.map(pick);
    const b = teamB.map(pick);
    if (a.some((x) => !x) || b.some((x) => !x)) {
      setError(`両チームとも${SOCCER.teamSize}体を選んでください(自分のキャラは「${TASKS[EVENT_REQUIRED_TASK].label}」に合格してから)`);
      return;
    }
    const ep = new SoccerEpisode(
      R,
      a.map((x) => x!.data),
      b.map((x) => x!.data),
      randomSeed(),
    );
    const names = [a.map((x) => x!.name), b.map((x) => x!.name)];
    viewer.onFrame = (e) => {
      const s = e as SoccerEpisode;
      const now = performance.now();
      if (now - lastHud.current > 150 || s.done) {
        lastHud.current = now;
        setSoccer({ names, result: s.result(), time: s.time });
      }
    };
    setSoccer({ names, result: { score: [0, 0], winner: null, goals: [] }, time: 0 });
    viewer.setEpisodes(ep);
  };

  const options = (allowNone: boolean, allowMe: boolean) => (
    <>
      {allowNone && <option value={NONE}>(なし)</option>}
      {allowMe && <option value={ME}>{character.name}(自分)</option>}
      {entries.map((e) => (
        <option key={e.id} value={e.id}>
          {e.label}({e.kind})
        </option>
      ))}
    </>
  );

  const setAt = (list: string[], set: (l: string[]) => void, i: number, v: string) => set(list.map((x, j) => (j === i ? v : x)));

  return (
    <div className="battle">
      <aside className="panel">
        <h2>種目</h2>
        <div className="segmented">
          <button className={mode === 'race' ? 'selected' : ''} onClick={() => setMode('race')}>
            かけっこ
          </button>
          <button className={mode === 'soccer' ? 'selected' : ''} onClick={() => setMode('soccer')}>
            サッカー
          </button>
          <button className={mode === 'random' ? 'selected' : ''} onClick={() => setMode('random')}>
            ランダムマッチ
          </button>
        </div>
        {!ready && <p className="message">トレーニング「{TASKS[EVENT_REQUIRED_TASK].label}」に合格すると参加できます</p>}

        {mode === 'random' ? (
          <RandomMatchPanel
            charId={charId}
            character={character}
            eligible={ready}
            viewer={() => viewerRef.current}
            rapier={() => rapierRef.current}
          />
        ) : mode === 'race' ? (
          <>
            <p className="muted small">
              まっすぐ {RACE.distance}m 先のゴールを目指します。ゴールまでのタイム(届かなければ進んだ距離)で順位を決めます。制限時間 {RACE.timeLimit}秒。
            </p>
            <div className="vs">
              <div className="vs-name">{character.name}(自分)</div>
              {runners.map((id, i) => (
                <select key={i} value={id} onChange={(e) => setAt(runners, setRunners, i, e.target.value)}>
                  {options(true, false)}
                </select>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={!ready} onClick={startRace}>
                スタート
              </button>
            </div>
            {race && (
              <div className="result">
                <div className="result-title">{race.result && race.time >= RACE.timeLimit - 1e-9 ? '結果' : `${race.time.toFixed(1)} 秒`}</div>
                <ol className="ranking">
                  {race.result &&
                    race.names
                      .map((n, i) => ({ n, i }))
                      .sort((a, b) => race.result!.rank[a.i] - race.result!.rank[b.i])
                      .map(({ n, i }) => (
                        <li key={i}>
                          {n}:
                          {race.result!.finishAt[i] !== null
                            ? `ゴール ${race.result!.finishAt[i]!.toFixed(1)}秒`
                            : `${race.result!.distance[i].toFixed(1)}m`}
                        </li>
                      ))}
                </ol>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="muted small">
              {SOCCER.teamSize}対{SOCCER.teamSize}。各キャラは自分の運動脳で動き、チームの作戦(ボールの後ろに回り込んで押す・守る・支える)で動きます。{SOCCER.timeLimit}秒で得点の多いチームの勝ち。
            </p>
            <h3 style={{ color: hex(TEAM_COLORS[0]) }}>チームA(青)</h3>
            <div className="vs">
              {teamA.map((id, i) => (
                <select key={i} value={id} onChange={(e) => setAt(teamA, setTeamA, i, e.target.value)}>
                  {options(false, true)}
                </select>
              ))}
            </div>
            <h3 style={{ color: hex(TEAM_COLORS[1]) }}>チームB(橙)</h3>
            <div className="vs">
              {teamB.map((id, i) => (
                <select key={i} value={id} onChange={(e) => setAt(teamB, setTeamB, i, e.target.value)}>
                  {options(false, true)}
                </select>
              ))}
            </div>
            <div className="row">
              <button className="primary" onClick={startSoccer}>
                キックオフ
              </button>
            </div>
            {soccer && (
              <div className={`result ${soccer.time >= SOCCER.timeLimit - 1e-9 ? (soccer.result.winner === 0 ? 'win' : soccer.result.winner === 1 ? 'lose' : 'draw') : ''}`}>
                <div className="result-title">
                  {soccer.result.score[0]} - {soccer.result.score[1]}
                </div>
                <div className="result-detail">
                  {soccer.time >= SOCCER.timeLimit - 1e-9
                    ? soccer.result.winner === null
                      ? '引き分け'
                      : `チーム${soccer.result.winner === 0 ? 'A' : 'B'}の勝ち`
                    : `残り ${Math.max(0, SOCCER.timeLimit - soccer.time).toFixed(0)} 秒`}
                </div>
              </div>
            )}
          </>
        )}
        {error && <p className="message error">{error}</p>}
      </aside>
      <div className="viewport">
        <canvas ref={canvasRef} />
        <div className="speed">
          {([1, 4] as const).map((s) => (
            <button key={s} className={speed === s ? 'selected' : ''} onClick={() => setSpeed(s)}>
              {s}倍
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
