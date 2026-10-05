import { readFileSync } from 'node:fs';
import { parseCharacter } from '../../src/core/codec';
import { initRapier } from '../../src/core/physics/rapier';
import { Fighter } from '../../src/core/sim/fighter';
import { Stage } from '../../src/core/stage/stage';
import { addFlatGround, spawnHeight } from '../../src/core/training/move';
import { PHYSICS } from '../../src/core/config';
const c = parseCharacter(readFileSync(process.argv[2], 'utf8'));
const R = await initRapier();
for (const ground of ['平地', 'タイル']) {
  const rows: string[] = [];
  for (let i = 0; i < 6; i++) {
    const world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    world.timestep = PHYSICS.dt;
    if (ground === '平地') addFlatGround(R, world);
    else new Stage(R, world, 1, { rules: false });
    const f = new Fighter(R, world, c.blueprint, c.motor!, { position: { x: 0, y: spawnHeight(c.blueprint) + (ground === '平地' ? 0 : 0.5), z: 0 }, yaw: i });
    const dir = { x: Math.cos(i * 1.7), z: Math.sin(i * 1.7) };
    let path = 0, prev = f.position();
    for (let s = 0; s < 600; s++) {
      if (s % 3 === 0) { f.command = { dirX: dir.x, dirZ: dir.z, speed: 1 }; f.drive(s * PHYSICS.dt, [0, 0, 0]); }
      world.step();
      const p = f.position();
      path += Math.hypot(p.x - prev.x, p.z - prev.z);
      prev = p;
    }
    const p = f.position();
    rows.push(`指令方向への前進 ${(p.x * dir.x + p.z * dir.z).toFixed(1)}m / 道のり ${path.toFixed(1)}m`);
    world.free();
  }
  console.log(`== ${ground}(10秒)`);
  rows.forEach((r) => console.log(r));
}
process.exit(0);
