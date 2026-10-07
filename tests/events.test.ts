// 種目(かけっこ・サッカー)のテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { createMotorGenome, motorGenomeLength } from '../src/core/brain/motor';
import { HIGH_JUMP, RACE, SOCCER } from '../src/core/config';
import { createSoccerGenome, SoccerBrain } from '../src/core/brain/soccer';
import { HighJumpEpisode } from '../src/core/events/highjump';
import { Fighter } from '../src/core/sim/fighter';
import { SoccerDrillEpisode } from '../src/core/training/soccerDrill';
import { SprintEpisode } from '../src/core/training/sprint';
import { QUADRUPED } from '../src/core/creature/samples';
import { RaceEpisode } from '../src/core/events/race';
import { DEFAULT_ROLES, SoccerEpisode, type SoccerPlayer } from '../src/core/events/soccer';
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
  const players = (seeds: (number | null)[]): SoccerPlayer[] => seeds.map((sd, i) => ({ data: runner(sd), role: DEFAULT_ROLES[i] }));

  it('3対3で最後まで進み、得点と勝敗が決まる。同じシードなら一致する', () => {
    const run = () => {
      const ep = new SoccerEpisode(R, players([10, 11, 12]), players([20, 21, 22]), 4);
      expect(ep.fighters.length).toBe(6);
      expect(ep.teams).toEqual([0, 0, 0, 1, 1, 1]);
      expect(ep.roles).toEqual([...DEFAULT_ROLES, ...DEFAULT_ROLES]);
      const o = ep.run();
      const r = ep.result();
      ep.free();
      return { r, t: o.time };
    };
    const a = run();
    expect(a.t).toBeGreaterThanOrEqual(SOCCER.timeLimit);
    expect(a.r.goals.length).toBe(a.r.score[0] + a.r.score[1]);
    expect(run()).toEqual(a);
  }, 120_000);

  it('ボールが相手のゴールに入ると得点になり、ボールは上空から落ちてくる', () => {
    const ep = new SoccerEpisode(R, players([null, null, null]), players([null, null, null]), 1);
    // +z 側のゴールの中にボールを置く → チームA(0)の得点
    ep.ball.setTranslation({ x: 0, y: SOCCER.ballRadius, z: SOCCER.halfLength + SOCCER.wallThickness + SOCCER.goalDepth / 2 }, true);
    for (let i = 0; i < 6; i++) ep.advance();
    expect(ep.result().score).toEqual([1, 0]);
    const p = ep.ball.translation();
    expect(Math.abs(p.z)).toBeLessThan(1);
    expect(p.y).toBeGreaterThan(SOCCER.ballDropHeight - 0.5);
    ep.free();
  });

  it('ボールは少し低重力で、速さに上限がある', () => {
    const ep = new SoccerEpisode(R, players([null, null, null]), players([null, null, null]), 1);
    // 上空から落ちる速さ:重力の半分
    ep.ball.setTranslation({ x: 0, y: 6, z: 0 }, true);
    ep.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    for (let i = 0; i < 30; i++) ep.advance();
    const vy = ep.ball.linvel().y;
    const expected = -9.81 * SOCCER.ballGravityScale * 0.5;
    expect(vy).toBeLessThan(expected * 0.8);
    expect(vy).toBeGreaterThan(expected * 1.2);
    // とても速く打ち出しても、上限の速さを超えない
    ep.ball.setTranslation({ x: 0, y: 2, z: 0 }, true);
    ep.ball.setLinvel({ x: 30, y: 0, z: 30 }, true);
    ep.advance();
    const v = ep.ball.linvel();
    expect(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)).toBeLessThanOrEqual(SOCCER.ballMaxSpeed + 1e-3);
    ep.free();
  });
});

describe('サッカーのトレーニング・かけっこのトレーニング・ジャンプ', () => {
  const body = () => ({ blueprint: QUADRUPED, motor: createMotorGenome(4, new Rng(3)) });

  it('役割ごとの練習は、同じシードなら同じ結果になる', () => {
    for (const role of ['shooter', 'carrier', 'blocker'] as const) {
      const run = () => {
        const ep = new SoccerDrillEpisode(R, role, body(), createSoccerGenome(new Rng(5)), 9);
        const o = ep.run();
        ep.free();
        return o;
      };
      expect(run()).toEqual(run());
    }
  }, 120_000);

  it('最初のサッカー脳は、お手本の向きにそのまま進もうとする', () => {
    const brain = new SoccerBrain(createSoccerGenome(new Rng(1)));
    const world = new R.World({ x: 0, y: -9.81, z: 0 });
    const f = new Fighter(R, world, QUADRUPED, createMotorGenome(4, new Rng(1)), { position: { x: 0, y: 1, z: 0 }, yaw: 0 });
    const cmd = brain.think({
      self: f,
      ball: { x: 0, y: 0.5, z: 3 },
      ballVel: { x: 0, y: 0, z: 0 },
      enemyGoalZ: 15,
      ownGoalZ: -15,
      opponent: null,
      timeRatio: 0,
      rule: { dirX: 1, dirZ: 0, speed: 1 },
    });
    // お手本は +x 方向。出す向きもおおむね +x
    expect(cmd.dirX).toBeGreaterThan(Math.abs(cmd.dirZ));
    expect(cmd.speed).toBeGreaterThan(0.6);
    world.free();
  });

  it('かけっこのトレーニングは、走った距離が報酬になる', () => {
    const ep = new SprintEpisode(R, QUADRUPED, createMotorGenome(4, new Rng(2)), 1);
    const o = ep.run();
    ep.free();
    expect(Number.isFinite(o.reward)).toBe(true);
  }, 60_000);

  it('ジャンプは決まった回数だけ跳び、最高記録で順位が決まる。同じシードなら一致する', () => {
    const run = () => {
      const ep = new HighJumpEpisode(R, [runner(1), runner(2)], 3);
      ep.run();
      const r = ep.result();
      ep.free();
      return r;
    };
    const a = run();
    expect(a.heights[0].length).toBe(HIGH_JUMP.attempts);
    expect(a.best[0]).toBe(Math.max(...a.heights[0]));
    expect(run()).toEqual(a);
  }, 60_000);
});
