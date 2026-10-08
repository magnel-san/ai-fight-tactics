// 種目の画面:かけっこ(最大4体)とサッカー(3対3)と、オンラインのランダムマッチ(1対1のバトル)。
// かけっことサッカーは運動脳だけで動く。
// 参加できるのは、トレーニング「対象を追う」に合格したキャラだけ(指令の方向へまっすぐ進めないと競技にならないため)。
// 参加するキャラは、自分のキャラと、バトルの対戦相手の一覧(BOT・保存キャラ・受け取ったキャラ)から選ぶ。
import { useEffect, useRef, useState } from 'react';
import { battleFighter, canEnter, ENTRY_REQUIRED_TASK, type Character } from '../../core/character';
import { HIGH_JUMP, RACE, SOCCER, TRACK, type SoccerRole } from '../../core/config';
import { HighJumpEpisode, type HighJumpResult } from '../../core/events/highjump';
import { TrackEpisode, TRACK_LENGTH, type TrackResult } from '../../core/events/track';
import { RaceEpisode, type RaceResult } from '../../core/events/race';
import { DEFAULT_ROLES, SoccerEpisode, type SoccerResult } from '../../core/events/soccer';
import { SOCCER_ROLE_LIST } from '../../core/training/soccerDrill';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import { TASKS, type FighterData, type TaskName } from '../../core/training/tasks';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { TEAM_COLORS } from '../../render/creatureMesh';
import type { OpponentEntry } from '../battle/BattleScene';
import { RandomMatchPanel } from './RandomMatchPanel';
import { BrainToggle } from '../BrainToggle';

interface Props {
  /** いまのキャラの id(ランダムマッチでモンスターの識別子にする) */
  charId: string;
  character: Character;
  /** 参加できる相手(バトルの対戦相手の一覧と同じ) */
  entries: OpponentEntry[];
  active: boolean;
  /** 表示する種目(対戦タブの切り替えで選ぶ) */
  mode: EventMode;
}

export type EventMode = 'race' | 'track' | 'jump' | 'soccer' | 'random';
type Mode = EventMode;
const MODE_TITLES: Record<Mode, string> = {
  race: 'かけっこ',
  track: '長距離(トラック3周)',
  jump: 'ジャンプ',
  soccer: 'サッカー(3対3)',
  random: 'ランダムマッチ',
};
const NONE = '';
const ME = '__me__';
const randomSeed = () => (Math.random() * 2 ** 32) | 0;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** 種目に参加するために合格が必要なトレーニング(トーナメント・ランダムマッチと同じ) */
export const EVENT_REQUIRED_TASK: TaskName = ENTRY_REQUIRED_TASK;

export function EventsScene({ charId, character, entries, active, mode }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const [speed, setSpeed] = useState<1 | 4>(1);
  // かけっこ:自分 + 最大3体
  const [runners, setRunners] = useState<string[]>([entries[1]?.id ?? entries[0]?.id ?? NONE, entries[0]?.id ?? NONE, NONE]);
  // サッカー:チームA(自分 + 2体)とチームB(3体)
  const [teamA, setTeamA] = useState<string[]>([ME, entries[1]?.id ?? NONE, entries[1]?.id ?? NONE]);
  const [teamB, setTeamB] = useState<string[]>([entries[0]?.id ?? NONE, entries[0]?.id ?? NONE, entries[0]?.id ?? NONE]);
  // サッカー:それぞれの選手の役割(シューター・キャリアー・ブロッカー)
  const [rolesA, setRolesA] = useState<SoccerRole[]>([...DEFAULT_ROLES]);
  const [rolesB, setRolesB] = useState<SoccerRole[]>([...DEFAULT_ROLES]);
  const [race, setRace] = useState<{ names: string[]; result: RaceResult | null; time: number } | null>(null);
  const [track, setTrack] = useState<{ names: string[]; result: TrackResult; time: number; done: boolean } | null>(null);
  const [jump, setJump] = useState<{ names: string[]; result: HighJumpResult | null; attempt: number; done: boolean } | null>(null);
  const [soccer, setSoccer] = useState<{ names: string[][]; result: SoccerResult; time: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastHud = useRef(0);

  const ready = canEnter(character);

  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewer.endPause = Infinity;
    viewer.showNothing();
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
      const data = ready ? battleFighter(character) : null;
      return data ? { name: character.name, data } : null;
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
    const ep = new RaceEpisode(
      R,
      chosen.map((c) => c.data),
      randomSeed(),
    );
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

  const startTrack = () => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer) return;
    setError(null);
    setSoccer(null);
    setRace(null);
    setJump(null);
    const chosen = [ME, ...runners].map(pick).filter((x): x is NonNullable<typeof x> => x !== null);
    if (chosen.length === 0) {
      setError(`トレーニング「${TASKS[EVENT_REQUIRED_TASK].label}」に合格したキャラが必要です`);
      return;
    }
    const ep = new TrackEpisode(
      R,
      chosen.map((c) => c.data),
      randomSeed(),
    );
    const names = chosen.map((c) => c.name);
    setTrack({ names, result: ep.result(), time: 0, done: false });
    viewer.onFrame = (e) => {
      const tr = e as TrackEpisode;
      const now = performance.now();
      if (now - lastHud.current > 200 || tr.done) {
        lastHud.current = now;
        setTrack({ names, result: tr.result(), time: tr.time, done: tr.done });
      }
    };
    viewer.setEpisodes(ep);
  };

  const startJump = () => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer) return;
    setError(null);
    setSoccer(null);
    setRace(null);
    const chosen = [ME, ...runners].map(pick).filter((x): x is NonNullable<typeof x> => x !== null);
    if (chosen.length === 0) {
      setError(`トレーニング「${TASKS[EVENT_REQUIRED_TASK].label}」に合格したキャラが必要です`);
      return;
    }
    const ep = new HighJumpEpisode(
      R,
      chosen.map((c) => c.data),
      randomSeed(),
    );
    const names = chosen.map((c) => c.name);
    setJump({ names, result: null, attempt: 0, done: false });
    viewer.onFrame = (e) => {
      const j = e as HighJumpEpisode;
      const now = performance.now();
      if (now - lastHud.current > 150 || j.done) {
        lastHud.current = now;
        setJump({ names, result: j.result(), attempt: j.attemptNumber, done: j.done });
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
      a.map((x, i) => ({ data: x!.data, role: rolesA[i] })),
      b.map((x, i) => ({ data: x!.data, role: rolesB[i] })),
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

  /** 役割を選ぶ。その役割のサッカー脳を鍛えていれば「脳」と表示する */
  const roleSelect = (roles: SoccerRole[], set: (r: SoccerRole[]) => void, i: number, data: FighterData | undefined) => (
    <select value={roles[i]} onChange={(e) => set(roles.map((r, j) => (j === i ? (e.target.value as SoccerRole) : r)))}>
      {SOCCER_ROLE_LIST.map((r) => (
        <option key={r.role} value={r.role}>
          {r.label}
          {data?.soccer?.[r.role] ? '(サッカー脳)' : '(お手本)'}
        </option>
      ))}
    </select>
  );

  return (
    <div className="battle">
      <aside className="panel">
        <h2>{MODE_TITLES[mode]}</h2>
        {!ready && <p className="message">トレーニング「2. {TASKS[EVENT_REQUIRED_TASK].label}」に合格すると参加できます</p>}

        {mode === 'random' ? (
          <RandomMatchPanel charId={charId} character={character} eligible={ready} viewer={() => viewerRef.current} rapier={() => rapierRef.current} />
        ) : mode === 'track' ? (
          <>
            <p className="muted small">
              楕円のトラックを{TRACK.laps}周します(1周 約{Math.round(TRACK_LENGTH)}m・制限時間 {TRACK.timeLimit}秒)。1周に{TRACK.checkpoints}
              個あるチェックポイントを、順番どおりに全部通らないと周回になりません(近道しても進みません)。全員が同じトラックを走るので、ぶつかることもあります。
            </p>
            <ul className="cp-legend">
              <li>
                <span className="cp-dot" style={{ background: '#f2f2f2' }} />
                まだ(黄色はゴール)
              </li>
              <li>
                <span className="cp-dot" style={{ background: '#ff8c42' }} />
                次に通る
              </li>
              <li>
                <span className="cp-dot" style={{ background: '#4cd07d' }} />
                この周で通った
              </li>
            </ul>
            <p className="muted small">チェックポイントの色は、自分(いちばん上のキャラ)の進み具合です。</p>
            <div className="vs">
              <div className="vs-name">{character.name}(自分)</div>
              {runners.map((id, i) => (
                <select key={i} value={id} onChange={(e) => setAt(runners, setRunners, i, e.target.value)}>
                  {options(true, false)}
                </select>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={!ready} onClick={startTrack}>
                {track ? 'もう一度スタート' : 'スタート'}
              </button>
            </div>
            {track && (
              <div className="result">
                <div className="result-title">{track.done ? '結果' : `${track.time.toFixed(0)} 秒`}</div>
                <ol className="track-progress">
                  {track.names
                    .map((n, i) => ({ n, i }))
                    .sort((a, b) => track.result.rank[a.i] - track.result.rank[b.i])
                    .map(({ n, i }) => {
                      const total = TRACK.laps * TRACK.checkpoints;
                      const fin = track.result.finishAt[i];
                      return (
                        <li key={i} className={i === 0 ? 'mine' : ''}>
                          <div className="track-progress-head">
                            <span>
                              {n}
                              {i === 0 ? '(自分)' : ''}
                            </span>
                            <span className="muted">
                              {fin !== null
                                ? `ゴール ${fin.toFixed(1)}秒`
                                : `${Math.min(TRACK.laps, track.result.laps[i] + 1)}周目 ${track.result.passed[i]}/${total}`}
                            </span>
                          </div>
                          <div className="track-bar">
                            <div style={{ width: `${(100 * track.result.passed[i]) / total}%` }} className={fin !== null ? 'done' : ''} />
                            {Array.from({ length: TRACK.laps - 1 }, (_, l) => (
                              <span key={l} className="lap-mark" style={{ left: `${(100 * (l + 1)) / TRACK.laps}%` }} />
                            ))}
                          </div>
                        </li>
                      );
                    })}
                </ol>
              </div>
            )}
          </>
        ) : mode === 'jump' ? (
          <>
            <p className="muted small">
              {HIGH_JUMP.interval}秒ごとにジャンプの合図が出て、{HIGH_JUMP.attempts}
              回跳びます。コアがどれだけ高く上がったか(跳ぶ前からの上がり幅)の、いちばん高い記録で順位を決めます。
              トレーニング「ジャンプ」で鍛えると高く跳べるようになります(ピストンを下向きに付けるのもおすすめ)。
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
              <button className="primary" disabled={!ready} onClick={startJump}>
                スタート
              </button>
            </div>
            {jump && (
              <div className="result">
                <div className="result-title">{jump.done ? '結果' : `${Math.max(1, jump.attempt)} / ${HIGH_JUMP.attempts} 回目`}</div>
                <ol className="ranking">
                  {jump.result &&
                    jump.names
                      .map((n, i) => ({ n, i }))
                      .sort((a, b) => jump.result!.rank[a.i] - jump.result!.rank[b.i])
                      .map(({ n, i }) => (
                        <li key={i}>
                          {n}:最高 {(jump.result!.best[i] * 100).toFixed(0)}cm
                          <span className="muted small"> ({jump.result!.heights[i].map((h) => (h * 100).toFixed(0)).join('・')})</span>
                        </li>
                      ))}
                </ol>
              </div>
            )}
          </>
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
                          {race.result!.finishAt[i] !== null ? `ゴール ${race.result!.finishAt[i]!.toFixed(1)}秒` : `${race.result!.distance[i].toFixed(1)}m`}
                        </li>
                      ))}
                </ol>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="muted small">
              {SOCCER.teamSize}対{SOCCER.teamSize}。選手ごとに役割(シューター:シュートする・キャリアー:ドリブルで運ぶ・ブロッカー:ゴールを守る)を選びます。
              その役割のサッカー脳をトレーニングで鍛えていればサッカー脳で、なければお手本の動きで動きます。{SOCCER.timeLimit}秒で得点の多いチームの勝ち。
            </p>
            <h3 style={{ color: hex(TEAM_COLORS[0]) }}>チームA(青)</h3>
            <div className="vs">
              {teamA.map((id, i) => (
                <div key={i} className="soccer-slot">
                  <select value={id} onChange={(e) => setAt(teamA, setTeamA, i, e.target.value)}>
                    {options(false, true)}
                  </select>
                  {roleSelect(rolesA, setRolesA, i, pick(id)?.data)}
                </div>
              ))}
            </div>
            <h3 style={{ color: hex(TEAM_COLORS[1]) }}>チームB(橙)</h3>
            <div className="vs">
              {teamB.map((id, i) => (
                <div key={i} className="soccer-slot">
                  <select value={id} onChange={(e) => setAt(teamB, setTeamB, i, e.target.value)}>
                    {options(false, true)}
                  </select>
                  {roleSelect(rolesB, setRolesB, i, pick(id)?.data)}
                </div>
              ))}
            </div>
            <div className="row">
              <button className="primary" onClick={startSoccer}>
                キックオフ
              </button>
            </div>
            {soccer && (
              <div
                className={`result ${soccer.time >= SOCCER.timeLimit - 1e-9 ? (soccer.result.winner === 0 ? 'win' : soccer.result.winner === 1 ? 'lose' : 'draw') : ''}`}
              >
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
          {mode === 'random' && <BrainToggle viewer={() => viewerRef.current} />}
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
