// 決定性の確認用レポート。同じ計算をNodeと各ブラウザで行い、ハッシュが一致するかを比べる(仕様書セクション5)。
// 物理だけ・移動トレーニング(脳と自前の数学関数)・バトル(ステージの崩落と判断脳)の3つを見る。
import { createDecisionGenome } from '../brain/decision';
import { createMotorGenome } from '../brain/motor';
import { STANDARD_BODY } from '../creature/samples';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { MoveEpisode } from '../training/move';
import { StateHasher } from './hash';
import type { Fighter } from './fighter';
import { MatchEpisode } from './match';
import { runSmokeSim } from './smoke';

function hashFighters(h: StateHasher, fighters: readonly Fighter[]): void {
  for (const f of fighters) {
    for (const b of f.creature.bodies) {
      const p = b.translation();
      const q = b.rotation();
      h.add(p.x).add(p.y).add(p.z).add(q.x).add(q.y).add(q.z).add(q.w);
    }
  }
}

export function determinismReport(R: Rapier): Record<string, string> {
  const joints = 4;
  const motor = createMotorGenome(joints, new Rng(7));

  const move = new MoveEpisode(R, STANDARD_BODY, motor, 3);
  const mo = move.run();
  const mh = new StateHasher().add(mo.reward).add(mo.time);
  hashFighters(mh, move.fighters);
  move.free();

  const fighter = (seed: number) => ({
    blueprint: STANDARD_BODY,
    motor: createMotorGenome(joints, new Rng(seed)),
    decision: createDecisionGenome(new Rng(seed + 100)),
    controller: 'brain' as const,
  });
  const battle = new MatchEpisode(R, { mode: 'battle', seed: 2026, fighters: [fighter(1), fighter(2)], timeLimit: 60 });
  battle.run();
  const bh = new StateHasher().add(battle.time);
  hashFighters(bh, battle.fighters);
  for (const t of battle.stage!.tiles) bh.add(t.state === 'safe' ? 0 : t.state === 'warning' ? 1 : 2).add(t.stay);
  battle.free();

  return { smoke: runSmokeSim(R, 1), move: mh.digest(), battle: bh.digest() };
}
