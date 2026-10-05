// 関門1の検証:自由な体型のキャラが、数分の学習で目標へ歩けるようになるか。
// 画面なし・1スレッドで「目標地点への移動」を学習させ、世代ごとの成績と所要時間を表示する。
//   npx tsx scripts/gate1.ts [サンプル名] [最大世代数] [シード] [最優秀個体の保存先(任意)]
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { createMotorGenome } from '../src/core/brain/motor';
import { MOVE_TASK, TRAINING } from '../src/core/config';
import { jointCount } from '../src/core/creature/blueprint';
import { SAMPLES } from '../src/core/creature/samples';
import { Rng } from '../src/core/math/rng';
import { initRapier } from '../src/core/physics/rapier';
import { GeneticAlgorithm } from '../src/core/training/ga';
import { MoveEpisode, evaluateMove } from '../src/core/training/move';

const name = process.argv[2] ?? 'quadruped';
const maxGenerations = Number(process.argv[3] ?? 150);
const seed = Number(process.argv[4] ?? 1);
const savePath = process.argv[5];
const bp = SAMPLES[name];
if (!bp) throw new Error(`サンプルがありません:${name}(${Object.keys(SAMPLES).join(', ')})`);

const R = await initRapier();
const rng = new Rng(seed);
const ga = new GeneticAlgorithm(createMotorGenome(jointCount(bp), rng.fork()), rng.nextU32());
const workers = Math.min(TRAINING.workersMax, Math.max(TRAINING.workersMin, availableParallelism() - 2));

/** 全周を36等分した方向で評価し、正面・横・後ろ別の到達数を返す */
function directionCheck(genome: Float64Array): string {
  const n = 36;
  const reached: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const ep = new MoveEpisode(R, bp, genome, rng.nextU32(), { index: i, count: n });
    reached.push(ep.run().reached);
    ep.free();
  }
  // index i の方向は、正面から見て -180° + (i + 0.5) × 360°/n 付近
  const group = (i: number) => {
    const deg = Math.abs(-180 + ((i + 0.5) * 360) / n);
    return deg < 60 ? 'front' : deg > 120 ? 'back' : 'side';
  };
  const count = (g: string) => reached.filter((r, i) => r && group(i) === g).length;
  const per = n / 3;
  const total = reached.filter(Boolean).length;
  return `全周${n}方向で ${total}/${n}(正面 ${count('front')}/${per}・横 ${count('side')}/${per}・後ろ ${count('back')}/${per})`;
}

/** 合格しても止めずに最大世代数まで続ける(長く学習すると上達し続けるかを見る) */
const noStop = process.env.GATE_NO_STOP === '1';

console.log(`サンプル=${name} 関節=${jointCount(bp)} 個体数=${TRAINING.population} 想定Worker数=${workers}`);
const start = performance.now();
let passedAt: number | null = null;

for (let gen = 0; gen < maxGenerations; gen++) {
  const t0 = performance.now();
  const seeds = Array.from({ length: TRAINING.episodesPerGeneration }, () => rng.nextU32());
  const results = ga.population.map((g) => evaluateMove(R, bp, g, seeds));
  const stats = ga.tell(results.map((r) => r.fitness));
  const best = results[stats.bestIndex];
  const champion = ga.population[0];
  const sec = (performance.now() - t0) / 1000;
  const total = (performance.now() - start) / 1000;
  console.log(
    `世代${String(gen).padStart(3)}  最高 ${stats.best.toFixed(2).padStart(6)}  平均 ${stats.mean.toFixed(2).padStart(6)}  ` +
      `最優秀の到達 ${best.reachedCount}/3  σ ${stats.sigma.toFixed(3)}  ` +
      `${sec.toFixed(1)}s/世代  累計 ${total.toFixed(0)}s(並列なら約 ${(total / workers).toFixed(0)}s)`,
  );
  if (savePath && gen % 10 === 9) writeFileSync(savePath, JSON.stringify({ name, gen, genome: [...champion] }));

  if (best.reachedCount >= MOVE_TASK.passCount) {
    // ゲームと同じ合格確認(新しいシードで9方向)
    const confirmSeeds = Array.from({ length: MOVE_TASK.confirmEpisodes }, () => rng.nextU32());
    const { reachedCount } = evaluateMove(R, bp, champion, confirmSeeds);
    const ok = reachedCount >= MOVE_TASK.confirmPassCount;
    console.log(`  → 合格確認 ${reachedCount}/${MOVE_TASK.confirmEpisodes} ${ok ? '合格' : '不合格'}`);
    if (ok && passedAt === null) {
      passedAt = gen;
      console.log(`  → 念のため:${directionCheck(champion)}`);
      if (savePath) writeFileSync(savePath, JSON.stringify({ name, gen, genome: [...champion] }));
      if (!noStop) break;
    }
  }
  if (gen % 25 === 24) console.log(`  → 途中経過:${directionCheck(champion)}`);
}
const total = (performance.now() - start) / 1000;
console.log(
  passedAt !== null
    ? `合格:${passedAt + 1}世代、${total.toFixed(0)}s(並列なら約${(total / workers).toFixed(0)}s)`
    : `未合格(${maxGenerations}世代、${total.toFixed(0)}s)`,
);
