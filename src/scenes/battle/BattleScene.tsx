// バトル画面(仕様書セクション11)。育てたキャラとBOT・保存キャラ・友人のキャラを、崩落ステージで戦わせて観戦する。
// 試合はシードと両キャラのデータだけで決まるので、同じ試合をいつでも再生できる。
import { useEffect, useRef, useState } from 'react';
import { battleFighter, type Character } from '../../core/character';
import { BATTLE, STAGE } from '../../core/config';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import { MatchEpisode, type MatchResult } from '../../core/sim/match';
import type { FighterData, TaskName } from '../../core/training/tasks';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { downloadReplay, replayShareUrl } from '../../storage/share';
import { deleteReplay, listReplays, type StoredReplay } from '../../storage/db';
import { TEAM_COLORS } from '../../render/creatureMesh';

export interface OpponentEntry {
  id: string;
  label: string;
  /** 一覧での補足(「BOT」「保存キャラ」「友人」など) */
  kind: string;
  data: FighterData;
  /** 合格したトレーニング(わからない BOT などは省略) */
  passed?: readonly TaskName[];
}

/** 試合の記録(リプレイ)。シードと試合時点の両キャラのデータだけを持つ */
export interface BattleRecord {
  seed: number;
  names: [string, string];
  fighters: [FighterData, FighterData];
  result?: MatchResult;
}

interface Props {
  character: Character;
  opponents: OpponentEntry[];
  active: boolean;
  /** 試合が終わったとき(リプレイの保存や対戦相手プールへの登録に使う) */
  onFinished?(record: BattleRecord): void;
  /** 再生したいリプレイ(外から渡されたら再生する) */
  replay?: BattleRecord | null;
  /** 対戦相手をトレーニングの対戦相手プールに登録する */
  onAddToPool?(entry: OpponentEntry): void;
}

type Speed = 1 | 4;

interface Hud {
  time: number;
  safeRadius: number;
  stays: number[];
  outs: boolean[];
}

const randomSeed = () => (Math.random() * 2 ** 32) | 0;
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** 負けた原因に応じた見直しのヒント(仕様書セクション1「見直し」) */
function reviewHint(result: MatchResult): string | null {
  if (result.winner === 0) return null;
  const cause = result.causes[0];
  if (cause === 'pushed') return '押し出されて負けました。足を「摩擦オン」にして踏ん張れる体にするか、「BOTとの押し合い」で押し返し方を鍛えましょう。';
  if (cause === 'fell') return '自分で落ちてしまいました。「崩落ステージを生き残る」で危ないタイルを避ける判断を鍛えましょう。';
  return '引き分けでした。相手を押し出す力を「BOTとの押し合い」で鍛えると勝ちやすくなります。';
}

export function BattleScene({ character, opponents, active, onFinished, replay, onAddToPool }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const [opponentId, setOpponentId] = useState<string>(opponents[0]?.id ?? '');
  const [speed, setSpeed] = useState<Speed>(1);
  const [record, setRecord] = useState<BattleRecord | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [hud, setHud] = useState<Hud | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<StoredReplay[]>([]);
  const lastHud = useRef(0);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const replayRef = useRef(replay);
  replayRef.current = replay;
  const playRef = useRef<(rec: BattleRecord) => void>(() => {});

  // 一覧の先頭が変わったら(マイキャラ画面で相手を選んだときなど)、その相手を選ぶ
  const firstId = opponents[0]?.id;
  useEffect(() => {
    if (firstId) setOpponentId(firstId);
  }, [firstId]);

  const opponent = opponents.find((o) => o.id === opponentId) ?? opponents[0];
  // 運動脳があれば戦える(判断脳がなければ相手に向かって突進する)
  const ready = !!character.motor;

  useEffect(() => {
    const viewer = new EpisodeViewer(canvasRef.current!);
    viewer.endPause = Infinity;
    viewer.showNothing();
    viewerRef.current = viewer;
    let cancelled = false;
    initRapier().then((R) => {
      if (cancelled) return;
      rapierRef.current = R;
      // 準備ができる前にリプレイが渡されていたら、ここで再生する
      if (replayRef.current) playRef.current(replayRef.current);
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

  // 保存した試合のリプレイ(表示したとき・試合が終わったときに読み直す)
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      void listReplays().then((all) => setSaved(all.filter((r) => r.kind === 'battle').slice(0, 20)));
    }, 300);
    return () => clearTimeout(timer);
  }, [active, result]);

  /** 試合を再生する。save = true は新しい試合(終わったらリプレイとして保存する)。リプレイの再生では保存しない */
  const play = (rec: BattleRecord, skipToEnd = false, save = false) => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer) return;
    setError(null);
    setResult(null);
    setRecord(rec);
    const ep = new MatchEpisode(R, { mode: 'battle', seed: rec.seed, fighters: [...rec.fighters] });
    let reported = false;
    viewer.onFrame = (e) => {
      const m = e as MatchEpisode;
      const now = performance.now();
      if (now - lastHud.current > 100 || m.done) {
        lastHud.current = now;
        const stage = m.stageOrThrow;
        setHud({
          time: m.time,
          safeRadius: stage.safeRadius,
          stays: m.fighters.map((f) => {
            const p = f.position();
            const t = stage.tileAt(p.x, p.z);
            return t && !f.out ? t.stay / STAGE.stayLimit : 0;
          }),
          outs: m.fighters.map((f) => f.out),
        });
      }
      const r = m.matchResult();
      if (r && !reported) {
        reported = true;
        setResult(r);
        if (save) finishedRef.current?.({ ...rec, result: r });
      }
    };
    if (skipToEnd) while (!ep.done) ep.advance();
    viewer.setEpisodes(ep);
  };

  playRef.current = play;

  // 外からリプレイが渡されたら再生する
  useEffect(() => {
    if (replay && rapierRef.current) play(replay);
  }, [replay]);

  const start = (skipToEnd = false) => {
    if (!ready) {
      setError('トレーニングで運動脳を鍛えてから戦わせましょう');
      return;
    }
    if (!opponent) {
      setError('対戦相手がいません');
      return;
    }
    const me: FighterData = battleFighter(character)!;
    play({ seed: randomSeed(), names: [character.name, opponent.label], fighters: [me, opponent.data] }, skipToEnd, true);
  };

  const remaining = hud ? Math.max(0, BATTLE.timeLimit - hud.time) : BATTLE.timeLimit;
  const names = record?.names ?? [character.name, opponent?.label ?? '-'];

  return (
    <div className="battle">
      <aside className="panel">
        <h2>バトル</h2>
        <div className="vs">
          <div className="vs-name" style={{ borderColor: hex(TEAM_COLORS[0]) }}>
            {character.name}
          </div>
          <div className="vs-mark">VS</div>
          <select value={opponent?.id ?? ''} onChange={(e) => setOpponentId(e.target.value)}>
            {opponents.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}({o.kind})
              </option>
            ))}
          </select>
        </div>
        {!ready && <p className="message">トレーニングの「1. 目標地点への移動」に合格すると戦えます</p>}
        {ready && !character.decision && (
          <p className="muted small">判断脳をまだ鍛えていないので、相手に向かって突進します。「危険なタイルを避ける」以降のトレーニングで判断脳を鍛えると、作戦を考えて戦います</p>
        )}
        {opponents.length === 0 && <p className="message">対戦相手がいません</p>}
        <div className="row">
          <button className="primary" onClick={() => start()} disabled={!ready || !opponent}>
            試合開始
          </button>
          <button onClick={() => start(true)} disabled={!ready || !opponent} title="試合を最後まで一気に計算して、結果の場面から表示します">
            結果だけ見る
          </button>
        </div>
        {record && (
          <div className="row wrap">
            <button onClick={() => play(record)}>もう一度見る</button>
            <button
              onClick={async () => {
                try {
                  const u = await replayShareUrl(record);
                  await navigator.clipboard.writeText(u).catch(() => {});
                  setNotice(`リプレイの共有URLをコピーしました(${u.length.toLocaleString()}文字)`);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              リプレイを共有
            </button>
            <button onClick={() => downloadReplay(record)}>リプレイを保存</button>
            {onAddToPool && opponent && opponent.kind !== 'BOT' && (
              <button onClick={() => onAddToPool(opponent)} title="押し合いトレーニングの相手に加えます">
                相手をトレーニングに登録
              </button>
            )}
          </div>
        )}
        {error && <p className="message error">{error}</p>}
        {notice && <p className="message">{notice}</p>}

        {result && (
          <div className={`result ${result.winner === 0 ? 'win' : result.winner === 1 ? 'lose' : 'draw'}`}>
            <div className="result-title">{result.winner === 0 ? '勝利!' : result.winner === 1 ? '敗北…' : '引き分け'}</div>
            <div className="result-detail">
              {result.winner === null
                ? result.outAt.every((t) => t !== null)
                  ? '両者が同時に脱落'
                  : '時間切れ'
                : `${names[1 - result.winner]} が ${result.outAt[1 - result.winner]!.toFixed(1)} 秒で脱落(${result.causes[1 - result.winner] === 'pushed' ? '押し出された' : '自分で落ちた'})`}
            </div>
            {reviewHint(result) && <p className="hint">{reviewHint(result)}</p>}
          </div>
        )}

        <h3>リプレイ(最近の試合)</h3>
        {saved.length === 0 ? (
          <p className="muted small">試合が終わると自動で保存されます</p>
        ) : (
          <ul className="replay-list">
            {saved.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => play(r.data as BattleRecord)} title={new Date(r.createdAt).toLocaleString()}>
                  ▶ {r.title}
                </button>
                <button
                  className="danger small-button"
                  title="このリプレイを削除"
                  onClick={async () => {
                    await deleteReplay(r.id);
                    setSaved((list) => list.filter((x) => x.id !== r.id));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>ルール</h3>
        <ul className="help">
          <li>先にコアが落ちた方の負け。{BATTLE.timeLimit}秒で引き分け</li>
          <li>安全円(黄色い輪)の外のタイルは崩れる</li>
          <li>同じタイルに{STAGE.stayLimit}秒いると崩れ始める</li>
          <li>{STAGE.randomStart}秒後からランダムにタイルが崩れる</li>
        </ul>
      </aside>

      <div className="viewport">
        <canvas ref={canvasRef} />
        {hud && (
          <div className="battle-hud">
            <div className="timer">{remaining.toFixed(0)}</div>
            <div className="safe">安全半径 {hud.safeRadius}</div>
            {names.map((n, i) => (
              <div key={i} className="fighter-hud">
                <span className="dot" style={{ background: hex(TEAM_COLORS[i]) }} />
                <span className="fname">{n}</span>
                {hud.outs[i] ? (
                  <span className="out">脱落</span>
                ) : (
                  <span className="stay" title="足元の滞在タイマー">
                    <span style={{ width: `${Math.min(100, hud.stays[i] * 100)}%` }} />
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="speed">
          {([1, 4] as Speed[]).map((s) => (
            <button key={s} className={speed === s ? 'selected' : ''} onClick={() => setSpeed(s)}>
              {s}倍
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
