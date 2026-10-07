// ブロックの形(立方体・球・円柱)の見た目。対戦の表示とキャラクリエイト画面で共通に使う。
// 当たり判定(src/core/creature/assemble.ts)と同じ大きさ・向きにする。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CREATURE, type BlockShape } from '../core/config';
import { cylinderAxis, shapeOf, type Axis, type BlockSpec } from '../core/creature/blueprint';

/** 形ごとの形状(1辺 size の立方体に収まる大きさ)。使い終わったら dispose する */
export class BlockGeometries {
  private cache = new Map<BlockShape, THREE.BufferGeometry>();

  constructor(private size: number) {}

  get(shape: BlockShape): THREE.BufferGeometry {
    let g = this.cache.get(shape);
    if (!g) {
      const s = this.size;
      g =
        shape === 'sphere'
          ? new THREE.SphereGeometry(s / 2, 20, 14)
          : shape === 'cylinder'
            ? new THREE.CylinderGeometry(s / 2, s / 2, s, 20)
            : new RoundedBoxGeometry(s, s, s, 2, CREATURE.blockRoundness);
      this.cache.set(shape, g);
    }
    return g;
  }

  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
  }
}

const H = Math.SQRT1_2;
/** 円柱(three.js では軸が Y)を、指定した軸の向きに回す */
const CYLINDER_QUAT: Record<Axis, THREE.Quaternion> = {
  x: new THREE.Quaternion(0, 0, -H, H),
  y: new THREE.Quaternion(0, 0, 0, 1),
  z: new THREE.Quaternion(H, 0, 0, H),
};

/** ブロックのメッシュの向きを、形に合わせて設定する(円柱だけ向きがある) */
export function orientBlockMesh(mesh: THREE.Object3D, b: BlockSpec): void {
  if (shapeOf(b) === 'cylinder') mesh.quaternion.copy(CYLINDER_QUAT[cylinderAxis(b)]);
  else mesh.quaternion.identity();
}

/** 摩擦オンのしるし(緑の網目)。ブロックのメッシュに子として付ける */
export function gripOverlay(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.scale.setScalar(1.015);
  return m;
}

export function gripMaterial(opts: { ghost?: boolean } = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0x27ae60, wireframe: true, transparent: true, opacity: opts.ghost ? 0.15 : 0.55 });
}
