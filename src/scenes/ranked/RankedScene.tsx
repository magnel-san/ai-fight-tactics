// ランクマッチ画面:プレイヤー名とモンスターの登録、自動トーナメントのライブ配信、ランキング。
// トーナメントは時刻と登録内容だけで決まるので、どのブラウザでも同じ試合が同じ時刻に流れる。
// 試合は Worker で計算して結果を報告し、配信はメインスレッドで同じ試合を再現して、時刻に合わせて途中から映す。
import { useEffect, useMemo, useRef, useState } from 'react';
import { canEnter, type Character } from '../../core/character';
import { BATTLE, PHYSICS, RACE, RANKED } from '../../core/config';
import { initRapier, type Rapier } from '../../core/physics/rapier';
import type { RaceRecord } from '../../core/ranked/run';
import {
  bracketFor,
  computeStats,
  monsterGroups,
  entrantsFor,
  matchSeed,
  matchSlotStart,
  tournamentAt,
  tournamentStart,
  type EntryVersion,
  type RankedOutcome,
  type RankedResultRow,
} from '../../core/ranked/tournament';
import { MatchEpisode } from '../../core/sim/match';
import * as api from '../../online/ranked';
import { TEAM_COLORS } from '../../render/creatureMesh';
import { EpisodeViewer } from '../../render/EpisodeViewer';
import { getSetting, saveReplay, setSetting } from '../../storage/db';
import type { BattleRecord } from '../battle/BattleScene';
import { BrainToggle } from '../BrainToggle';

interface Props {
  /** いまのキャラの id(モンスターの識別子にする) */
  charId: string;
  character: Character;
  active: boolean;
  /** 表示する画面(オンラインタブの切り替えで選ぶ):配信・ランキング・出場登録 */
  view: RankedView;
}

interface LiveMatch {
  index: number;
  round: number;
  a: EntryVersion | null;
  b: EntryVersion | null;
  outcome: RankedOutcome | null;
  /** どちらかのデータが壊れていて試合にならなかった(結果は報告しない) */
  forfeit: boolean;
  /** 前の試合から勝ち上がる場合、その試合の番号 */
  fromA: number | null;
  fromB: number | null;
}

interface LiveTournament {
  t: number;
  entrants: EntryVersion[];
  matches: LiveMatch[];
}

export type RankedView = 'live' | 'ranking' | 'entry';
type View = RankedView;
const VIEW_TITLES: Record<View, string> = { live: 'トーナメント配信', ranking: 'ランキング', entry: '出場登録' };
type SortKey = 'rating' | 'wins' | 'race' | 'jump';
/** ランキングの部門:トーナメントとランダムマッチ(レートは別々) */
type Division = 'tournament' | 'random';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const slotMs = RANKED.slot * 1000;
const introMs = RANKED.intro * 1000;
/** 結果がまだ集まっていない過去のトーナメントを、さかのぼって計算する数 */
const BACKFILL = 4;

/** 計算した試合の結果(同じ組み合わせは二度計算しない) */
const outcomes = new Map<string, RankedOutcome>();

/** トーナメントの試合を順に計算する(前の試合の勝者が次の試合に進む) */
/**
 * トーナメントの試合を順に計算する(前の試合の勝者が次の試合に進む)。
 * official にサーバーの正式な結果があれば、勝ち上がりはそれに従う(端末ごとに組み合わせが変わらないように)
 */
async function resolveTournament(
  t: number,
  versions: readonly EntryVersion[],
  official: readonly RankedResultRow[],
  onProgress?: (lt: LiveTournament) => void,
): Promise<LiveTournament> {
  const officialOf = new Map(official.filter((r) => r.tournament === t).map((r) => [r.match, r]));
  const entrants = entrantsFor(t, versions);
  const bracket = bracketFor(entrants.length);
  const matches: LiveMatch[] = bracket.map((m) => ({
    index: m.index,
    round: m.round,
    a: m.a !== null ? entrants[m.a] : null,
    b: m.b !== null ? entrants[m.b] : null,
    outcome: null,
    forfeit: false,
    fromA: m.fromA,
    fromB: m.fromB,
  }));
  const lt: LiveTournament = { t, entrants, matches };
  onProgress?.(lt);
  if (bracket.length === 0) return lt;
  const fighters = await api.entryFighters(entrants.map((e) => e.id));
  const winnerOf = (m: LiveMatch) => (m.outcome!.advance === 0 ? m.a : m.b);
  for (const bm of bracket) {
    const m = matches[bm.index];
    if (bm.fromA !== null) m.a = winnerOf(matches[bm.fromA]);
    if (bm.fromB !== null) m.b = winnerOf(matches[bm.fromB]);
    const fa = fighters.get(m.a!.id) ?? null;
    const fb = fighters.get(m.b!.id) ?? null;
    if (!fa || !fb) {
      m.forfeit = true;
      m.outcome = {
        winner: fa ? 0 : fb ? 1 : null,
        advance: fa || !fb ? 0 : 1,
        cause: 'fell',
        time: 0,
      };
    } else {
      const key = `${t}:${bm.index}:${m.a!.id}:${m.b!.id}`;
      let o = outcomes.get(key);
      if (!o) {
        o = await api.computeMatch(fa, fb, matchSeed(t, bm.index));
        outcomes.set(key, o);
      }
      // サーバーの正式な結果(同じ組み合わせ)があれば、勝敗と勝ち上がりはそちらを使う
      const off = officialOf.get(bm.index);
      if (off && off.a === m.a!.id && off.b === m.b!.id) {
        const advance = off.advance ?? (off.winner !== null ? off.winner : o.advance);
        o = { ...o, winner: off.winner, advance, cause: (off.cause as RankedOutcome['cause'] | null) ?? o.cause };
      }
      m.outcome = o;
    }
    onProgress?.({ ...lt, matches: [...matches] });
  }
  return lt;
}

/** 自動で取得した最後のトーナメント(画面を開き直しても、同じトーナメントの間は取得し直さない) */
let autoSyncedT = -1;
/** 更新ボタンを続けて押せない時間 [ms] */
const REFRESH_COOLDOWN = 15_000;

/**
 * 自分のモンスターが出た試合を、マイキャラのリプレイに保存する(試合の配信が終わってから。一度保存したら、消しても保存し直さない)
 */
async function saveMyReplays(lt: LiveTournament, me: string, playerName: (owner: string) => string): Promise<void> {
  const rounds = lt.matches.length ? lt.matches[lt.matches.length - 1].round + 1 : 0;
  for (const m of lt.matches) {
    if (!m.outcome || m.forfeit || !m.a || !m.b) continue;
    const side = m.a.owner === me ? 0 : m.b.owner === me ? 1 : -1;
    if (side < 0) continue;
    const end = matchSlotStart(lt.t, m.index) + introMs + m.outcome.time * 1000;
    if (end > Date.now()) continue;
    const id = `tournament:${lt.t}:${m.index}`;
    const flag = `replay-saved:${id}`;
    if (await getSetting<boolean>(flag)) continue;
    const f = await api.entryFighters([m.a.id, m.b.id]);
    const fa = f.get(m.a.id);
    const fb = f.get(m.b.id);
    if (!fa || !fb) continue;
    const names: [string, string] = [`${m.a.name}(${playerName(m.a.owner)})`, `${m.b.name}(${playerName(m.b.owner)})`];
    const result = m.outcome.winner === null ? '引き分け' : m.outcome.winner === side ? '勝ち' : '負け';
    const record: BattleRecord = { seed: matchSeed(lt.t, m.index), names, fighters: [fa, fb] };
    await saveReplay({
      id,
      kind: 'tournament',
      title: `トーナメント ${roundName(m.round, rounds)}:${names[0]} vs ${names[1]}(${result})`,
      createdAt: end,
      data: record,
    });
    await setSetting(flag, true);
  }
}

/** 計算した試合の結果(報告するもの) */
function reportsOf(lt: LiveTournament): api.PendingReport[] {
  return lt.matches.flatMap((m) =>
    m.outcome && !m.forfeit && m.a && m.b ? [{ tournament: lt.t, match: m.index, a: m.a.id, b: m.b.id, outcome: m.outcome }] : [],
  );
}

const roundName = (round: number, rounds: number) =>
  round === rounds - 1 ? '決勝' : round === rounds - 2 ? '準決勝' : round === rounds - 3 ? '準々決勝' : `${round + 1}回戦`;

const causeText = (o: RankedOutcome) =>
  o.winner === null ? (o.cause === 'both' ? '両者脱落(判定)' : '時間切れ(判定)') : o.cause === 'pushed' ? '押し出し' : '自滅';

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function RankedScene({ charId, character, active, view }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<EpisodeViewer | null>(null);
  const rapierRef = useRef<Rapier | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('rating');
  const [division, setDivision] = useState<Division>('tournament');
  // サーバーから取得してブラウザに保存している情報(取得するのは、開いたとき・トーナメントの開始・更新ボタンのときだけ)
  const [snap, setSnap] = useState<api.RankedSnapshot>({
    versions: [],
    players: new Map(),
    results: [],
    randomMatches: [],
    randomResults: [],
    syncedAt: 0,
    outdated: false,
    needsSql: false,
  });
  const { versions, players, results, randomMatches, randomResults } = snap;
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(0);
  const [started, setStarted] = useState(false);
  const [, setTick] = useState(0);
  const [live, setLive] = useState<LiveTournament | null>(null);
  const [prev, setPrev] = useState<LiveTournament | null>(null);
  const [races, setRaces] = useState<Map<number, RaceRecord>>(new Map());
  const [me, setMe] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  /** 再生中のリプレイ(いまのトーナメントの、終わった試合)。次のトーナメントが始まったら消える */
  const [replay, setReplay] = useState<{ t: number; m: number } | null>(null);
  const [replaySpeed, setReplaySpeed] = useState<1 | 4>(1);
  const replayRef = useRef(replay);
  replayRef.current = replay;
  /** 配信中の試合(`t:m`)。null なら次の確認で映し直す */
  const shownRef = useRef<string | null>(null);
  const catchingRef = useRef(false);
  const liveRef = useRef<LiveTournament | null>(null);
  liveRef.current = live;

  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  // 表示の準備
  useEffect(() => {
    if (!api.onlineConfigured) return;
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

  // 試合の計算と結果の報告。この画面を開いていて、ブラウザのタブが見えている間だけ動かす
  useEffect(() => {
    if (!active || !api.onlineConfigured) return;
    let cancelled = false;
    const unsubscribe = api.subscribeRanked((x) => !cancelled && setSnap(x));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const loop = async () => {
      let first = true;
      let myId = '';
      let s = await api.rankedSnapshot();
      if (!cancelled) setSnap(s);
      while (!cancelled) {
        try {
          if (document.hidden) {
            await sleep(5000);
            continue;
          }
          if (first) {
            const { id, player } = await api.myPlayer();
            if (cancelled) return;
            myId = id;
            setMe(id);
            if (player) setNameInput((n) => n || player.name);
            first = false;
          }
          const t = tournamentAt(Date.now());
          // 自動で取得するのは、この画面を初めて開いたときと、新しいトーナメントが始まったとき(出場者を決めるため)だけ
          if (autoSyncedT !== t) {
            s = await api.syncRanked();
            autoSyncedT = t;
            if (cancelled) return;
            // 報告されないまま残ったランダムマッチを代わりに計算する
            await api.settlePendingRandomMatches(s.randomMatches, s.randomResults);
          }
          s = await api.rankedSnapshot();
          const vs = s.versions;
          const cur = await resolveTournament(t, vs, s.results, (lt) => !cancelled && setLive(lt));
          const last = await resolveTournament(t - 1, vs, s.results, (lt) => !cancelled && setPrev(lt));
          const pending = [...reportsOf(cur), ...reportsOf(last)];
          // 誰も計算しなかった過去のトーナメントの結果を補う
          const have = new Set(s.results.map((r) => `${r.tournament}:${r.match}`));
          for (let k = 2; k <= BACKFILL && !cancelled; k++) {
            const tk = t - k;
            const n = bracketFor(entrantsFor(tk, vs).length).length;
            let missing = false;
            for (let i = 0; i < n; i++) if (!have.has(`${tk}:${i}`)) missing = true;
            if (missing) pending.push(...reportsOf(await resolveTournament(tk, vs, s.results)));
          }
          // 報告はまとめて1回で(報告済みの試合は送らない)。送ったら、正式な結果を取り直してランキングにそろえる
          if ((await api.reportResults(pending)) > 0) s = await api.syncRanked();
          const nameOf = (owner: string) => s.players.get(owner) ?? '名無し';
          await saveMyReplays(last, myId, nameOf);
          await saveMyReplays(cur, myId, nameOf);
          if (!cancelled) setFatal(null);
        } catch (e) {
          // 準備ができていない・通信できないときは、少し待ってからやり直す
          if (!cancelled) setFatal((e as Error).message);
          autoSyncedT = -1;
          await sleep(30_000);
        }
        await sleep(5000);
      }
    };
    void loop();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active]);

  /** 更新ボタン:登録・名前・結果の新しい分を取得する */
  const refresh = async () => {
    setRefreshing(true);
    setLastRefresh(Date.now());
    try {
      const s = await api.syncRanked();
      await api.settlePendingRandomMatches(s.randomMatches, s.randomResults);
      setFatal(null);
    } catch (e) {
      setFatal((e as Error).message);
    }
    setRefreshing(false);
  };

  // 配信:時刻に合わせて、いまの試合を途中から映す
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.speed = active ? (replay ? replaySpeed : 1) : 0;
    if (!active) {
      shownRef.current = null;
      return;
    }
    const timer = setInterval(() => {
      setTick((x) => x + 1);
      const R = rapierRef.current;
      const lt = liveRef.current;
      const now = Date.now();
      const t = tournamentAt(now);
      // リプレイを見ている間は配信を止める。次のトーナメントが始まったら、前のトーナメントのリプレイは消す
      if (replayRef.current) {
        if (replayRef.current.t === t) return;
        setReplay(null);
        viewer.showNothing();
        shownRef.current = null;
      }
      const m = Math.floor((now - tournamentStart(t)) / slotMs);
      const key = `${t}:${m}`;
      const offset = now - matchSlotStart(t, m);
      const match = lt && lt.t === t ? lt.matches[m] : undefined;
      if (shownRef.current !== null && shownRef.current !== key) {
        viewer.showNothing();
        shownRef.current = null;
      }
      if (!R || catchingRef.current || shownRef.current === key || offset < introMs || !match?.outcome || match.forfeit) return;
      // 試合のデータは計算のときに読み込み済み
      catchingRef.current = true;
      void (async () => {
        try {
          const f = await api.entryFighters([match.a!.id, match.b!.id]);
          const ep = new MatchEpisode(R, {
            mode: 'battle',
            seed: matchSeed(t, m),
            fighters: [f.get(match.a!.id)!, f.get(match.b!.id)!],
          });
          // 途中から見る場合は、いまの時刻まで少しずつ進める(画面を止めないように)
          const target = () => (Date.now() - matchSlotStart(t, m) - introMs) / 1000;
          while (!ep.done && ep.time + PHYSICS.dt <= target()) {
            for (let i = 0; i < 240 && !ep.done && ep.time + PHYSICS.dt <= target(); i++) ep.advance();
            await new Promise((r) => setTimeout(r, 0));
          }
          viewer.setEpisodes(ep);
          shownRef.current = key;
        } finally {
          catchingRef.current = false;
        }
      })();
    }, 250);
    return () => clearInterval(timer);
  }, [active, started, replay, replaySpeed]);

  /** いまのトーナメントの終わった試合を、最初から再生する */
  const playReplay = async (lt: LiveTournament, m: LiveMatch) => {
    const R = rapierRef.current;
    const viewer = viewerRef.current;
    if (!R || !viewer || !m.a || !m.b) return;
    const f = await api.entryFighters([m.a.id, m.b.id]);
    const fa = f.get(m.a.id);
    const fb = f.get(m.b.id);
    if (!fa || !fb) return;
    viewer.setEpisodes(new MatchEpisode(R, { mode: 'battle', seed: matchSeed(lt.t, m.index), fighters: [fa, fb] }));
    shownRef.current = null;
    setReplay({ t: lt.t, m: m.index });
  };

  const backToLive = () => {
    setReplay(null);
    viewerRef.current?.showNothing();
    shownRef.current = null;
  };

  // いまのトーナメントの出場登録(プレイヤーごとの最新)と、モンスターごとの最新の版
  const latestByOwner = useMemo(() => {
    const m = new Map<string, EntryVersion>();
    for (const v of versions) {
      if (!v.tournament) continue;
      const cur = m.get(v.owner);
      if (!cur || v.id > cur.id) m.set(v.owner, v);
    }
    return m;
  }, [versions]);
  // 同じプレイヤーの、キャラの id か名前が同じ版は同じモンスター(記録とレートを引き継ぐ)
  const groups = useMemo(() => monsterGroups(versions), [versions]);
  const latestByMonster = useMemo(() => {
    const m = new Map<string, EntryVersion>();
    for (const v of versions) {
      const k = groups.keyOf.get(v.id)!;
      const cur = m.get(k);
      if (!cur || v.id > cur.id) m.set(k, v);
    }
    return m;
  }, [versions, groups]);

  const now = Date.now();
  const playerName = (owner: string) => players.get(owner) ?? '名無し';

  // トーナメントのランキング:サーバーの正式な結果だけで数える(このブラウザで計算した結果は混ぜない。
  // 混ぜると、端末ごとに計算の版や取得のタイミングが違うときに、ランキングが端末ごとに変わってしまう)。試合の時刻が過ぎた結果だけを数える
  const visible = results.filter((r) => matchSlotStart(r.tournament, r.match) + slotMs <= now);
  const tournamentStats = computeStats(visible, (id) => groups.keyOf.get(id));
  const randomStatsMap = api.randomStats(randomMatches, randomResults, groups);
  const currentKeys = new Set([...latestByOwner.values()].map((v) => groups.keyOf.get(v.id)!));
  // トーナメント:一度でも試合をしたモンスターと、いま出場登録しているモンスター。ランダムマッチ:試合をしたモンスター
  const stats = division === 'tournament' ? tournamentStats : randomStatsMap;
  const keys = division === 'tournament' ? new Set([...tournamentStats.keys(), ...currentKeys]) : new Set(randomStatsMap.keys());
  const rows = [...keys].flatMap((k) => {
    const v = latestByMonster.get(k);
    if (!v) return [];
    const s = stats.get(k);
    return [
      {
        key: k,
        owner: v.owner,
        entryId: v.id,
        player: playerName(v.owner),
        monster: v.name,
        current: currentKeys.has(k),
        rating: s?.rating ?? RANKED.initialRating,
        games: s ? s.wins + s.losses + s.draws : 0,
        wins: s?.wins ?? 0,
        losses: s?.losses ?? 0,
        draws: s?.draws ?? 0,
        pushWins: s?.pushWins ?? 0,
        race: races.get(v.id),
      },
    ];
  });
  const raceKey = (r: RaceRecord | undefined) => (r ? (r.best !== null ? r.best : RACE.timeLimit + (RACE.distance - r.distance)) : Infinity);
  rows.sort((x, y) =>
    sortKey === 'rating'
      ? y.rating - x.rating || y.wins - x.wins
      : sortKey === 'wins'
        ? y.wins - x.wins || y.rating - x.rating
        : sortKey === 'jump'
          ? (y.race?.jump ?? -1) - (x.race?.jump ?? -1)
          : raceKey(x.race) - raceKey(y.race),
  );
  const raceIds = rows.map((r) => r.entryId).join(',');

  // ランキングを開いたら、かけっこの公式記録を測る(登録の版ごとに1回。結果はブラウザに保存する)
  useEffect(() => {
    if (!active || view !== 'ranking' || !raceIds) return;
    let cancelled = false;
    void (async () => {
      for (const id of raceIds.split(',').map(Number)) {
        if (cancelled) return;
        if (races.has(id)) continue;
        // ジャンプの記録を足したので、保存のキーを変えて測り直す
        const key = `ranked-race2:${id}`;
        let rec = await getSetting<RaceRecord>(key);
        if (!rec) {
          const f = (await api.entryFighters([id])).get(id);
          if (!f) continue;
          rec = await api.computeRace(id, f);
          await setSetting(key, rec);
        }
        if (!cancelled) setRaces((m) => new Map(m).set(id, rec!));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, view, raceIds]);

  if (!api.onlineConfigured) {
    return (
      <div className="library">
        <section className="card">
          <h2>ランクマッチ(準備中)</h2>
          <p>
            ランクマッチを使うには、オンライン機能の設定が必要です。手順は <code>docs/ONLINE.md</code> にまとめてあります。
          </p>
        </section>
      </div>
    );
  }

  const t = tournamentAt(now);
  const slot = Math.floor((now - tournamentStart(t)) / slotMs);
  const offset = now - matchSlotStart(t, slot);
  const cur = live && live.t === t ? live : null;
  const curMatch = cur?.matches[slot];
  const nextStart = tournamentStart(t + 1);
  const label = (e: EntryVersion | null) => (e ? `${e.name}(${playerName(e.owner)})` : '未定');

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
  const myEntry = me ? latestByOwner.get(me) : undefined;
  const myName = me ? players.get(me) : undefined;
  const ready = canEnter(character);

  const bracketView = (lt: LiveTournament, highlight: number | null, replayable: boolean) => {
    const rounds = lt.matches.length ? lt.matches[lt.matches.length - 1].round + 1 : 0;
    const shown = (m: LiveMatch) => matchSlotStart(lt.t, m.index) + introMs + (m.outcome?.time ?? BATTLE.timeLimit) * 1000 <= now;
    // 勝ち上がりの元の試合がまだ配信で終わっていなければ、勝者の名前を出さない(先の試合の結果が分かってしまうため)
    const side = (e: EntryVersion | null, from: number | null) => (from !== null && !shown(lt.matches[from]) ? `第${from + 1}試合の勝者` : label(e));
    return (
      <ol className="bracket">
        {lt.matches.map((m) => (
          <li key={m.index} className={m.index === highlight ? 'current' : ''}>
            <span className="muted small">
              {roundName(m.round, rounds)}・
              {new Date(matchSlotStart(lt.t, m.index)).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <span>
              <b className={m.outcome && shown(m) && m.outcome.advance === 0 ? 'winner' : ''}>{side(m.a, m.fromA)}</b> vs{' '}
              <b className={m.outcome && shown(m) && m.outcome.advance === 1 ? 'winner' : ''}>{side(m.b, m.fromB)}</b>
            </span>
            {m.outcome && shown(m) && (
              <span className="muted small">
                {m.forfeit ? '不戦勝' : causeText(m.outcome)}
                {replayable && !m.forfeit && (
                  <button className="small-button replay-button" onClick={() => void playReplay(lt, m)} disabled={replay?.m === m.index}>
                    {replay?.m === m.index ? '再生中' : 'リプレイ'}
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
      </ol>
    );
  };

  // 配信画面の上に重ねる表示
  let overlay: React.ReactNode = null;
  const replayMatch = replay && cur && cur.t === replay.t ? cur.matches[replay.m] : null;
  const replayEp = replayMatch ? (viewerRef.current?.currentEpisode as MatchEpisode | null) : null;
  if (fatal) overlay = <div className="live-card error">{fatal}</div>;
  else if (replayMatch && replayMatch.outcome) {
    const o = replayMatch.outcome;
    const time = replayEp?.time ?? 0;
    overlay =
      replayEp?.done || time >= o.time ? (
        <div className="live-card result-card">
          <div className="live-title">{o.winner === null ? '引き分け' : `${label(o.winner === 0 ? replayMatch.a : replayMatch.b)} の勝ち`}</div>
          <div className="muted">
            {causeText(o)}・{o.time.toFixed(1)}秒(リプレイ)
          </div>
        </div>
      ) : (
        <div className="battle-hud">
          <div className="timer">{Math.max(0, BATTLE.timeLimit - time).toFixed(0)}</div>
          <div style={{ color: hex(TEAM_COLORS[0]) }}>● {label(replayMatch.a)}</div>
          <div style={{ color: hex(TEAM_COLORS[1]) }}>● {label(replayMatch.b)}</div>
          <div className="safe">リプレイ</div>
        </div>
      );
  } else if (!cur) overlay = <div className="live-card">トーナメントを準備しています…</div>;
  else if (cur.entrants.length < 2)
    overlay = (
      <div className="live-card">
        <div className="live-title">出場者が足りません</div>
        <div>
          次のトーナメントは{' '}
          {new Date(nextStart).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}{' '}
          から(あと {clock(nextStart - now)})
        </div>
        <div className="muted small">
          モンスターを2人以上が登録すると、{RANKED.interval / 60}
          分ごとに自動でトーナメントが開かれます
        </div>
      </div>
    );
  else if (!curMatch)
    overlay = (
      <div className="live-card">
        <div className="live-title">今回のトーナメントは終わりました</div>
        {(() => {
          const final = cur.matches[cur.matches.length - 1];
          const champ = final.outcome ? (final.outcome.advance === 0 ? final.a : final.b) : null;
          return champ && <div className="live-champion">優勝:{label(champ)}</div>;
        })()}
        <div>次のトーナメントまで あと {clock(nextStart - now)}</div>
      </div>
    );
  else if (offset < introMs)
    overlay = (
      <div className="live-card">
        <div className="live-title">
          {roundName(curMatch.round, cur.matches[cur.matches.length - 1].round + 1)}
          (第{slot + 1}試合)
        </div>
        <div className="live-vs">
          <span style={{ color: hex(TEAM_COLORS[0]) }}>{label(curMatch.a)}</span>
          <span className="muted">VS</span>
          <span style={{ color: hex(TEAM_COLORS[1]) }}>{label(curMatch.b)}</span>
        </div>
        <div>試合開始まで {clock(introMs - offset)}</div>
      </div>
    );
  else if (!curMatch.outcome) overlay = <div className="live-card">試合を計算しています…</div>;
  else if (curMatch.forfeit) overlay = <div className="live-card">相手のデータが読めないため、不戦勝です</div>;
  else {
    const elapsed = (offset - introMs) / 1000;
    const o = curMatch.outcome;
    overlay =
      elapsed >= o.time ? (
        <div className="live-card result-card">
          <div className="live-title">{o.winner === null ? '引き分け' : `${label(o.winner === 0 ? curMatch.a : curMatch.b)} の勝ち`}</div>
          <div className="muted">
            {causeText(o)}・{o.time.toFixed(1)}秒{o.winner === null ? `・${label(o.advance === 0 ? curMatch.a : curMatch.b)} が勝ち上がり` : ''}
          </div>
          <div className="muted small">次の試合まで {clock(slotMs - offset)}</div>
        </div>
      ) : (
        <div className="battle-hud">
          <div className="timer">{Math.max(0, BATTLE.timeLimit - elapsed).toFixed(0)}</div>
          <div style={{ color: hex(TEAM_COLORS[0]) }}>● {label(curMatch.a)}</div>
          <div style={{ color: hex(TEAM_COLORS[1]) }}>● {label(curMatch.b)}</div>
          <div className="safe">LIVE</div>
        </div>
      );
  }

  return (
    <div className="battle">
      <aside className="panel">
        <h2>{VIEW_TITLES[view]}</h2>
        {snap.outdated && <p className="message error">新しいバージョンがあります。ページを再読み込みしてください(古いページの計算は報告しません)</p>}
        {snap.needsSql && (
          <p className="message">
            サーバーの設定が古いため、端末によって結果がずれることがあります。Supabase で supabase/fix-ranked-consistency.sql を実行してください
          </p>
        )}
        <div className="refresh-row">
          <span className="muted small">
            {snap.syncedAt ? `最終更新 ${new Date(snap.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'まだ取得していません'}
          </span>
          <button
            className="small-button"
            disabled={refreshing || now - lastRefresh < REFRESH_COOLDOWN}
            onClick={() => void refresh()}
            title="新しい登録・プレイヤー名・試合の結果を取得します(トーナメントが始まるときは自動で取得します)"
          >
            {refreshing ? '取得中…' : '更新'}
          </button>
        </div>

        {view === 'entry' && (
          <>
            <h3>プレイヤー名</h3>
            <input type="text" maxLength={20} value={nameInput} placeholder="20文字まで" onChange={(e) => setNameInput(e.target.value)} />
            <div className="row">
              <button
                disabled={busy || !me}
                onClick={() =>
                  run(async () => {
                    await api.savePlayerName(nameInput);
                    setMessage({
                      text: 'プレイヤー名を登録しました',
                      error: false,
                    });
                  })
                }
              >
                名前を登録
              </button>
            </div>
            <h3>出場するモンスター(1人1体)</h3>
            <p className="muted small">
              {myEntry ? `いまの登録:「${myEntry.name}」(${new Date(myEntry.createdAt).toLocaleString()})` : 'まだ登録していません'}
            </p>
            <div className="row">
              <button
                className="primary"
                disabled={busy || !ready || !myName}
                onClick={() =>
                  run(async () => {
                    await api.registerRankedEntry(character, charId);
                    setMessage({
                      text: `「${character.name}」を登録しました。次のトーナメントから出場します`,
                      error: false,
                    });
                  })
                }
              >
                「{character.name}」で出場する
              </button>
            </div>
            {!myName && <p className="message">先にプレイヤー名を登録してください</p>}
            {!ready && <p className="message">トレーニング「2. 対象を追う」に合格したキャラだけ登録できます</p>}
            {ready && !character.decision && (
              <p className="muted small">
                判断脳をまだ鍛えていないので、バトルでは相手に向かって突進します(トレーニング「危険なタイルを避ける」以降で判断脳を鍛えると、作戦を考えて戦います)
              </p>
            )}
            <p className="muted small">
              {RANKED.interval / 60}
              分ごとに、登録されたモンスターからトーナメント(最大
              {RANKED.maxEntrants}体、多いときは抽選)が組まれ、
              {RANKED.slot / 60}
              分ごとに1試合ずつ自動で戦います。試合はみんなのブラウザで同じように再現され、結果からレートが決まります。登録し直すと、次のトーナメントから新しいモンスターで出場します。
            </p>
          </>
        )}

        {view === 'live' && (
          <>
            <p className="muted small">
              {cur && cur.entrants.length >= 2 ? `今回のトーナメント(${cur.entrants.length}体)` : '今回のトーナメント'}
              ・次は{' '}
              {new Date(nextStart).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              から
            </p>
            {cur && cur.matches.length > 0 && bracketView(cur, replay ? replay.m : slot, true)}
            {prev && prev.matches.length > 0 && (
              <>
                <h3>前回のトーナメント</h3>
                {bracketView(prev, null, false)}
              </>
            )}
          </>
        )}

        {view === 'ranking' && (
          <>
            <div className="segmented">
              <button className={division === 'tournament' ? 'selected' : ''} onClick={() => setDivision('tournament')}>
                トーナメント
              </button>
              <button className={division === 'random' ? 'selected' : ''} onClick={() => setDivision('random')}>
                ランダムマッチ
              </button>
            </div>
            <p className="muted small">
              {division === 'tournament'
                ? '自動トーナメントのレートです。記録はモンスターごとに残り、出場するモンスターを替えても前のモンスターの記録は消えません(★ = いま出場中)。'
                : '種目の画面の「ランダムマッチ」のレートです(トーナメントとは別)。同じ2体は1回だけ戦えます。'}
              レートは {RANKED.initialRating} から始まります。かけっこは {RACE.distance}m の公式記録(決まった{RANKED.raceSeeds.length}回の最速)です。
            </p>
            <div className="segmented">
              {(
                [
                  ['rating', 'レート'],
                  ['wins', '勝利数'],
                  ['race', 'かけっこ'],
                  ['jump', 'ジャンプ'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={sortKey === k ? 'selected' : ''} onClick={() => setSortKey(k)}>
                  {l}
                </button>
              ))}
            </div>
          </>
        )}
        {message && <p className={message.error ? 'message error' : 'message'}>{message.text}</p>}
      </aside>
      <div className="viewport">
        <canvas ref={canvasRef} />
        {view !== 'ranking' && (
          <div className="speed">
            <BrainToggle viewer={() => viewerRef.current} />
            {replay && (
              <>
                {([1, 4] as const).map((x) => (
                  <button key={x} className={replaySpeed === x ? 'selected' : ''} onClick={() => setReplaySpeed(x)}>
                    {x}倍
                  </button>
                ))}
                <button onClick={backToLive}>ライブに戻る</button>
              </>
            )}
          </div>
        )}
        {view === 'ranking' ? (
          <div className="ranked-board">
            <table>
              <thead>
                <tr>
                  <th>順位</th>
                  <th>プレイヤー</th>
                  <th>モンスター</th>
                  <th>レート</th>
                  <th>勝利数</th>
                  <th>成績</th>
                  <th>かけっこ</th>
                  <th>ジャンプ</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      {division === 'tournament' ? 'まだ登録がありません' : 'まだ試合がありません'}
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={r.key} className={r.owner === me ? 'mine' : ''}>
                    <td>{i + 1}</td>
                    <td>{r.player}</td>
                    <td>
                      {r.monster}
                      {division === 'tournament' && r.current ? ' ★' : ''}
                    </td>
                    <td>{Math.round(r.rating)}</td>
                    <td>{r.wins}</td>
                    <td className="muted small">
                      {r.games}戦 {r.wins}勝{r.losses}敗{r.draws ? `${r.draws}分` : ''}
                      {r.pushWins ? `(押し出し${r.pushWins})` : ''}
                    </td>
                    <td>
                      {r.race ? (
                        r.race.best !== null ? (
                          `${r.race.best.toFixed(2)}秒`
                        ) : (
                          `${r.race.distance.toFixed(1)}m`
                        )
                      ) : (
                        <span className="muted">計測中…</span>
                      )}
                    </td>
                    <td>{r.race ? `${(r.race.jump * 100).toFixed(0)}cm` : <span className="muted">計測中…</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          overlay
        )}
      </div>
    </div>
  );
}
