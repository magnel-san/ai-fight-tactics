// ランクマッチ(自動トーナメント・レート)のテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { createDecisionGenome } from '../src/core/brain/decision';
import { createMotorGenome } from '../src/core/brain/motor';
import { RANKED } from '../src/core/config';
import { QUADRUPED } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { raceRecord, runRankedMatch } from '../src/core/ranked/run';
import {
  bracketFor,
  computeRatings,
  computeStats,
  entrantsFor,
  matchSlotStart,
  monsterGroups,
  monsterKey,
  randomMatchSeed,
  tournamentAt,
  tournamentStart,
  type EntryVersion,
} from '../src/core/ranked/tournament';

const v = (id: number, owner: string, createdAt: number, tournament = true): EntryVersion => ({
  id,
  owner,
  name: `m${id}`,
  monster: '',
  tournament,
  createdAt,
});

describe('トーナメントの日程と出場者', () => {
  it('時刻からトーナメントの番号と開始時刻が決まる', () => {
    const t = tournamentAt(Date.UTC(2026, 9, 6, 12, 40));
    expect(tournamentStart(t)).toBe(Date.UTC(2026, 9, 6, 12, 30));
    expect(matchSlotStart(t, 2) - tournamentStart(t)).toBe(2 * RANKED.slot * 1000);
  });

  it('出場者は開始より前の、各プレイヤーの最新の版', () => {
    const t = 1000;
    const start = tournamentStart(t);
    const versions = [v(1, 'A', start - 5000), v(2, 'A', start - 1000), v(3, 'B', start - 3000), v(4, 'B', start + 10), v(5, 'C', start + 5)];
    // ランダムマッチ用の控えはトーナメントに出ない
    versions.push(v(6, 'B', start - 2000, false), v(7, 'D', start - 2000, false));
    const e = entrantsFor(t, versions);
    expect(e.map((x) => x.id).sort()).toEqual([2, 3]);
  });

  it('多いときは最大数まで抽選し、同じトーナメントなら同じ結果', () => {
    const versions = Array.from({ length: 20 }, (_, i) => v(i + 1, `P${i}`, 0));
    const a = entrantsFor(5000, versions);
    expect(a.length).toBe(RANKED.maxEntrants);
    expect(entrantsFor(5000, versions)).toEqual(a);
    expect(entrantsFor(5001, versions).map((x) => x.id)).not.toEqual(a.map((x) => x.id));
  });
});

describe('組み合わせ', () => {
  it('n人なら n-1 試合で、決勝は最後', () => {
    for (let n = 2; n <= 8; n++) {
      const b = bracketFor(n);
      expect(b.length).toBe(n - 1);
      const final = b[b.length - 1];
      expect(final.round).toBe(Math.max(...b.map((m) => m.round)));
      // 全員がどこかの試合に出る(不戦勝の人は2回戦から)
      const appears = new Set<number>();
      for (const m of b) {
        if (m.a !== null) appears.add(m.a);
        if (m.b !== null) appears.add(m.b);
      }
      expect(appears.size).toBe(n);
      // 勝ち上がり元は、必ずそれより前の試合
      for (const m of b) {
        if (m.fromA !== null) expect(m.fromA).toBeLessThan(m.index);
        if (m.fromB !== null) expect(m.fromB).toBeLessThan(m.index);
      }
    }
    expect(bracketFor(1)).toEqual([]);
  });
});

describe('レート', () => {
  it('勝つと上がり、負けると同じだけ下がる。引き分けは同じレートなら変わらない', () => {
    const owner = (id: number) => (id === 1 ? 'A' : 'B');
    const s = computeStats([{ tournament: 1, match: 0, a: 1, b: 2, winner: 0, cause: 'pushed' }], owner);
    const A = s.get('A')!;
    const B = s.get('B')!;
    expect(A.rating).toBeCloseTo(RANKED.initialRating + RANKED.kFactor / 2, 6);
    expect(B.rating).toBeCloseTo(RANKED.initialRating - RANKED.kFactor / 2, 6);
    expect(A.wins).toBe(1);
    expect(A.pushWins).toBe(1);
    expect(B.losses).toBe(1);
    const d = computeStats([{ tournament: 1, match: 0, a: 1, b: 2, winner: null, cause: 'timeout' }], owner);
    expect(d.get('A')!.rating).toBeCloseTo(RANKED.initialRating, 6);
    expect(d.get('A')!.draws).toBe(1);
  });

  it('試合の順に反映する(報告の並びに関係なく同じ結果)', () => {
    const owner = (id: number) => ['A', 'B', 'C'][id];
    const rows = [
      {
        tournament: 2,
        match: 0,
        a: 0,
        b: 2,
        winner: 1 as const,
        cause: 'fell',
      },
      {
        tournament: 1,
        match: 0,
        a: 0,
        b: 1,
        winner: 0 as const,
        cause: 'pushed',
      },
      { tournament: 1, match: 1, a: 1, b: 2, winner: null, cause: 'timeout' },
    ];
    const x = computeStats(rows, owner);
    const y = computeStats([...rows].reverse(), owner);
    for (const k of ['A', 'B', 'C']) expect(x.get(k)!.rating).toBe(y.get(k)!.rating);
  });

  it('記録はモンスターごと:出場するモンスターを替えても、前のモンスターの記録は残る', () => {
    const versions: EntryVersion[] = [
      { id: 1, owner: 'P', name: 'いぬ', monster: 'c1', tournament: true, createdAt: 0 },
      { id: 2, owner: 'Q', name: 'ねこ', monster: 'c2', tournament: true, createdAt: 0 },
      { id: 3, owner: 'P', name: 'とり', monster: 'c3', tournament: true, createdAt: 10 },
      // 同じモンスターの新しい版は、同じ記録に足される
      { id: 4, owner: 'Q', name: 'ねこ2', monster: 'c2', tournament: true, createdAt: 10 },
    ];
    const keyOf = (id: number) => {
      const e = versions.find((x) => x.id === id);
      return e && monsterKey(e);
    };
    const s = computeStats(
      [
        { tournament: 1, match: 0, a: 1, b: 2, winner: 0, cause: 'pushed' },
        { tournament: 2, match: 0, a: 3, b: 4, winner: 1, cause: 'fell' },
      ],
      keyOf,
    );
    expect(s.get('P:c1')!.wins).toBe(1);
    expect(s.get('P:c3')!.losses).toBe(1);
    expect(s.get('Q:c2')!.wins).toBe(1);
    expect(s.get('Q:c2')!.losses).toBe(1);
  });

  it('同じプレイヤーの、キャラの id か名前が同じ版は同じモンスターとして記録を引き継ぐ', () => {
    const e = (id: number, owner: string, name: string, monster: string): EntryVersion => ({ id, owner, name, monster, tournament: true, createdAt: id });
    const versions = [
      // id のない古い登録と、あとから id つきで登録し直した同じキャラ
      e(1, 'P', 'トライデント', ''),
      e(5, 'P', 'トライデント', 'c9'),
      // 同じキャラの名前を変えた
      e(7, 'P', 'トライデント改', 'c9'),
      // 別のキャラ
      e(8, 'P', 'ほかのキャラ', 'c2'),
      // 別のプレイヤーの同じ名前のキャラ
      e(9, 'Q', 'トライデント', 'c9'),
    ];
    const g = monsterGroups(versions);
    expect(g.keyOf.get(5)).toBe(g.keyOf.get(1));
    expect(g.keyOf.get(7)).toBe(g.keyOf.get(1));
    expect(g.keyOf.get(8)).not.toBe(g.keyOf.get(1));
    expect(g.keyOf.get(9)).not.toBe(g.keyOf.get(1));
    expect(g.find('P', 'c9', '新しい名前')).toBe(g.keyOf.get(1));
    expect(g.find('P', 'zz', 'トライデント')).toBe(g.keyOf.get(1));
    expect(g.find('P', 'zz', '未登録')).toBeUndefined();
    // 古い版で勝った記録と、新しい版で負けた記録が同じモンスターに足される
    const s = computeStats(
      [
        { tournament: 1, match: 0, a: 1, b: 9, winner: 0, cause: 'pushed' },
        { tournament: 2, match: 0, a: 5, b: 9, winner: 1, cause: 'fell' },
      ],
      (id) => g.keyOf.get(id),
    );
    const mine = s.get(g.keyOf.get(1)!)!;
    expect(mine.wins).toBe(1);
    expect(mine.losses).toBe(1);
  });

  it('ランダムマッチのレートは試合の順に計算し、トーナメントとは別', () => {
    const r = computeRatings([
      { a: 'X', b: 'Y', winner: 0, cause: 'pushed' },
      { a: 'Y', b: 'Z', winner: null, cause: 'timeout' },
    ]);
    expect(r.get('X')!.rating).toBeGreaterThan(RANKED.initialRating);
    expect(r.get('Y')!.draws).toBe(1);
    expect(randomMatchSeed(5)).toBe(randomMatchSeed(5));
    expect(randomMatchSeed(5)).not.toBe(randomMatchSeed(6));
  });
});

describe('ランクマッチの試合とかけっこの記録', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });
  const fighter = (s: number) => ({
    blueprint: QUADRUPED,
    motor: createMotorGenome(4, new Rng(s)),
    decision: createDecisionGenome(new Rng(s + 50)),
    controller: 'brain' as const,
  });

  it('同じシードなら同じ結果になり、引き分けでも勝ち上がる側が決まる', () => {
    const a = runRankedMatch(R, fighter(1), fighter(2), 77);
    expect(runRankedMatch(R, fighter(1), fighter(2), 77)).toEqual(a);
    expect([0, 1]).toContain(a.advance);
    if (a.winner !== null) expect(a.advance).toBe(a.winner);
  }, 60_000);

  it('かけっこの記録は何度測っても同じ', () => {
    const r = raceRecord(R, fighter(3));
    expect(raceRecord(R, fighter(3))).toEqual(r);
    expect(r.distance).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
