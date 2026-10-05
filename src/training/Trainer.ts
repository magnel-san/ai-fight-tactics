// トレーニングの進行役(メインスレッド)。遺伝的アルゴリズムで世代を進め、評価は WorkerPool に任せる。
// 世代が終わるたびに統計と最優秀個体を通知する。
import { MOVE_TASK, TRAINING } from '../core/config';
import type { Blueprint } from '../core/creature/blueprint';
import { Rng } from '../core/math/rng';
import { GeneticAlgorithm, type GenerationStats } from '../core/training/ga';
import type { TaskName } from '../workers/protocol';
import { WorkerPool } from './WorkerPool';

export interface GenerationReport extends GenerationStats {
  /** 最優秀個体が評価エピソードで目標に到達した回数 */
  bestReached: number;
  /** この世代の評価に使ったシード(観戦で同じ試合を再現するのに使う) */
  seeds: number[];
  /** この世代の最優秀個体の遺伝子 */
  champion: Float64Array;
  /** 合格の確認をしたときの結果(しなかったら null) */
  confirm: { reached: number; episodes: number } | null;
  /** 合格したか(確認エピソードでも合格条件の割合を満たした) */
  passed: boolean;
  /** 1世代にかかった時間 [s] */
  seconds: number;
}

export class Trainer {
  private ga: GeneticAlgorithm;
  private rng: Rng;
  private pool: WorkerPool | null = null;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private task: TaskName,
    private blueprint: Blueprint,
    initialGenome: Float64Array,
    seed: number,
    private onGeneration: (r: GenerationReport) => void,
    private onError: (e: Error) => void = console.error,
  ) {
    this.rng = new Rng(seed);
    this.ga = new GeneticAlgorithm(initialGenome, this.rng.nextU32());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get workerCount(): number {
    return this.pool?.size ?? 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pool ??= new WorkerPool();
    this.loop = this.run();
  }

  /** 実行中の世代が終わってから止まる */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  dispose(): void {
    this.running = false;
    this.pool?.terminate();
    this.pool = null;
  }

  private async run(): Promise<void> {
    while (this.running && this.pool) {
      const t0 = performance.now();
      const seeds = Array.from({ length: TRAINING.episodesPerGeneration }, () => this.rng.nextU32());
      const population = this.ga.population;
      let results;
      try {
        results = await this.pool.evaluate(this.task, this.blueprint, population, seeds);
      } catch (e) {
        this.running = false;
        this.onError(e as Error);
        return;
      }
      if (!this.running) return;
      const stats = this.ga.tell(results.map((r) => r.fitness));
      const best = results[stats.bestIndex];
      // tell() の後、エリート保存で最優秀個体は新しい集団の先頭に来ている
      const champion = Float64Array.from(this.ga.population[0]);

      let confirm: GenerationReport['confirm'] = null;
      if (best.reachedCount >= MOVE_TASK.passCount) {
        const confirmSeeds = Array.from({ length: MOVE_TASK.confirmEpisodes }, () => this.rng.nextU32());
        try {
          const [r] = await this.pool.evaluate(this.task, this.blueprint, [champion], confirmSeeds);
          confirm = { reached: r.reachedCount, episodes: MOVE_TASK.confirmEpisodes };
        } catch (e) {
          this.running = false;
          this.onError(e as Error);
          return;
        }
      }

      this.onGeneration({
        ...stats,
        bestReached: best.reachedCount,
        seeds,
        champion,
        confirm,
        passed: confirm !== null && confirm.reached >= MOVE_TASK.confirmPassCount,
        seconds: (performance.now() - t0) / 1000,
      });
    }
  }
}
