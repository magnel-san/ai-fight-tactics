// ブロックの形(立方体・球・円柱)の見た目。対戦の表示とキャラクリエイト画面で共通に使う。
// 当たり判定(src/core/creature/assemble.ts)と同じ大きさ・向きにする。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BLOCK_OPTIONS, CREATURE, type BlockShape } from '../core/config';
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

  private tire: THREE.BufferGeometry | null = null;
  private hub: THREE.BufferGeometry | null = null;

  /** ブロックの形状(タイヤモードなら半径の大きい円柱) */
  of(b: BlockSpec): THREE.BufferGeometry {
    if (!b.tire) return this.get(shapeOf(b));
    const r = (this.size / 2) * BLOCK_OPTIONS.tireRadiusScale;
    this.tire ??= new THREE.CylinderGeometry(r, r, this.size, 28);
    return this.tire;
  }

  /** タイヤの中心のホイール(関節の色で、タイヤより少しだけ長い) */
  hubGeometry(): THREE.BufferGeometry {
    this.hub ??= new THREE.CylinderGeometry(this.size * 0.3, this.size * 0.3, this.size * 1.04, 16);
    return this.hub;
  }

  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
    this.tire?.dispose();
    this.hub?.dispose();
  }
}

/** タイヤの色 */
export const TIRE_COLOR = 0x2b2f36;

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

/** 風ブロックの吹く向きの矢印(ブロックの外側に出す)。dir はコア基準の向き */
export function windArrow(dir: readonly [number, number, number], size: number, geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  const d = new THREE.Vector3(...dir);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  m.position.copy(d.multiplyScalar(size * 0.75));
  m.raycast = () => {};
  return m;
}

/** 風の矢印の形(円すい) */
export function windArrowGeometry(size: number): THREE.BufferGeometry {
  return new THREE.ConeGeometry(size * 0.22, size * 0.4, 12);
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
