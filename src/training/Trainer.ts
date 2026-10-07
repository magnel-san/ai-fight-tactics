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
  /** 押し合いの「過去の自分」(自己対戦の相手) */
  private selfSnapshot: Float64Array | null = null;
  /** 直前の世代の最優秀個体 */
  private lastChampion: Float64Array | null = null;

  /** 押し合いの相手の一覧を作り直す:[突進BOT, 標準BOT, 過去の自分] */
  private updateOpponents(): void {
    const bots = this.opponents.slice(0, 2).map((o) => o.data);
    const self: FighterData[] =
      this.selfSnapshot && this.setup.motor
        ? [{ blueprint: this.setup.blueprint, motor: this.setup.motor, decision: this.selfSnapshot, controller: 'brain' }]
        : [];
    this.setup.opponents = [...bots, ...self];
  }

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
    if (task === 'push' || task === 'rival') {
      if (opponents.length === 0) throw new Error(task === 'push' ? '押し合いの相手がいません' : '対戦相手プールにキャラを登録してください');
      this.setup.opponent = opponents[0].data;
    }
    if (task === 'push') {
      // 押し合い:突進BOT・標準BOTに、過去の自分(最初は今の判断脳)を加えて、順番に戦う
      this.selfSnapshot = Float64Array.from(initialGenome);
      this.updateOpponents();
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
    if (this.task === 'push')
      return `相手:${this.opponents
        .slice(0, 2)
        .map((o) => o.label)
        .join('・')}・過去の自分`;
    if (this.task === 'rival') return `相手:${this.opponents[this.opponentIndex].label}`;
    return '';
  }

  /** 合格の確認をするか(最優秀個体が評価エピソードで合格条件を満たしたとき) */
  private shouldConfirm(best: EvalResult): boolean {
    if (this.task === 'rival') return false; // 練習用なので合格の確認はしない
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
    // 押し合い:突進BOTと標準BOTのどちらにも勝てたら合格(確認で両方と戦っている)
    if (this.task === 'push') return true;
    return true;
  }

  private async run(): Promise<void> {
    const task = TASKS[this.task];
    while (this.running && this.pool) {
      const t0 = performance.now();
      // ライバル練習試合は、世代ごとに対戦相手プールの相手を順番に替える
      if (this.task === 'rival') {
        this.opponentIndex = this.ga.generation % this.opponents.length;
        this.setup.opponent = this.opponents[this.opponentIndex].data;
      }
      // 自己対戦:一定の世代ごとに、いまの最優秀を「過去の自分」として相手に入れる
      if (this.task === 'push' && this.ga.generation > 0 && this.ga.generation % TRAINING.selfPlayInterval === 0 && this.lastChampion) {
        this.selfSnapshot = Float64Array.from(this.lastChampion);
        this.updateOpponents();
      }
      const decisionTask = task.brain === 'decision';
      const episodes = decisionTask ? TRAINING.decisionEpisodesPerGeneration : TRAINING.episodesPerGeneration;
      const seeds = Array.from({ length: episodes }, () => this.rng.nextU32());
      const setup = { ...this.setup };
      const stageLabel = this.stageLabel();
      const population = this.ga.population.map((g) => Float64Array.from(g));
      try {
        const results = await this.pool.evaluate(this.task, setup, population, seeds);
        if (!this.running) return;
        const fitness = results.map((r) => r.fitness);
        // 判断脳のメニュー:上位の個体だけ試合を追加して、合わせた平均で選び直す(運のよい個体が選ばれにくくする)
        if (decisionTask && TRAINING.reevalTop > 0) {
          const top = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a] || a - b).slice(0, TRAINING.reevalTop);
          const extraSeeds = Array.from({ length: TRAINING.reevalEpisodes }, () => this.rng.nextU32());
          const extra = await this.pool.evaluate(
            this.task,
            setup,
            top.map((i) => population[i]),
            extraSeeds,
          );
          if (!this.running) return;
          top.forEach((i, k) => {
            fitness[i] = (fitness[i] * seeds.length + extra[k].fitness * extraSeeds.length) / (seeds.length + extraSeeds.length);
          });
        }
        const order = [...fitness.keys()].sort((a, b) => fitness[b] - fitness[a] || a - b);
        const stats = this.ga.tell(fitness);
        const best = results[stats.bestIndex];
        const champion = population[stats.bestIndex];
        this.lastChampion = champion;
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
