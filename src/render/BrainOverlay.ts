// 「AIの考え」の表示:判断脳が目で見ているタイル(危ないと見ている場所)と、進みたい向きの矢印を、試合の上に重ねる。
// 判断脳のない場面(運動脳のトレーニング)では、運動脳に出している指令(進む向き)の矢印だけを出す。
// ジャンプの指令(ジャンプボタン)を出している間は、キャラの上に黄色の上向き矢印と「JUMP」を出す。
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
/** 矢印を出すキャラの数(サッカーの6人まで)。目は試合の2体だけ */
const MAX_FIGHTERS = 6;
const ARROW_COLORS = [...TEAM_COLORS, 0x6fcf97, 0xf2c94c, 0xbb6bd9, 0xff6b6b];

/** 「JUMP」の文字(キャンバスに描いて板に貼る) */
function jumpLabel(): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, 128, 48);
  g.fillStyle = '#ffd54f';
  g.font = 'bold 32px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('JUMP', 64, 25);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(0.8, 0.3, 1);
  return sprite;
}

export class BrainOverlay {
  readonly root = new THREE.Group();
  private discGeometry = new THREE.CircleGeometry(0.16, 12);
  private discMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false });
  private eyes: THREE.InstancedMesh[] = [];
  private arrows: THREE.ArrowHelper[] = [];
  /** ジャンプの指令の印(上向きの矢印と文字) */
  private jumps: THREE.Group[] = [];
  private jumpGeometry = new THREE.ConeGeometry(0.14, 0.32, 12);
  private jumpMaterial = new THREE.MeshBasicMaterial({ color: 0xffd54f, depthTest: false });
  private matrix = new THREE.Matrix4();
  private color = new THREE.Color();

  constructor() {
    this.discGeometry.rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const eye = new THREE.InstancedMesh(this.discGeometry, this.discMaterial, EYE_OFFSETS.length);
      eye.frustumCulled = false;
      this.eyes.push(eye);
      this.root.add(eye);
    }
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, ARROW_COLORS[i], 0.25, 0.16);
      this.arrows.push(arrow);
      const jump = new THREE.Group();
      const cone = new THREE.Mesh(this.jumpGeometry, this.jumpMaterial);
      cone.renderOrder = 10;
      const label = jumpLabel();
      label.position.y = 0.35;
      jump.add(cone, label);
      jump.visible = false;
      this.jumps.push(jump);
      this.root.add(arrow, jump);
    }
    this.root.visible = false;
  }

  /** 表示を最新にする(判断脳のない場面では何も出さない) */
  update(ep: Episode | null): void {
    if (!ep) {
      this.root.visible = false;
      return;
    }
    // 判断脳のない場面(移動・追跡・穴をまたぐ などの運動脳のトレーニング)でも、進みたい向きの矢印は出す
    this.root.visible = true;
    for (let i = 0; i < MAX_FIGHTERS; i++) {
      const f = ep.fighters[i] as Fighter | undefined;
      const brain = i < 2 && f && !f.out && hasBrains(ep) ? ep.decisionBrain(i) : null;
      if (i < 2) this.eyes[i].visible = !!brain;
      this.arrows[i].visible = !!f && !f.out && !!f.command;
      // ジャンプボタン:指令でジャンプを出している間だけ、キャラの上に印を出す
      const jumping = !!f && !f.out && (f.command?.jump ?? 0) > 0;
      this.jumps[i].visible = jumping;
      if (jumping) {
        const p = f!.position();
        this.jumps[i].position.set(p.x, p.y + 0.9, p.z);
      }
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
    this.jumpGeometry.dispose();
    this.jumpMaterial.dispose();
    for (const j of this.jumps) {
      const sprite = j.children[1] as THREE.Sprite;
      sprite.material.map?.dispose();
      sprite.material.dispose();
    }
  }
}
