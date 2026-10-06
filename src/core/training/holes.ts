// トレーニング「穴をまたぐ」(仕様書セクション9、メニュー3・任意)。
// タイルのステージに1マス幅の穴の列を並べ、まっすぐ進む指令を出す。崩落ルールは使わない。
// 穴が目の前に来たらジャンプ指令も出す(跳んで越えても、歩いて越えてもよい)。
import { footing } from '../brain/decision';
import { HOLES_TASK, PHYSICS, STAGE } from '../config';
import type { Blueprint } from '../creature/blueprint';
import { Rng } from '../math/rng';
import type { Rapier } from '../physics/rapier';
import { Fighter } from '../sim/fighter';
import { hexesWithin, hexToWorld } from '../stage/hex';
import { Stage } from '../stage/stage';
import { EpisodeBase } from './episode';
import { spawnHeight } from './move';

export class HolesEpisode extends EpisodeBase {
  readonly fighter: Fighter;
  /** 穴の列の z 座標 */
  private rowZ: number[];
  private prevZ: number;
  private crossed = 0;

  constructor(R: Rapier, bp: Blueprint, motorGenome: Float64Array, seed: number) {
    super(R);
    const rng = new Rng(seed);
    const holes = hexesWithin(STAGE.radius).filter((h) => (HOLES_TASK.holeRows as readonly number[]).includes(h.r));
    this.stage = new Stage(R, this.world, rng.nextU32(), { rules: false, holes });
    this.rowZ = HOLES_TASK.holeRows.map((r) => hexToWorld({ q: 0, r }, STAGE.tileCircumradius).z);

    const z = hexToWorld({ q: 0, r: HOLES_TASK.startRow }, STAGE.tileCircumradius).z;
    this.fighter = new Fighter(R, this.world, bp, motorGenome, {
      position: { x: rng.range(-0.5, 0.5), y: spawnHeight(bp), z },
      yaw: rng.range(-Math.PI, Math.PI),
    });
    this.fighters = [this.fighter];
    this.prevZ = z;
  }

  crossedRows(): number {
    return this.crossed;
  }

  protected think(): void {
    const f = this.fighter;
    const t = this.time;
    const p = f.position();
    if (!f.isFinite() || p.y < -PHYSICS.fallDepth) {
      this.reward -= HOLES_TASK.fallPenalty;
      this.finish();
      return;
    }

    // 前進した距離(+z 方向)
    this.reward += p.z - this.prevZ;
    this.prevZ = p.z;

    // 穴の列を越えたか(コアが列の向こう側のタイルの上に乗った)
    while (this.crossed < this.rowZ.length && p.z > this.rowZ[this.crossed] + STAGE.tileCircumradius && p.y > -0.2) {
      this.crossed++;
      this.flags.crossed = true;
    }
    this.metric = this.crossed;
    this.success = this.crossed >= HOLES_TASK.passRows;

    if (t >= HOLES_TASK.timeLimit) {
      this.finish();
      return;
    }

    // まっすぐ進む指令。穴が目の前(足元の1点目)に来たらジャンプ指令も出す
    f.command = { dirX: 0, dirZ: 1, speed: 1 };
    const holes = footing(this.stage!, f);
    f.command.jump = holes[0];
    f.drive(t, holes);
  }
}
