// 遺伝的アルゴリズム(ニューロエボリューション、仕様書セクション8)。
// 重みをそのまま遺伝子とし、エリート保存 + トーナメント選択 + ガウスノイズの突然変異で世代を進める。交叉はしない。
// 乱数はすべてシード付きなので、同じシード・同じ適応度なら同じ集団になる。
import { roundF16Array } from '../brain/f16';
import { TRAINING } from '../config';
import { Rng } from '../math/rng';

export interface GaOptions {
  population: number;
  elites: number;
  tournamentSize: number;
  sigmaInit: number;
  sigmaMin: number;
  sigmaMax: number;
  sigmaDecay: number;
  sigmaGrow: number;
  stagnationGenerations: number;
}

export const DEFAULT_GA_OPTIONS: GaOptions = {
  population: TRAINING.population,
  elites: TRAINING.elites,
  tournamentSize: TRAINING.tournamentSize,
  sigmaInit: TRAINING.sigmaInit,
  sigmaMin: TRAINING.sigmaMin,
  sigmaMax: TRAINING.sigmaMax,
  sigmaDecay: TRAINING.sigmaDecay,
  sigmaGrow: TRAINING.sigmaGrow,
  stagnationGenerations: TRAINING.stagnationGenerations,
};

export interface GenerationStats {
  generation: number;
  best: number;
  mean: number;
  /** この世代で最も成績の良かった個体の番号 */
  bestIndex: number;
  /** この世代の評価に使った σ */
  sigma: number;
}

/** 中断・再開用に保存できる状態 */
export interface GaState {
  generation: number;
  sigma: number;
  bestEver: number;
  stagnation: number;
  rngSeed: number;
  population: Float64Array[];
}

export class GeneticAlgorithm {
  private rng: Rng;
  private _population: Float64Array[];
  private _generation = 0;
  private _sigma: number;
  private bestEver = -Infinity;
  private stagnation = 0;

  constructor(
    seedGenome: Float64Array,
    seed: number,
    private opts: GaOptions = DEFAULT_GA_OPTIONS,
  ) {
    this.rng = new Rng(seed);
    this._sigma = opts.sigmaInit;
    // 初回:元の脳そのものと、それに小さなノイズを加えた個体で埋める
    this._population = [roundF16Array(Float64Array.from(seedGenome))];
    while (this._population.length < opts.population) this._population.push(this.mutate(seedGenome));
  }

  get population(): readonly Float64Array[] {
    return this._population;
  }

  get generation(): number {
    return this._generation;
  }

  get sigma(): number {
    return this._sigma;
  }

  /** 現在の集団の適応度を受け取り、次の世代を作る。この世代の統計を返す */
  tell(fitness: readonly number[]): GenerationStats {
    const n = this._population.length;
    if (fitness.length !== n) throw new Error(`適応度の数が集団の大きさと違います:${fitness.length}`);

    // 成績順(同点なら番号の小さい方が上)
    const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a] || a - b);
    const best = fitness[order[0]];
    const mean = fitness.reduce((s, f) => s + f, 0) / n;
    const stats: GenerationStats = {
      generation: this._generation,
      best,
      mean,
      bestIndex: order[0],
      sigma: this._sigma,
    };

    // σの調整:改善したら広げ、一定世代改善しなければ狭める
    if (best > this.bestEver) {
      this.bestEver = best;
      this.stagnation = 0;
      this._sigma = Math.min(this.opts.sigmaMax, this._sigma * this.opts.sigmaGrow);
    } else if (++this.stagnation >= this.opts.stagnationGenerations) {
      this.stagnation = 0;
      this._sigma = Math.max(this.opts.sigmaMin, this._sigma * this.opts.sigmaDecay);
    }

    const next: Float64Array[] = [];
    for (let i = 0; i < this.opts.elites && i < n; i++) next.push(Float64Array.from(this._population[order[i]]));
    while (next.length < n) next.push(this.mutate(this._population[this.tournament(fitness)]));

    this._population = next;
    this._generation++;
    return stats;
  }

  getState(): GaState {
    return {
      generation: this._generation,
      sigma: this._sigma,
      bestEver: this.bestEver,
      stagnation: this.stagnation,
      // 乱数の内部状態の代わりに、ここから先で使うシードを1つ引いて保存する
      rngSeed: this.rng.nextU32() | 0,
      population: this._population.map((g) => Float64Array.from(g)),
    };
  }

  static fromState(state: GaState, opts: GaOptions = DEFAULT_GA_OPTIONS): GeneticAlgorithm {
    const ga = new GeneticAlgorithm(state.population[0], state.rngSeed, { ...opts, population: 1 });
    ga.opts = opts;
    ga._population = state.population.map((g) => Float64Array.from(g));
    ga._generation = state.generation;
    ga._sigma = state.sigma;
    ga.bestEver = state.bestEver;
    ga.stagnation = state.stagnation;
    return ga;
  }

  private tournament(fitness: readonly number[]): number {
    let winner = this.rng.int(fitness.length);
    for (let i = 1; i < this.opts.tournamentSize; i++) {
      const c = this.rng.int(fitness.length);
      if (fitness[c] > fitness[winner] || (fitness[c] === fitness[winner] && c < winner)) winner = c;
    }
    return winner;
  }

  private mutate(parent: Float64Array): Float64Array {
    const child = new Float64Array(parent.length);
    for (let i = 0; i < parent.length; i++) child[i] = parent[i] + this.rng.gaussian() * this._sigma;
    return roundF16Array(child);
  }
}
