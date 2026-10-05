// トレーニングの進行役(メインスレッド)。遺伝的アルゴリズムで世代を進め、評価は WorkerPool に任せる。
// メニューごとの段階(生き残りのレベル、押し合いの相手)もここで進める。
import { CHASE_TASK, SURVIVE_TASK, TRAINING } from '../core/config';
import { Rng } from '../core/math/rng';
import type { EpisodeFlags } from '../core/training/episode';
import type { Sector } from '../core/training/move';
import { DEFAULT_GA_OPTIONS, GeneticAlgorithm, type GenerationStats } from '../core/training/ga';
import { TASKS, type EvalResult, type FighterData, type TaskName, type TaskSetup } from '../core/training/tasks';
import { WorkerPool, type EvalPool } from './WorkerPool';

/** 観戦で重ねて表示する上位個体の数 */
export const GHOST_COUNT = 16;

export interface GenerationReport extends GenerationStats {
  task: TaskName;
  /** 最優秀個体の評価結果 */
  bestResult: EvalResult;
  /** この世代の評価に使ったシード(観戦で同じエピソードを再現するのに使う) */
  seeds: number[];
  /** この世代の評価に使った条件(レベル・相手) */
  setup: TaskSetup;
  /** この世代の最優秀個体の遺伝子 */
  champion: Float64Array;
  /** 上位個体の遺伝子(成績順、ゴースト表示用) */
  top: Float64Array[];
  /** この世代の集団のどれかで起きたこと(マイルストーン用) */
  flags: EpisodeFlags;
  /** 起きたことごとに、その場面を再生するためのデータ(成績の良い個体を優先) */
  moments: Partial<Record<keyof EpisodeFlags, Moment>>;
  /** 合格の確認をしたときの結果(しなかったら null) */
  confirm: { passed: boolean; text: string } | null;
  /** 段階の説明(「レベル3」「突進BOT」など) */
  stageLabel: string;
  /** メニューに合格したか */
  passed: boolean;
  /** 1世代にかかった時間 [s] */
  seconds: number;
}

/** マイルストーンの場面:この遺伝子で、このシード・方向のエピソードを再生すると起きる */
export interface Moment {
  genome: Float64Array;
  seed: number;
  sector: Sector;
}

export interface Opponent {
  label: string;
  data: FighterData;
  /** この相手に勝てたらメニュー合格(標準BOT)。省略時は最後の相手 */
  passTarget?: boolean;
}

export class Trainer {
  private ga: GeneticAlgorithm;
  private rng: Rng;
  private pool: EvalPool | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private setup: TaskSetup;
  /** 押し合いの相手の段階(opponents の番号) */
  private opponentIndex = 0;
  private passed: boolean;

  constructor(
    private task: TaskName,
    setup: TaskSetup,
    initialGenome: Float64Array,
    seed: number,
    private onGeneration: (r: GenerationReport) => void,
    private onError: (e: Error) => void = console.error,
    /** 押し合いの相手(弱い順) */
    private opponents: Opponent[] = [],
    alreadyPassed = false,
    /** 評価に使うプール(省略時はブラウザの WorkerPool を作る) */
    private poolFactory: () => EvalPool = () => new WorkerPool(),
    /** 個体数(32〜128) */
    population: number = TRAINING.population,
  ) {
    this.rng = new Rng(seed);
    const size = Math.min(TRAINING.populationMax, Math.max(TRAINING.populationMin, population));
    this.ga = new GeneticAlgorithm(initialGenome, this.rng.nextU32(), { ...DEFAULT_GA_OPTIONS, population: size });
    this.setup = { ...setup };
    this.passed = alreadyPassed;
    if (task === 'push') {
      if (opponents.length === 0) throw new Error('押し合いの相手がいません');
      this.setup.opponent = opponents[0].data;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pool ??= this.poolFactory();
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

  private stageLabel(): string {
    if (this.task === 'survive') return `レベル${this.setup.level}`;
    if (this.task === 'push') return `相手:${this.opponents[this.opponentIndex].label}`;
    return '';
  }

  /** 合格の確認をするか(最優秀個体が評価エピソードで合格条件を満たしたとき) */
  private shouldConfirm(best: EvalResult): boolean {
    if (this.task === 'chase') return best.metricMean >= CHASE_TASK.passAlignment;
    return best.successCount >= 2;
  }

  /** 確認に通ったときに段階を進める。メニューに合格したら true */
  private advanceStage(): boolean {
    if (this.task === 'survive') {
      const level = this.setup.level;
      if (level < SURVIVE_TASK.levelPace.length) this.setup.level = level + 1;
      return level >= SURVIVE_TASK.passLevel;
    }
    if (this.task === 'push') {
      const last = this.opponentIndex === this.opponents.length - 1;
      const target = this.opponents[this.opponentIndex].passTarget ?? last;
      if (!last) {
        this.opponentIndex++;
        this.setup.opponent = this.opponents[this.opponentIndex].data;
      }
      return target || this.passed;
    }
    return true;
  }

  private async run(): Promise<void> {
    const task = TASKS[this.task];
    while (this.running && this.pool) {
      const t0 = performance.now();
      const seeds = Array.from({ length: TRAINING.episodesPerGeneration }, () => this.rng.nextU32());
      const setup = { ...this.setup };
      const stageLabel = this.stageLabel();
      const population = this.ga.population.map((g) => Float64Array.from(g));
      try {
        const results = await this.pool.evaluate(this.task, setup, population, seeds);
        if (!this.running) return;
        const order = [...results.keys()].sort((a, b) => results[b].fitness - results[a].fitness || a - b);
        const stats = this.ga.tell(results.map((r) => r.fitness));
        const best = results[stats.bestIndex];
        const champion = population[stats.bestIndex];
        const flags = { ...best.flags };
        for (const r of results) for (const k of Object.keys(flags) as (keyof EpisodeFlags)[]) flags[k] ||= r.flags[k];
        const moments: GenerationReport['moments'] = {};
        for (const k of Object.keys(flags) as (keyof EpisodeFlags)[]) {
          if (!flags[k]) continue;
          for (const i of order) {
            const e = results[i].episodeFlags.findIndex((f) => f[k]);
            if (e >= 0) {
              moments[k] = { genome: population[i], seed: seeds[e], sector: { index: e, count: seeds.length } };
              break;
            }
          }
        }

        let confirm: GenerationReport['confirm'] = null;
        if (this.shouldConfirm(best)) {
          const confirmSeeds = Array.from({ length: task.confirmEpisodes }, () => this.rng.nextU32());
          const outcomes = await this.pool.confirm(this.task, setup, champion, confirmSeeds);
          const ok = task.passed(outcomes);
          confirm = { passed: ok, text: task.describe(outcomes) };
          if (ok && this.advanceStage()) this.passed = true;
        }

        this.onGeneration({
          ...stats,
          task: this.task,
          bestResult: best,
          seeds,
          setup,
          champion,
          top: order.slice(0, GHOST_COUNT).map((i) => population[i]),
          flags,
          moments,
          confirm,
          stageLabel,
          passed: this.passed,
          seconds: (performance.now() - t0) / 1000,
        });
      } catch (e) {
        this.running = false;
        this.onError(e as Error);
        return;
      }
    }
  }
}
