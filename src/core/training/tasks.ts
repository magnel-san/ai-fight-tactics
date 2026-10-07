// トレーニングメニューの一覧と評価(仕様書セクション9)。
// 各メニューは、どちらの脳を鍛えるか・エピソードの作り方・合格判定を持つ。
import type { Blueprint } from '../creature/blueprint';
import { AVOID_TASK, CHASE_TASK, HOLES_TASK, JUMP_TASK, MOVE_TASK, PUSH_TASK, SURVIVE_TASK, type TrainStyle } from '../config';
import type { Rapier } from '../physics/rapier';
import { MatchEpisode } from '../sim/match';
import { ChaseEpisode } from './chase';
import type { Episode, EpisodeFlags, EpisodeOutcome } from './episode';
import { HolesEpisode } from './holes';
import { JumpEpisode } from './jump';
import { MoveEpisode, type Sector } from './move';

export type TaskName = 'move' | 'chase' | 'jump' | 'holes' | 'avoid' | 'survive' | 'push' | 'rival';
export type BrainKind = 'motor' | 'decision';

/** 試合・課題に出るキャラ1体分のデータ */
export interface FighterData {
  blueprint: Blueprint;
  motor: Float64Array;
  decision: Float64Array | null;
  /** 判断を脳でするか、ルールベースの突進BOTか */
  controller: 'brain' | 'rush';
}

/** トレーニングの条件(鍛えている脳以外は凍結して、ここから使う) */
export interface TaskSetup {
  blueprint: Blueprint;
  motor: Float64Array | null;
  decision: Float64Array | null;
  /** 生き残りのレベル(1〜5) */
  level: number;
  /** 押し合いの相手 */
  opponent: FighterData | null;
  /**
   * 押し合いの相手の一覧(押し合いのみ):[突進BOT, 標準BOT, 過去の自分]。
   * 学習ではエピソードごとに順番に替え、合格の確認では前半を突進BOT、後半を標準BOTと戦う
   */
  opponents?: FighterData[];
  /** 作戦タイプ(押し合い・ライバル練習試合の報酬の重み) */
  style?: TrainStyle;
}

export interface TaskDef {
  name: TaskName;
  label: string;
  brain: BrainKind;
  /** メニューの説明と合格条件(画面に出す) */
  note: string;
  passCondition: string;
  /** 評価エピソードを作る。genome は鍛えている脳の遺伝子 */
  createEpisode(
    R: Rapier,
    setup: TaskSetup,
    genome: Float64Array,
    seed: number,
    sector: Sector,
    mode: 'train' | 'confirm',
  ): Episode & { run(): EpisodeOutcome };
  /** 合格の確認に使うエピソード数 */
  confirmEpisodes: number;
  passed(outcomes: readonly EpisodeOutcome[]): boolean;
  /** 合格の確認結果の説明 */
  describe(outcomes: readonly EpisodeOutcome[]): string;
}

const successCount = (o: readonly EpisodeOutcome[]) => o.filter((x) => x.success).length;
/** 押し合いの合格の確認の勝ち数:[突進BOT(前半), 標準BOT(後半)] */
const pushWins = (o: readonly EpisodeOutcome[]): [number, number] => [
  successCount(o.slice(0, PUSH_TASK.confirmMatches)),
  successCount(o.slice(PUSH_TASK.confirmMatches)),
];
const metricMean = (o: readonly EpisodeOutcome[]) => (o.length ? o.reduce((s, x) => s + x.metric, 0) / o.length : 0);

export function needMotor(setup: TaskSetup): Float64Array {
  if (!setup.motor) throw new Error('運動脳がありません');
  return setup.motor;
}

export const TASKS: Record<TaskName, TaskDef> = {
  move: {
    name: 'move',
    label: '目標地点への移動',
    brain: 'motor',
    note: `運動脳を鍛える。${MOVE_TASK.targetDistMin}〜${MOVE_TASK.targetDistMax}m 先の目標へ向かう`,
    passCondition: `3回中${MOVE_TASK.passCount}回、${MOVE_TASK.timeLimit}秒以内に到達`,
    createEpisode: (R, setup, genome, seed, sector) => new MoveEpisode(R, setup.blueprint, genome, seed, sector),
    confirmEpisodes: MOVE_TASK.confirmEpisodes,
    passed: (o) => successCount(o) >= MOVE_TASK.confirmPassCount,
    describe: (o) => `${successCount(o)} / ${o.length} 回到達(${MOVE_TASK.confirmPassCount}回で合格)`,
  },
  chase: {
    name: 'chase',
    label: '対象を追う',
    brain: 'motor',
    note: '運動脳を鍛える。逃げる目標を追いかける',
    passCondition: `指令方向と移動方向の一致度の平均 ${CHASE_TASK.passAlignment} 以上`,
    createEpisode: (R, setup, genome, seed, sector) => new ChaseEpisode(R, setup.blueprint, genome, seed, sector),
    confirmEpisodes: 9,
    passed: (o) => metricMean(o) >= CHASE_TASK.passAlignment,
    describe: (o) => `一致度の平均 ${metricMean(o).toFixed(2)}(${CHASE_TASK.passAlignment} で合格)`,
  },
  holes: {
    name: 'holes',
    label: '穴をまたぐ',
    brain: 'motor',
    note: '運動脳を鍛える(任意)。1マス幅の穴の列を越えて進む',
    passCondition: `穴の列を${HOLES_TASK.passRows}つ越える`,
    // 歩き方を忘れないよう、学習中は評価エピソードの最後の1つを平地での移動にする
    createEpisode: (R, setup, genome, seed, sector, mode) =>
      mode === 'train' && sector.index === sector.count - 1
        ? new MoveEpisode(R, setup.blueprint, genome, seed, { index: 0, count: 1 })
        : new HolesEpisode(R, setup.blueprint, genome, seed),
    confirmEpisodes: 9,
    passed: (o) => successCount(o) >= 6,
    describe: (o) => `${successCount(o)} / ${o.length} 回、${HOLES_TASK.passRows}列以上を越えた(6回で合格)`,
  },
  jump: {
    name: 'jump',
    label: 'ジャンプ',
    brain: 'motor',
    note: '運動脳を鍛える(任意)。ジャンプ指令が出たら跳ぶ。関節だけでもピストンでも跳べる',
    passCondition: `コアの上がる高さの平均 ${JUMP_TASK.passHeight}m 以上`,
    createEpisode: (R, setup, genome, seed) => new JumpEpisode(R, setup.blueprint, genome, seed),
    confirmEpisodes: 9,
    passed: (o) => metricMean(o) >= JUMP_TASK.passHeight,
    describe: (o) => `平均 ${metricMean(o).toFixed(2)}m(${JUMP_TASK.passHeight}m で合格)`,
  },
  avoid: {
    name: 'avoid',
    label: '危険なタイルを避ける',
    brain: 'decision',
    note: '判断脳を鍛える。床は崩れないが、赤いタイル(崩れる予定・崩れたはずのタイル)を踏むと減点',
    passCondition: `${AVOID_TASK.confirmEpisodes}回中${AVOID_TASK.confirmPassCount}回、${AVOID_TASK.timeLimit}秒のあいだ崩れたはずのタイルに触れた時間 ${AVOID_TASK.passForbiddenTime}秒未満`,
    createEpisode: (R, setup, genome, seed) =>
      new MatchEpisode(R, {
        mode: 'avoid',
        seed,
        fighters: [{ blueprint: setup.blueprint, motor: needMotor(setup), decision: genome, controller: 'brain' }],
      }),
    confirmEpisodes: AVOID_TASK.confirmEpisodes,
    passed: (o) => successCount(o) >= AVOID_TASK.confirmPassCount,
    describe: (o) => `${successCount(o)} / ${o.length} 回、ほぼ踏まずに${AVOID_TASK.timeLimit}秒(${AVOID_TASK.confirmPassCount}回で合格)`,
  },
  survive: {
    name: 'survive',
    label: '崩落ステージを生き残る',
    brain: 'decision',
    note: '判断脳を鍛える。1体で崩落ステージを生き残る。レベル1〜5で崩落ペースが上がる',
    passCondition: `レベル${SURVIVE_TASK.passLevel}で${SURVIVE_TASK.confirmEpisodes}回中${SURVIVE_TASK.confirmPassCount}回、${SURVIVE_TASK.timeLimit}秒生存`,
    createEpisode: (R, setup, genome, seed) =>
      new MatchEpisode(R, {
        mode: 'survive',
        seed,
        pace: levelPace(setup.level),
        fighters: [{ blueprint: setup.blueprint, motor: needMotor(setup), decision: genome, controller: 'brain' }],
      }),
    confirmEpisodes: SURVIVE_TASK.confirmEpisodes,
    passed: (o) => successCount(o) >= SURVIVE_TASK.confirmPassCount,
    describe: (o) => `${successCount(o)} / ${o.length} 回、${SURVIVE_TASK.timeLimit}秒生存(${SURVIVE_TASK.confirmPassCount}回で合格)`,
  },
  push: {
    name: 'push',
    label: 'BOTとの押し合い',
    brain: 'decision',
    note: '判断脳を鍛える。突進BOT・標準BOT・過去の自分と順番に対戦する。作戦タイプで、押し出し重視か生き残り重視かを選べる',
    passCondition: `突進BOTと標準BOTに、それぞれ勝率${(PUSH_TASK.confirmWins / PUSH_TASK.confirmMatches) * 100}%以上(${PUSH_TASK.confirmMatches}戦${PUSH_TASK.confirmWins}勝)`,
    createEpisode: (R, setup, genome, seed, sector, mode) => {
      const self: FighterData = { blueprint: setup.blueprint, motor: needMotor(setup), decision: genome, controller: 'brain' };
      const opps = setup.opponents?.length ? setup.opponents : setup.opponent ? [setup.opponent] : [];
      // 押すことに夢中で自分が落ちるキャラにならないよう、学習中は評価エピソードの最後の1つを単独の生き残りにする
      if ((mode === 'train' && sector.index === sector.count - 1) || opps.length === 0) {
        return new MatchEpisode(R, { mode: 'survive', seed, fighters: [self] });
      }
      // 合格の確認:前半は突進BOT、後半は標準BOT。学習:相手を順番に替える
      const opponent =
        mode === 'confirm'
          ? opps[Math.min(opps.length - 1, Math.min(1, Math.floor(sector.index / PUSH_TASK.confirmMatches)))]
          : opps[sector.index % opps.length];
      return new MatchEpisode(R, { mode: 'push', seed, fighters: [self, opponent], style: setup.style });
    },
    confirmEpisodes: PUSH_TASK.confirmMatches * 2,
    passed: (o) => pushWins(o)[0] >= PUSH_TASK.confirmWins && pushWins(o)[1] >= PUSH_TASK.confirmWins,
    describe: (o) => {
      const [rush, std] = pushWins(o);
      return `突進BOTに${PUSH_TASK.confirmMatches}戦${rush}勝・標準BOTに${PUSH_TASK.confirmMatches}戦${std}勝(それぞれ${PUSH_TASK.confirmWins}勝で合格)`;
    },
  },
  rival: {
    name: 'rival',
    label: 'ライバル練習試合',
    brain: 'decision',
    note: '判断脳を鍛える(練習用・合格なし)。受け取ったキャラや過去の自分など、対戦相手プールのキャラと押し合う',
    passCondition: 'なし(何度でも練習できる)',
    createEpisode: (R, setup, genome, seed, sector, mode) => {
      const self: FighterData = { blueprint: setup.blueprint, motor: needMotor(setup), decision: genome, controller: 'brain' };
      if ((mode === 'train' && sector.index === sector.count - 1) || !setup.opponent) {
        return new MatchEpisode(R, { mode: 'survive', seed, fighters: [self] });
      }
      return new MatchEpisode(R, { mode: 'push', seed, fighters: [self, setup.opponent], style: setup.style });
    },
    confirmEpisodes: PUSH_TASK.confirmMatches,
    passed: () => false,
    describe: (o) => `${o.length}戦${successCount(o)}勝`,
  },
};

export interface EvalResult {
  fitness: number;
  successCount: number;
  metricMean: number;
  /** どれかのエピソードで起きたこと(マイルストーン用) */
  flags: EpisodeFlags;
  /** エピソードごとに起きたこと(マイルストーンの場面を再生するのに使う) */
  episodeFlags: EpisodeFlags[];
}

/** 1個体を複数のシードで評価する。i 番目のエピソードの方向は全周を seeds.length 等分した i 番目 */
export function evaluate(R: Rapier, task: TaskDef, setup: TaskSetup, genome: Float64Array, seeds: readonly number[]): EvalResult {
  const outs = runEpisodes(R, task, setup, genome, seeds, 'train');
  const flags: EpisodeFlags = { stood: false, reached: false, crossed: false, survived60: false, won: false, jumped: false };
  for (const o of outs) for (const k of Object.keys(flags) as (keyof EpisodeFlags)[]) flags[k] ||= o.flags[k];
  return {
    fitness: outs.reduce((s, o) => s + o.reward, 0) / outs.length,
    successCount: successCount(outs),
    metricMean: metricMean(outs),
    flags,
    episodeFlags: outs.map((o) => o.flags),
  };
}

export function runEpisodes(
  R: Rapier,
  task: TaskDef,
  setup: TaskSetup,
  genome: Float64Array,
  seeds: readonly number[],
  mode: 'train' | 'confirm',
): EpisodeOutcome[] {
  return seeds.map((seed, i) => {
    const ep = task.createEpisode(R, setup, genome, seed, { index: i, count: seeds.length }, mode);
    const o = ep.run();
    ep.free();
    return o;
  });
}

/** レベル(1〜5)の崩落ペース */
export function levelPace(level: number): number {
  const paces = SURVIVE_TASK.levelPace;
  return paces[Math.min(paces.length, Math.max(1, level)) - 1];
}

/**
 * メニューの解放順(仕様書セクション9)。運動脳:移動 → 追跡 →(ジャンプ・穴をまたぐ は任意)、
 * 判断脳:危険なタイルを避ける → 生き残り → BOTとの押し合い → ライバル練習試合
 */
export const TASK_ORDER: readonly TaskName[] = ['move', 'chase', 'jump', 'holes', 'avoid', 'survive', 'push', 'rival'];

/** 任意のメニュー(合格しなくても先に進める) */
export const OPTIONAL_TASKS: readonly TaskName[] = ['jump', 'holes', 'rival'];

export function isUnlocked(task: TaskName, passed: readonly TaskName[]): boolean {
  // 一度合格したメニューは、あとから前提のメニューが増えても開いたままにする
  if (passed.includes(task)) return true;
  switch (task) {
    case 'move':
      return true;
    case 'chase':
      return passed.includes('move');
    case 'jump':
    case 'holes':
    case 'avoid':
      return passed.includes('chase');
    case 'survive':
      return passed.includes('avoid');
    case 'push':
      return passed.includes('survive');
    case 'rival':
      return passed.includes('push');
  }
}
