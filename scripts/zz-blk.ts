import { createSoccerGenome } from '../src/core/brain/soccer';
import { Rng } from '../src/core/math/rng';
import { initRapier } from '../src/core/physics/rapier';
import { SoccerDrillEpisode } from '../src/core/training/soccerDrill';
import { standardBot } from '../src/data/bots';
const R = await initRapier();
const s = standardBot()!;
let goals = 0, shots = 0, ok = 0;
for (let i = 0; i < 8; i++) {
  const ep = new SoccerDrillEpisode(R, 'blocker', { blueprint: s.blueprint, motor: s.motor }, createSoccerGenome(new Rng(i)), 100 + i);
  const o = ep.run();
  goals += (ep as any).conceded; shots += (ep as any).shotsFired; if (o.success) ok++;
  ep.free();
}
console.log('学習前の脳:入った', goals, '/', shots, ' 成功', ok, '/ 8');
