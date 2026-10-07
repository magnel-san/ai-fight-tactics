// 「AIの考え」の表示:判断脳が目で見ているタイル(危ないと見ている場所)と、進みたい向きの矢印を、試合の上に重ねる。
//   ・目の61マス:安全なら小さな白い点、危険マークならオレンジ〜赤、穴(崩れた場所)なら紫
//   ・矢印:判断脳が運動脳に出した指令(進む向きと速さ)。長いほど速く進みたい
// 判断脳の入力(DecisionBrain.input)をそのまま読むので、AIが実際に見ている値と同じになる。
import * as THREE from 'three';
import { EYE_OFFSETS } from '../core/brain/decision';
import type { DecisionBrain } from '../core/brain/decision';
import type { Fighter } from '../core/sim/fighter';
import type { Episode } from '../core/training/episode';
import { TEAM_COLORS } from './creatureMesh';

/** 判断脳を持つエピソード(試合) */
interface WithBrains {
  decisionBrain(i: number): DecisionBrain | null;
}

const hasBrains = (ep: Episode): ep is Episode & WithBrains => typeof (ep as Partial<WithBrains>).decisionBrain === 'function';

const SAFE = new THREE.Color(0xffffff);
const WARN = new THREE.Color(0xffa726);
const DANGER = new THREE.Color(0xff3b3b);
const HOLE = new THREE.Color(0x9b59ff);

export class BrainOverlay {
  readonly root = new THREE.Group();
  private discGeometry = new THREE.CircleGeometry(0.16, 12);
  private discMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false });
  private eyes: THREE.InstancedMesh[] = [];
  private arrows: THREE.ArrowHelper[] = [];
  private matrix = new THREE.Matrix4();
  private color = new THREE.Color();

  constructor() {
    this.discGeometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const eye = new THREE.InstancedMesh(this.discGeometry, this.discMaterial, EYE_OFFSETS.length);
      eye.frustumCulled = false;
      this.eyes.push(eye);
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, TEAM_COLORS[i], 0.25, 0.16);
      this.arrows.push(arrow);
      this.root.add(eye, arrow);
    }
    this.root.visible = false;
  }

  /** 表示を最新にする(判断脳のない場面では何も出さない) */
  update(ep: Episode | null): void {
    if (!ep || !hasBrains(ep)) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    for (let i = 0; i < 2; i++) {
      const f = ep.fighters[i] as Fighter | undefined;
      const brain = f && !f.out ? ep.decisionBrain(i) : null;
      this.eyes[i].visible = !!brain;
      this.arrows[i].visible = !!f && !f.out && !!f.command;
      if (f && brain) this.updateEye(i, f, brain);
      if (f && !f.out) this.updateArrow(i, f);
    }
  }

  private updateEye(i: number, f: Fighter, brain: DecisionBrain): void {
    const p = f.position();
    const h = f.heading();
    const eye = this.eyes[i];
    EYE_OFFSETS.forEach((o, k) => {
      const x = p.x + o.x * h.xx + o.z * h.fx;
      const z = p.z + o.x * h.xz + o.z * h.fz;
      const v = brain.input[k];
      // 安全なマスは小さく、危ないマスは大きく
      const s = v === 0 ? 0.35 : 1;
      this.matrix.makeScale(s, 1, s).setPosition(x, 0.03 + i * 0.005, z);
      eye.setMatrixAt(k, this.matrix);
      if (v < 0) this.color.copy(HOLE);
      else if (v === 0) this.color.copy(SAFE);
      else this.color.copy(WARN).lerp(DANGER, Math.min(1, Math.max(0, (v - 0.5) * 2)));
      eye.setColorAt(k, this.color);
    });
    eye.instanceMatrix.needsUpdate = true;
    if (eye.instanceColor) eye.instanceColor.needsUpdate = true;
  }

  private updateArrow(i: number, f: Fighter): void {
    const c = f.command;
    const len = Math.sqrt(c.dirX * c.dirX + c.dirZ * c.dirZ);
    const arrow = this.arrows[i];
    if (len < 1e-6 || c.speed < 0.02) {
      arrow.visible = false;
      return;
    }
    const p = f.position();
    arrow.position.set(p.x, p.y + 0.45, p.z);
    arrow.setDirection(new THREE.Vector3(c.dirX / len, 0, c.dirZ / len));
    arrow.setLength(0.35 + 1.2 * c.speed, 0.25, 0.16);
  }

  dispose(): void {
    this.discGeometry.dispose();
    this.discMaterial.dispose();
    for (const e of this.eyes) e.dispose();
    for (const a of this.arrows) a.dispose();
  }
}
