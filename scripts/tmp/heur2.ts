import { readFileSync } from 'node:fs';
import { parseCharacter } from '../../src/core/codec';
import { initRapier } from '../../src/core/physics/rapier';
import { MatchEpisode } from '../../src/core/sim/match';
import { hexDistance, hexToWorld, worldToHex } from '../../src/core/stage/hex';

const c = parseCharacter(readFileSync(process.argv[2], 'utf8'));
const R = await initRapier();
for (const pace of [0.4, 0.5, 0.6]) {
  let ok = 0, okBrain = 0;
  for (let i = 0; i < 16; i++) {
    for (const useRule of [true, false]) {
      const m = new MatchEpisode(R, { mode: 'survive', seed: 300 + i, pace, fighters: [{ blueprint: c.blueprint, motor: c.motor!, decision: c.decision, controller: 'brain' }] });
      const st = m.stage!;
      const f = m.fighters[0];
      if (useRule)
        m.externalCommand = () => {
          const p = f.position();
          const fp = hexToWorld(st.finalPoint, st.size);
          let best = -Infinity, bx = 0, bz = 1;
          for (let k = 0; k < 16; k++) {
            const a = (2 * Math.PI * k) / 16, dx = Math.cos(a), dz = Math.sin(a);
            let score = 0;
            for (const d of [0.5, 1.0, 1.5, 2.0]) {
              const v = st.dangerAt(p.x + dx * d, p.z + dz * d);
              if (v < 0) score -= 10 / d; else score -= (v * 3) / d;
              if (hexDistance(worldToHex(p.x + dx * d, p.z + dz * d, st.size), st.finalPoint) > st.safeRadius - 1) score -= 1 / d;
            }
            const tx = fp.x - p.x, tz = fp.z - p.z, tl = Math.hypot(tx, tz) || 1;
            score += 0.3 * ((dx * tx + dz * tz) / tl);
            if (score > best) { best = score; bx = dx; bz = dz; }
          }
          return { dirX: bx, dirZ: bz, speed: 1 };
        };
      const o = m.run();
      if (o.success) { if (useRule) ok++; else okBrain++; }
      m.free();
    }
  }
  console.log(`ペース${pace}: 手書きルール ${ok}/16、学習した判断脳 ${okBrain}/16`);
}
process.exit(0);
