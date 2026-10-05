// ステージの見た目。タイルは InstancedMesh で描き、状態に合わせて色と位置を毎フレーム更新する。
// 危険マーク中は赤く点滅し、崩落したタイルは下へ落ちて消える(見た目だけの演出)。
import * as THREE from 'three';
import { STAGE } from '../core/config';
import { hexToWorld } from '../core/stage/hex';
import type { Stage } from '../core/stage/stage';

const SAFE = new THREE.Color(0x5b6b82);
const SAFE_ALT = new THREE.Color(0x52617a);
const WARN = new THREE.Color(0xff4b4b);
const FINAL = new THREE.Color(0xf2c94c);
/** 崩落したタイルが落ちて消えるまでの時間 [s] */
const FALL_TIME = 1.2;

export class StageMesh {
  readonly root = new THREE.Group();
  private tiles: THREE.InstancedMesh;
  private ring: THREE.Mesh;
  private finalMarker: THREE.Mesh;
  private matrix = new THREE.Matrix4();
  private color = new THREE.Color();

  constructor(private stage: Stage) {
    const h = STAGE.tileHeight;
    // CylinderGeometry の6角形は頂点が +z を向くので、ステージのタイルと同じ向きになる
    const geometry = new THREE.CylinderGeometry(stage.size * 0.95, stage.size * 0.95, h, 6);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    this.tiles = new THREE.InstancedMesh(geometry, material, stage.tiles.length);
    this.tiles.receiveShadow = true;
    this.tiles.castShadow = true;
    this.root.add(this.tiles);

    // 安全円(最終地点からの距離の目安)と最終地点
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(1, 1.04, 96),
      new THREE.MeshBasicMaterial({ color: 0xf2c94c, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.02;
    this.root.add(this.ring);
    this.finalMarker = new THREE.Mesh(
      new THREE.CircleGeometry(stage.size * 0.35, 24),
      new THREE.MeshBasicMaterial({ color: FINAL, transparent: true, opacity: 0.8 }),
    );
    this.finalMarker.rotation.x = -Math.PI / 2;
    this.finalMarker.position.y = 0.015;
    this.root.add(this.finalMarker);
    this.update();
  }

  /** ステージの状態に合わせて見た目を更新する */
  update(): void {
    const s = this.stage;
    const h = STAGE.tileHeight;
    s.tiles.forEach((t, i) => {
      let y = -h / 2;
      let scale = 1;
      if (t.state === 'collapsed') {
        const since = s.time - t.collapsedAt;
        if (since >= FALL_TIME) scale = 0;
        else y -= 4 * since * since;
      }
      this.matrix.makeScale(scale, scale, scale).setPosition(t.x, y, t.z);
      this.tiles.setMatrixAt(i, this.matrix);

      if (t.state === 'warning') {
        // 崩落が近いほど速く点滅する
        const progress = t.warnTime / STAGE.warningTime;
        const blink = 0.5 + 0.5 * Math.cos(t.warnTime * (6 + 18 * progress));
        this.color.copy(SAFE).lerp(WARN, 0.35 + 0.65 * blink);
      } else {
        this.color.copy((t.q + t.r) % 2 === 0 ? SAFE : SAFE_ALT);
        // 滞在タイマーが溜まるほど少し赤みを帯びる
        if (t.stay > 0) this.color.lerp(WARN, 0.4 * Math.min(1, t.stay / STAGE.stayLimit));
      }
      this.tiles.setColorAt(i, this.color);
    });
    this.tiles.instanceMatrix.needsUpdate = true;
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;

    const fp = hexToWorld(s.finalPoint, s.size);
    this.finalMarker.position.set(fp.x, 0.015, fp.z);
    // 六角距離 r の範囲は、半径 (r + 0.5) × タイル間隔 の円でおおよそ表す
    const radius = (s.safeRadius + 0.5) * s.size * Math.sqrt(3);
    this.ring.position.set(fp.x, 0.02, fp.z);
    this.ring.scale.setScalar(radius);
  }

  dispose(): void {
    this.tiles.geometry.dispose();
    (this.tiles.material as THREE.Material).dispose();
    this.tiles.dispose();
    for (const m of [this.ring, this.finalMarker]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}
