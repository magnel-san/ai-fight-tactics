// 画面なしでトレーニングするスクリプト(標準BOTを作るのにも使う)。
//   npx tsx scripts/train.ts --sample quadruped --task move --gens 200 --until-pass --out bot.json
//   npx tsx scripts/train.ts --char bot.json --task push --opponents rush,self --gens 300 --out bot.json
// オプション
//   --sample 名前 / --char ファイル   最初のキャラ(サンプルの体から作るか、保存したキャラを読むか)
//   --task move|chase|holes|survive|push
//   --gens N          最大世代数
//   --until-pass      合格したら止める
//   --opponents       押し合いの相手(弱い順。rush = 同じ体の突進BOT、self = 学習開始時の自分の判断脳、standard = 同梱の標準BOT)
//   --out ファイル     保存先(10世代ごとと、合格の確認に通ったときに保存する)
//   --seed N
//   --level N         生き残りを始めるレベル(省略時は保存されているレベル)
import { readFileSync, writeFileSync } from 'node:fs';
import { newCharacter, type Character } from '../src/core/character';
import { characterToJson, parseCharacter } from '../src/core/codec';
import { SAMPLES } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { TASKS, type TaskName } from '../src/core/training/tasks';
import { standardBot } from '../src/data/bots';
import { Trainer, type Opponent } from '../src/training/Trainer';
import { NodePool } from './headless/pool';
import { freshGenome, trainedGenome, withTrained } from '../src/core/training/brains';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const taskName = (arg('task') ?? 'move') as TaskName;
const task = TASKS[taskName];
if (!task) throw new Error(`メニューがありません:${taskName}`);
const maxGens = Number(arg('gens') ?? 100);
const seed = Number(arg('seed') ?? 1);
const out = arg('out');
const rng = new Rng(seed);

let character: Character;
if (arg('char')) character = parseCharacter(readFileSync(arg('char')!, 'utf8'));
else {
  const bp = SAMPLES[arg('sample') ?? 'quadruped'];
  if (!bp) throw new Error(`サンプルがありません:${arg('sample')}`);
  character = newCharacter(arg('name') ?? '標準BOT', bp);
}
if (arg('name')) character.name = arg('name')!;
if (arg('level')) character.progress.surviveLevel = Number(arg('level'));

const genome = trainedGenome(character, taskName) ?? freshGenome(character, taskName, rng.fork());
if (task.brain !== 'motor' && !character.motor) throw new Error('運動脳がありません');

const opponents: Opponent[] = (taskName === 'push' ? (arg('opponents') ?? 'rush,standard').split(',') : []).map((kind) => {
  if (kind === 'rush') return { label: '突進BOT', data: { blueprint: character.blueprint, motor: character.motor!, decision: null, controller: 'rush' as const } };
  if (kind === 'self')
    return { label: '学習開始時の自分', data: { blueprint: character.blueprint, motor: character.motor!, decision: Float64Array.from(character.decision ?? genome), controller: 'brain' as const } };
  const s = standardBot();
  if (!s) throw new Error('標準BOTがまだありません');
  return { label: '標準BOT', data: s };
});

const save = () => {
  if (out) writeFileSync(out, JSON.stringify(characterToJson(character), null, 2));
};

const start = performance.now();
let gens = 0;
await new Promise<void>((resolve, reject) => {
  const trainer = new Trainer(
    taskName,
    {
      blueprint: character.blueprint,
      motor: character.motor,
      decision: character.decision,
      level: character.progress.surviveLevel ?? 1,
      opponent: null,
    },
    genome,
    rng.nextU32(),
    (r) => {
      gens++;
      character = withTrained(character, taskName, r.champion);
      character.progress.generations[taskName] = (character.progress.generations[taskName] ?? 0) + 1;
      if (taskName === 'survive') character.progress.surviveLevel = r.setup.level;
      if (r.passed && !character.progress.passed.includes(taskName)) character.progress.passed.push(taskName);
      const elapsed = (performance.now() - start) / 1000;
      console.log(
        `世代${String(gens).padStart(4)}  最高 ${r.best.toFixed(2).padStart(7)}  平均 ${r.mean.toFixed(2).padStart(7)}  ` +
          `成功 ${r.bestResult.successCount}/${r.seeds.length}  ${r.stageLabel}  σ ${r.sigma.toFixed(3)}  ${r.seconds.toFixed(1)}s/世代  累計 ${elapsed.toFixed(0)}s` +
          (r.confirm ? `\n  → 確認:${r.confirm.text} ${r.confirm.passed ? '通過' : ''}` : ''),
      );
      if (r.confirm?.passed || gens % 10 === 0) save();
      if (gens >= maxGens || (flag('until-pass') && r.passed)) {
        save();
        void trainer.stop().then(() => {
          trainer.dispose();
          resolve();
        });
      }
    },
    (e) => reject(e),
    taskName === 'push' ? opponents : [],
    character.progress.passed.includes(taskName),
    () => new NodePool(),
  );
  trainer.start();
});
console.log(`終了:${gens}世代、${((performance.now() - start) / 1000).toFixed(0)}s、合格 ${character.progress.passed.join(', ') || 'なし'}`);
process.exit(0);
