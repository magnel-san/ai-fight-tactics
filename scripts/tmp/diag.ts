import { readFileSync } from 'node:fs';
import { parseCharacter } from '../../src/core/codec';
import { initRapier } from '../../src/core/physics/rapier';
import { MatchEpisode } from '../../src/core/sim/match';
import { STAGE } from '../../src/core/config';
const c = parseCharacter(readFileSync(process.argv[2], 'utf8'));
const R = await initRapier();
for (let i = 0; i < 8; i++) {
  const m = new MatchEpisode(R, { mode: 'survive', seed: 300 + i, pace: 0.4, fighters: [{ blueprint: c.blueprint, motor: c.motor!, decision: c.decision, controller: 'brain' }] });
  const st = m.stage!;
  const f = m.fighters[0];
  // まっすぐ同じ方向へ進ませる(滞在で崩れないように動き続ける)
  m.externalCommand = () => ({ dirX: Math.cos(i), dirZ: Math.sin(i), speed: 1 });
  let maxStay = 0, path = 0, prev = f.position(), log = '';
  while (!m.done) {
    m.advance();
    if (f.out) break;
    const p = f.position();
    path += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
    const t = st.tileAt(p.x, p.z);
    if (t) maxStay = Math.max(maxStay, t.stay);
    log = `t=${m.time.toFixed(1)} 位置(${p.x.toFixed(1)},${p.y.toFixed(2)},${p.z.toFixed(1)}) 足元=${t ? t.state : '場外'}`;
  }
  const o = m.outcome();
  console.log(`${o.success ? '生存' : '脱落'} ${o.time.toFixed(1)}s 移動${path.toFixed(1)}m 最大滞在${maxStay.toFixed(1)}s | ${log}`);
  m.free();
}
console.log('滞在上限', STAGE.stayLimit);
process.exit(0);
