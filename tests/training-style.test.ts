// 押し合いの合格条件(突進BOTと標準BOTの両方)と、作戦タイプの報酬のテスト
import { beforeAll, describe, expect, it } from 'vitest';
import { PUSH_TASK, STYLES } from '../src/core/config';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { MatchEpisode } from '../src/core/sim/match';
import type { EpisodeOutcome } from '../src/core/training/episode';
import { TASKS } from '../src/core/training/tasks';
import { rushBot, standardBot } from '../src/data/bots';

const outcome = (success: boolean): EpisodeOutcome => ({
  reward: 0,
  success,
  metric: 0,
  time: 0,
  flags: { stood: false, reached: false, crossed: false, survived60: false, won: success, jumped: false },
});

/** 前半(突進BOT)と後半(標準BOT)の勝ち数を指定した確認結果 */
const confirm = (rushWins: number, stdWins: number) => [
  ...Array.from({ length: PUSH_TASK.confirmMatches }, (_, i) => outcome(i < rushWins)),
  ...Array.from({ length: PUSH_TASK.confirmMatches }, (_, i) => outcome(i < stdWins)),
];

describe('押し合いの合格条件', () => {
  it('突進BOTと標準BOTの、どちらにも必要な勝ち数が要る', () => {
    expect(TASKS.push.confirmEpisodes).toBe(PUSH_TASK.confirmMatches * 2);
    expect(TASKS.push.passed(confirm(PUSH_TASK.confirmWins, PUSH_TASK.confirmWins))).toBe(true);
    // 標準BOTに全勝しても、突進BOTに勝てなければ不合格
    expect(TASKS.push.passed(confirm(PUSH_TASK.confirmWins - 1, PUSH_TASK.confirmMatches))).toBe(false);
    expect(TASKS.push.passed(confirm(PUSH_TASK.confirmMatches, PUSH_TASK.confirmWins - 1))).toBe(false);
  });
});

describe('作戦タイプ', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  const play = (style: keyof typeof STYLES) => {
    const m = new MatchEpisode(R, { mode: 'push', seed: 7, fighters: [standardBot()!, rushBot()!], timeLimit: 20, style });
    const o = m.run();
    m.free();
    return o;
  };

  it('同じ試合でも、作戦タイプで報酬の付け方が変わる(試合の動きは同じ)', () => {
    const a = play('balanced');
    const b = play('attack');
    const c = play('survive');
    // 報酬は判断に使われないので、試合の結果そのものは同じ
    expect(b.success).toBe(a.success);
    expect(c.success).toBe(a.success);
    expect(new Set([a.reward, b.reward, c.reward]).size).toBe(3);
  });

  it('守りは生き残りの加点が大きい', () => {
    expect(STYLES.survive.alive).toBeGreaterThan(STYLES.balanced.alive);
    expect(STYLES.attack.winPush).toBeGreaterThan(STYLES.balanced.winPush);
  });
});
