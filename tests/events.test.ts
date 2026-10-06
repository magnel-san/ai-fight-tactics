// 種目(かけっこ・サッカー)のテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { createMotorGenome, motorGenomeLength } from '../src/core/brain/motor';
import { RACE, SOCCER } from '../src/core/config';
import { QUADRUPED } from '../src/core/creature/samples';
import { RaceEpisode } from '../src/core/events/race';
import { SoccerEpisode } from '../src/core/events/soccer';
import { Rng } from '../src/core/math/rng';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import type { FighterData } from '../src/core/training/tasks';

let R: Rapier;
beforeAll(async () => {
  R = await initRapier();
});

const runner = (seed: number | null): FighterData => ({
  blueprint: QUADRUPED,
  motor: seed === null ? new Float64Array(motorGenomeLength(4)) : createMotorGenome(4, new Rng(seed)),
  decision: null,
  controller: 'brain',
});

describe('かけっこ', () => {
  it('順位は全員に重複なくつき、同じシードなら結果が一致する', () => {
    const run = () => {
      const ep = new RaceEpisode(R, [runner(1), runner(2), runner(null)], 9);
      ep.run();
      const r = ep.result();
      ep.free();
      return r;
    };
    const a = run();
    expect([...a.rank].sort()).toEqual([0, 1, 2]);
    expect(run()).toEqual(a);
    expect(a.distance.every((d) => d <= RACE.distance)).toBe(true);
  }, 60_000);

  it('関節を動かさないキャラは、ほとんど進まない', () => {
    const ep = new RaceEpisode(R, [runner(null)], 1);
    ep.run();
    expect(ep.result().distance[0]).toBeLessThan(0.5);
    expect(ep.result().finishAt[0]).toBeNull();
    ep.free();
  });

  it('5人以上は走れない', () => {
    expect(() => new RaceEpisode(R, [1, 2, 3, 4, 5].map(runner), 1)).toThrow();
  });
});

describe('サッカー', () => {
  it('3対3で最後まで進み、得点と勝敗が決まる。同じシードなら一致する', () => {
    const team = (s: number) => [runner(s), runner(s + 1), runner(s + 2)];
    const run = () => {
      const ep = new SoccerEpisode(R, team(10), team(20), 4);
      expect(ep.fighters.length).toBe(6);
      expect(ep.teams).toEqual([0, 0, 0, 1, 1, 1]);
      const o = ep.run();
      const r = ep.result();
      ep.free();
      return { r, t: o.time };
    };
    const a = run();
    expect(a.t).toBeGreaterThanOrEqual(SOCCER.timeLimit);
    expect(a.r.goals.length).toBe(a.r.score[0] + a.r.score[1]);
    expect(run()).toEqual(a);
  }, 60_000);

  it('ボールが相手のゴールに入ると得点になり、ボールは中央に戻る', () => {
    const team = [runner(null), runner(null), runner(null)];
    const ep = new SoccerEpisode(R, team, team, 1);
    // +z 側のゴールの中にボールを置く → チームA(0)の得点
    ep.ball.setTranslation({ x: 0, y: SOCCER.ballRadius, z: SOCCER.halfLength + 0.6 }, true);
    for (let i = 0; i < 6; i++) ep.advance();
    expect(ep.result().score).toEqual([1, 0]);
    expect(Math.abs(ep.ball.translation().z)).toBeLessThan(1);
    ep.free();
  });
});
