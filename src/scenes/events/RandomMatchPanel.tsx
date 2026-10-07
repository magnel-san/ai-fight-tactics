// 種目「ランダムマッチ」:サーバーがまだ戦っていない相手を選び、自動で1対1のバトルをする。
// 同じ2体は1回だけ戦える。結果はランダムマッチのレート(トーナメントとは別)に反映される。
// 試合は Worker で計算してすぐ報告し、その試合を画面で再生する(結果は再生が終わるまで隠す)。
import { useEffect, useState } from 'react';
import type { Character } from '../../core/character';
import { RANKED } from '../../core/config';
import type { Rapier } from '../../core/physics/rapier';
import { monsterGroups, randomMatchSeed, type PlayerStats, type RankedOutcome } from '../../core/ranked/tournament';
import { MatchEpisode } from '../../core/sim/match';
import * as api from '../../online/ranked';
import { TEAM_COLORS } from '../../render/creatureMesh';
import type { EpisodeViewer } from '../../render/EpisodeViewer';
import { saveReplay } from '../../storage/db';
import type { BattleRecord } from '../battle/BattleScene';

interface Props {
  charId: string;
  character: Character;
  /** 種目に参加できる(「対象を追う」に合格している)か */
  eligible: boolean;
  viewer: () => EpisodeViewer | null;
  rapier: () => Rapier | null;
}

interface Current {
  opponent: string;
  outcome: RankedOutcome;
  /** 再生が終わったか */
  shown: boolean;
  before: number;
  after: number | null;
}

/** これより長く取得していなければ、開いたときに取得する [ms] */
const STALE_MS = 30 * 60_000;
/** 更新ボタンを続けて押せない時間 [ms] */
const REFRESH_COOLDOWN = 15_000;

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

const resultText = (o: RankedOutcome) =>
  o.winner === null
    ? '引き分け'
    : o.winner === 0
      ? o.cause === 'pushed'
        ? '押し出して勝ち'
        : '勝ち(相手の自滅)'
      : o.cause === 'pushed'
        ? '押し出されて負け'
        : '負け(自滅)';

export function RandomMatchPanel({ charId, character, eligible, viewer, rapier }: Props) {
  const [me, setMe] = useState<string | null>(null);
  const [myName, setMyName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  // ブラウザに保存している情報(取得するのは、しばらく取得していないときに開いたとき・試合のあと・更新ボタンのときだけ)
  const [snap, setSnap] = useState<api.RankedSnapshot>({ versions: [], players: new Map(), results: [], randomMatches: [], randomResults: [], syncedAt: 0, outdated: false, needsSql: false });
  const { versions, players, randomMatches: matches, randomResults: results } = snap;
  /** 更新ボタンを押したばかり(しばらく押せない) */
  const [cooling, setCooling] = useState(false);
  const [current, setCurrent] = useState<Current | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  /** サーバーから新しい分だけを取得する */
  const refresh = async () => {
    setCooling(true);
    setTimeout(() => setCooling(false), REFRESH_COOLDOWN);
    return api.syncRanked();
  };

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage({ text: (e as Error).message, error: true });
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!api.onlineConfigured) return;
    const unsubscribe = api.subscribeRanked(setSnap);
    void run(async () => {
      const cached = await api.rankedSnapshot();
      setSnap(cached);
      const { id, player } = await api.myPlayer();
      setMe(id);
      setMyName(player?.name ?? null);
      setNameInput(player?.name ?? '');
      // 30分以上取得していなければ取得する(それ以外は更新ボタンで)
      if (Date.now() - cached.syncedAt > STALE_MS) await refresh();
    });
    return unsubscribe;
  }, []);

  if (!api.onlineConfigured) {
    return <p className="message">ランダムマッチを使うには、オンライン機能の設定が必要です(docs/ONLINE.md)。</p>;
  }

  const groups = monsterGroups(versions);
  const myKey = me ? (groups.find(me, charId, character.name) ?? null) : null;
  const stats = api.randomStats(matches, results, groups);
  const mine: PlayerStats | undefined = myKey ? stats.get(myKey) : undefined;
  const rating = (s: PlayerStats | undefined) => Math.round(s?.rating ?? RANKED.initialRating);
  const entryById = new Map(versions.map((v) => [v.id, v]));
  const nameOf = (id: number) => {
    const e = entryById.get(id);
    return e ? `${e.name}(${players.get(e.owner) ?? '名無し'})` : '?';
  };
  const resultById = new Map(results.map((r) => [r.matchId, r]));
  /** 試合のそれぞれの側が、どのモンスターか */
  const sideKey = (entry: number, serverKey: string) => groups.keyOf.get(entry) ?? groups.byServerKey.get(serverKey);
  const myMatches = myKey ? matches.filter((m) => sideKey(m.a, m.aMonster) === myKey || sideKey(m.b, m.bMonster) === myKey).reverse() : [];
  const ready = eligible;

  const start = () =>
    run(async () => {
      const R = rapier();
      const v = viewer();
      if (!R || !v || !me) return;
      const before = rating(mine);
      const match = await api.startRandomMatch(character, charId);
      if (!match) {
        setMessage({ text: 'まだ戦っていない相手がいません。ほかのプレイヤーの登録を待ちましょう', error: false });
        return;
      }
      const f = await api.entryFighters([match.a, match.b]);
      const fa = f.get(match.a);
      const fb = f.get(match.b);
      if (!fa || !fb) throw new Error('相手のデータを読めませんでした');
      // 先に計算して報告する(再生の途中で画面を閉じても、結果は残る)
      const outcome = await api.computeMatch(fa, fb, randomMatchSeed(match.id));
      await api.reportRandomResult(match.id, outcome);
      // 自分の版・相手・結果を取得する(新しい分だけ)
      const fresh = await refresh();
      // いまのキャラの版が登録されたので、まとめ直してからレートを見る
      const g = monsterGroups(fresh.versions);
      const key = g.find(me!, charId, character.name);
      const after = key ? rating(api.randomStats(fresh.randomMatches, fresh.randomResults, g).get(key)) : before;
      // 計算したのと同じ試合を画面で再生する
      const oe = fresh.versions.find((x) => x.id === match.b);
      const opponent = oe ? `${oe.name}(${fresh.players.get(oe.owner) ?? '名無し'})` : '相手';
      setCurrent({ opponent, outcome, shown: false, before, after });
      // マイキャラのリプレイに保存する
      const record: BattleRecord = { seed: randomMatchSeed(match.id), names: [character.name, opponent], fighters: [fa, fb] };
      const result = outcome.winner === null ? '引き分け' : outcome.winner === 0 ? '勝ち' : '負け';
      await saveReplay({
        id: `random:${match.id}`,
        kind: 'random',
        title: `ランダムマッチ:${character.name} vs ${opponent}(${result})`,
        createdAt: Date.now(),
        data: record,
      });
      const ep = new MatchEpisode(R, { mode: 'battle', seed: randomMatchSeed(match.id), fighters: [fa, fb] });
      v.onFrame = (e) => {
        if ((e as MatchEpisode).done) setCurrent((c) => (c && !c.shown ? { ...c, shown: true } : c));
      };
      v.setEpisodes(ep);
    });

  return (
    <>
      <p className="muted small">
        サーバーが、まだ戦っていない相手を自動で選んで1対1のバトルをします。同じ相手とは1回だけ戦えます。結果は「ランダムマッチ」のレート(トーナメントとは別)に反映され、ランクマッチ画面のランキングで見られます。
      </p>
      {!myName && (
        <>
          <h3>プレイヤー名</h3>
          <input type="text" maxLength={20} value={nameInput} placeholder="20文字まで" onChange={(e) => setNameInput(e.target.value)} />
          <div className="row">
            <button
              disabled={busy || !me}
              onClick={() =>
                run(async () => {
                  await api.savePlayerName(nameInput);
                  setMyName(nameInput.trim());
                })
              }
            >
              名前を登録
            </button>
          </div>
        </>
      )}
      <div className="vs">
        <div className="vs-name" style={{ borderColor: hex(TEAM_COLORS[0]) }}>
          {character.name}
        </div>
        <div className="muted small">
          {current && !current.shown
            ? `ランダムマッチのレート ${current.before}(対戦中)`
            : `ランダムマッチのレート ${rating(mine)}・${mine ? `${mine.wins}勝${mine.losses}敗${mine.draws ? `${mine.draws}分` : ''}` : 'まだ試合なし'}`}
        </div>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || !ready || !myName} onClick={start}>
          {busy ? '準備中…' : '相手を探して対戦'}
        </button>
      </div>
      {eligible && !character.decision && (
        <p className="muted small">判断脳をまだ鍛えていないので、相手に向かって突進します(判断脳を鍛えると、作戦を考えて戦います)</p>
      )}
      {current && (
        <div className={`result ${current.shown ? (current.outcome.winner === 0 ? 'win' : current.outcome.winner === 1 ? 'lose' : 'draw') : ''}`}>
          <div className="result-title">{current.shown ? resultText(current.outcome) : '対戦中…'}</div>
          <div className="result-detail">
            相手:<span style={{ color: hex(TEAM_COLORS[1]) }}>{current.opponent}</span>
            {current.shown && current.after !== null && (
              <>
                <br />
                レート {current.before} → {current.after}({current.after - current.before >= 0 ? '+' : ''}
                {current.after - current.before})
              </>
            )}
          </div>
        </div>
      )}
      {message && <p className={message.error ? 'message error' : 'message'}>{message.text}</p>}
      <div className="refresh-row">
        <span className="muted small">
          {snap.syncedAt ? `最終更新 ${new Date(snap.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'まだ取得していません'}
        </span>
        <button
          className="small-button"
          disabled={busy || cooling}
          onClick={() => run(async () => void (await refresh()))}
          title="新しい登録・プレイヤー名・試合の結果を取得します"
        >
          更新
        </button>
      </div>
      {myMatches.length > 0 && (
        <>
          <h3>このキャラの対戦</h3>
          <ol className="ranking">
            {myMatches.slice(0, 10).map((m) => {
              const r = resultById.get(m.id);
              const side = sideKey(m.a, m.aMonster) === myKey ? 0 : 1;
              const opp = side === 0 ? m.b : m.a;
              // 再生中の試合の結果は、再生が終わるまで出さない
              const hide = current && !current.shown && m.id === myMatches[0].id;
              return (
                <li key={m.id}>
                  {nameOf(opp)}:{!r || hide ? '集計中' : r.winner === null ? '引き分け' : r.winner === side ? '勝ち' : '負け'}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </>
  );
}
