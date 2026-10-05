import { beforeAll, describe, expect, it } from 'vitest';
import { F16_MAX, fromF16Bits, roundF16, toF16Bits } from '../src/core/brain/f16';
import { mlpForward, mlpInit, mlpParamCount } from '../src/core/brain/mlp';
import { createMotorGenome, motorGenomeLength, motorShape, rhythmPeriod } from '../src/core/brain/motor';
import { BRAIN } from '../src/core/config';
import { QUADRUPED } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { initRapier, type Rapier } from '../src/core/physics/rapier';
import { GeneticAlgorithm } from '../src/core/training/ga';
import { MoveEpisode } from '../src/core/training/move';
import { TASKS, evaluate } from '../src/core/training/tasks';

describe('float16', () => {
  it('代表的な値のビット列', () => {
    expect(toF16Bits(0)).toBe(0x0000);
    expect(toF16Bits(1)).toBe(0x3c00);
    expect(toF16Bits(-2)).toBe(0xc000);
    expect(toF16Bits(0.5)).toBe(0x3800);
    expect(toF16Bits(65504)).toBe(0x7bff);
    expect(toF16Bits(2 ** -24)).toBe(0x0001); // 最小の非正規化数
  });

  it('範囲外は最大値に飽和する', () => {
    expect(roundF16(1e6)).toBe(F16_MAX);
    expect(roundF16(-1e6)).toBe(-F16_MAX);
  });

  it('丸めは最近接偶数で、丸めた値をもう一度丸めても変わらない', () => {
    // 1 と次の値 1+2^-10 のちょうど中間は偶数側(1)へ
    expect(roundF16(1 + 2 ** -11)).toBe(1);
    expect(roundF16(1 + 3 * 2 ** -11)).toBe(1 + 2 * 2 ** -10);
    const rng = new Rng(3);
    for (let i = 0; i < 10000; i++) {
      const x = rng.gaussian() * 3;
      const r = roundF16(x);
      expect(roundF16(r)).toBe(r);
      expect(Math.abs(r - x)).toBeLessThanOrEqual(Math.abs(x) * 2 ** -11 + 2 ** -25);
    }
  });

  it('全ビット列が往復で一致する', () => {
    for (let h = 0; h < 0x10000; h++) {
      const e = (h >>> 10) & 0x1f;
      if (e === 0x1f) continue; // 無限大・NaN は除く
      const back = toF16Bits(fromF16Bits(h));
      // -0 は +0 と同じ値として扱う
      expect(back === h || (h === 0x8000 && back === 0x8000) || (h === 0x8000 && back === 0)).toBe(true);
    }
  });
});

describe('MLP', () => {
  const shape = { inputs: 5, hidden: 4, outputs: 2 };

  it('パラメータ数', () => {
    expect(mlpParamCount(shape)).toBe(4 * 5 + 4 + 2 * 4 + 2);
  });

  it('重みが0なら出力は0、出力は -1〜1 に収まる', () => {
    const params = new Float64Array(mlpParamCount(shape));
    const out = new Float64Array(2);
    mlpForward(shape, params, 0, [1, 2, 3, 4, 5], new Float64Array(4), out);
    expect([...out]).toEqual([0, 0]);

    mlpInit(shape, new Rng(1), params, 0);
    for (let i = 0; i < params.length; i++) params[i] *= 100;
    mlpForward(shape, params, 0, [1, -2, 3, -4, 5], new Float64Array(4), out);
    for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(1);
  });

  it('手計算と一致する', () => {
    const s = { inputs: 1, hidden: 1, outputs: 1 };
    // W1=2, b1=0.5, W2=-1, b2=0.25 → tanh(-tanh(2x+0.5)+0.25)
    const params = Float64Array.from([2, 0.5, -1, 0.25]);
    const out = new Float64Array(1);
    mlpForward(s, params, 0, [0.3], new Float64Array(1), out);
    expect(out[0]).toBeCloseTo(Math.tanh(-Math.tanh(2 * 0.3 + 0.5) + 0.25), 12);
  });
});

describe('運動脳', () => {
  it('入出力の数は 17 + 2×関節数 と 関節数', () => {
    expect(motorShape(4)).toEqual({ inputs: 25, hidden: BRAIN.motorHidden, outputs: 4 });
    expect(motorGenomeLength(4)).toBe(mlpParamCount(motorShape(4)) + 1);
  });

  it('初期の遺伝子は float16 の精度で、リズム周期は初期値', () => {
    const g = createMotorGenome(4, new Rng(5));
    for (const v of g) expect(roundF16(v)).toBe(v);
    expect(rhythmPeriod(g)).toBeCloseTo(BRAIN.rhythmPeriodInit, 2);
  });

  it('リズム周期は範囲内に収まる', () => {
    const g = createMotorGenome(1, new Rng(5));
    g[g.length - 1] = 100;
    expect(rhythmPeriod(g)).toBeCloseTo(BRAIN.rhythmPeriodMax, 9);
    g[g.length - 1] = -100;
    expect(rhythmPeriod(g)).toBeCloseTo(BRAIN.rhythmPeriodMin, 9);
  });
});

describe('遺伝的アルゴリズム', () => {
  const seedGenome = Float64Array.from({ length: 10 }, (_, i) => i / 10);
  const opts = {
    population: 8,
    elites: 2,
    tournamentSize: 3,
    sigmaInit: 0.05,
    sigmaMin: 0.005,
    sigmaMax: 0.2,
    sigmaDecay: 0.7,
    sigmaGrow: 1.1,
    stagnationGenerations: 3,
  };

  it('初回の集団は元の遺伝子そのものと、ノイズを加えたもの', () => {
    const ga = new GeneticAlgorithm(seedGenome, 1, opts);
    expect(ga.population.length).toBe(8);
    expect([...ga.population[0]]).toEqual([...seedGenome].map(roundF16));
    expect([...ga.population[1]]).not.toEqual([...seedGenome]);
    for (const g of ga.population) for (const v of g) expect(roundF16(v)).toBe(v);
  });

  it('上位の個体はそのまま次の世代に残る(エリート保存)', () => {
    const ga = new GeneticAlgorithm(seedGenome, 1, opts);
    const p = ga.population.map((g) => Float64Array.from(g));
    const stats = ga.tell([0, 5, 1, 9, 2, 3, 4, 0]);
    expect(stats.best).toBe(9);
    expect(stats.bestIndex).toBe(3);
    expect([...ga.population[0]]).toEqual([...p[3]]);
    expect([...ga.population[1]]).toEqual([...p[1]]);
  });

  it('同じシード・同じ適応度なら同じ集団になる', () => {
    const run = () => {
      const ga = new GeneticAlgorithm(seedGenome, 42, opts);
      for (let i = 0; i < 5; i++) ga.tell(ga.population.map((g) => g[0] + g[1]));
      return ga.population.map((g) => [...g]);
    };
    expect(run()).toEqual(run());
  });

  it('改善が続くとσが広がり、止まると狭まる', () => {
    const ga = new GeneticAlgorithm(seedGenome, 1, opts);
    ga.tell([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(ga.sigma).toBeCloseTo(0.055, 9);
    for (let i = 0; i < 3; i++) ga.tell([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ga.sigma).toBeCloseTo(0.055 * 0.7, 9);
  });

  it('適応度が上がる方向に進化する(簡単な最適化問題)', () => {
    // 遺伝子の各要素を 0.5 に近づける問題
    const ga = new GeneticAlgorithm(new Float64Array(10), 7, { ...opts, population: 32, elites: 4 });
    const score = (g: Float64Array) => -g.reduce((s, v) => s + (v - 0.5) ** 2, 0);
    const first = Math.max(...ga.population.map(score));
    let last = first;
    for (let i = 0; i < 60; i++) last = ga.tell(ga.population.map(score)).best;
    expect(last).toBeGreaterThan(first + 1);
  });
});

describe('トレーニング「目標地点への移動」', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await initRapier();
  });

  it('同じ遺伝子・同じシードなら結果が完全に一致する', () => {
    const g = createMotorGenome(4, new Rng(11));
    const setup = { blueprint: QUADRUPED, motor: null, decision: null, level: 3, opponent: null };
    const a = evaluate(R, TASKS.move, setup, g, [1, 2, 3]);
    const b = evaluate(R, TASKS.move, setup, g, [1, 2, 3]);
    expect(a).toEqual(b);
    expect(a).toMatchSnapshot();
  });

  it('目標は指定した方向の範囲に、4〜6m 先に置かれる', () => {
    const g = createMotorGenome(4, new Rng(11));
    for (let i = 0; i < 3; i++) {
      const ep = new MoveEpisode(R, QUADRUPED, g, 100 + i, { index: i, count: 3 });
      const d = Math.hypot(ep.target!.x, ep.target!.z);
      expect(d).toBeGreaterThanOrEqual(4);
      expect(d).toBeLessThanOrEqual(6);
      ep.free();
    }
  });

  it('制限時間で終わる', () => {
    const g = new Float64Array(motorGenomeLength(4)); // 関節を動かさない脳
    const ep = new MoveEpisode(R, QUADRUPED, g, 1);
    const r = ep.run();
    ep.free();
    expect(r.success).toBe(false);
    expect(r.time).toBeGreaterThanOrEqual(15);
    expect(r.time).toBeLessThan(15.2);
  });
});
