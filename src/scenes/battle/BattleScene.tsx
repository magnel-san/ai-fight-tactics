// バトル画面(仕様書セクション11)。育てたキャラとBOT・保存キャラ・友人のキャラを、崩落ステージで戦わせて観戦する。
// 試合はシードと両キャラのデータだけで決まるので、同じ試合をいつでも再生できる。
import { useEffect, useRef, useState } from 'react';
import type { Character } from '../../core/character';
import { BATTLE, STAGE } from '../../core/config';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import { MatchEpisode, type MatchResult } from '../../core/sim/match';
import type { FighterData } from '../../core/training/tasks';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { TEAM_COLORS } from '../../render/creatureMesh';

export interface OpponentEntry {
  id: string;
  label: string;
  /** 一覧での補足(「BOT」「保存キャラ」「友人」など) */
  kind: string;
  data: FighterData;
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
  if (cause === 'pushed') return '押し出されて負けました。グリップで踏ん張れる体にするか、「BOTとの押し合い」で押し返し方を鍛えましょう。';
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
  const lastHud = useRef(0);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  // 一覧の先頭が変わったら(マイキャラ画面で相手を選んだときなど)、その相手を選ぶ
  const firstId = opponents[0]?.id;
  useEffect(() => {
    if (firstId) setOpponentId(firstId);
  }, [firstId]);

  const opponent = opponents.find((o) => o.id === opponentId) ?? opponents[0];
  const ready = !!character.motor && !!character.decision;

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

  const play = (rec: BattleRecord, skipToEnd = false) => {
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
        finishedRef.current?.({ ...rec, result: r });
      }
    };
    if (skipToEnd) while (!ep.done) ep.advance();
    viewer.setEpisodes(ep);
  };

  // 外からリプレイが渡されたら再生する
  useEffect(() => {
    if (replay && rapierRef.current) play(replay);
  }, [replay]);

  const start = (skipToEnd = false) => {
    if (!ready) {
      setError('運動脳と判断脳を鍛えてから戦わせましょう');
      return;
    }
    if (!opponent) {
      setError('対戦相手がいません');
      return;
    }
    const me: FighterData = { blueprint: character.blueprint, motor: character.motor!, decision: character.decision!, controller: 'brain' };
    play({ seed: randomSeed(), names: [character.name, opponent.label], fighters: [me, opponent.data] }, skipToEnd);
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
        {!ready && <p className="message">運動脳と判断脳を鍛えると戦えます(トレーニングの「崩落ステージを生き残る」まで)</p>}
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
          <div className="row">
            <button onClick={() => play(record)}>もう一度見る</button>
            {onAddToPool && opponent && opponent.kind !== 'BOT' && (
              <button onClick={() => onAddToPool(opponent)} title="押し合いトレーニングの相手に加えます">
                相手をトレーニングに登録
              </button>
            )}
          </div>
        )}
        {error && <p className="message error">{error}</p>}

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

        <h3>ルール</h3>
        <ul className="help">
          <li>先にコアが落ちた方の負け。{BATTLE.timeLimit}秒で引き分け</li>
          <li>安全円(黄色い輪)の外のタイルは崩れる</li>
          <li>同じタイルに{STAGE.stayLimit}秒いると崩れ始める</li>
          <li>20秒後からランダムにタイルが崩れる</li>
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
