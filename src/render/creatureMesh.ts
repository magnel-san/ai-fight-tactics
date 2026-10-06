// キャラの見た目。剛体ごとにグループを作り、毎フレーム剛体の位置・回転を写す。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BlockType } from '../core/config';
import { CREATURE } from '../core/config';
import type { Creature } from '../core/creature/assemble';

export const BLOCK_COLORS: Record<BlockType, number> = {
  core: 0xf2c94c,
  base: 0x9aa5b1,
  joint: 0x56ccf2,
  bouncy: 0xeb5757,
  grip: 0x6fcf97,
};

export interface CreatureMesh {
  root: THREE.Group;
  groups: THREE.Group[];
  teamMarker: THREE.Mesh | null;
  dispose(): void;
}

/** チームの色(バトルで2体を見分ける印に使う) */
export const TEAM_COLORS = [0x56ccf2, 0xff8a3d];

export interface CreatureMeshOptions {
  /** 半透明で表示する(ゴースト) */
  ghost?: boolean;
  /** チームの印をコアの上に出す(0 または 1) */
  team?: number;
}

export function buildCreatureMesh(creature: Creature, opts: CreatureMeshOptions = {}): CreatureMesh {
  const root = new THREE.Group();
  const groups = creature.bodies.map(() => {
    const g = new THREE.Group();
    root.add(g);
    return g;
  });

  // 見た目は物理のコライダーより少しだけ小さくして、ブロックの境目が分かるようにする
  const size = CREATURE.blockSize - CREATURE.colliderShrink * 2;
  // 当たり判定と同じく角を丸める
  const geometry = new RoundedBoxGeometry(size, size, size, 2, CREATURE.blockRoundness);
  const materials = new Map<BlockType, THREE.MeshStandardMaterial>();
  const material = (type: BlockType) => {
    let m = materials.get(type);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: BLOCK_COLORS[type],
        roughness: 0.6,
        transparent: opts.ghost ?? false,
        opacity: opts.ghost ? 0.22 : 1,
        depthWrite: !opts.ghost,
      });
      materials.set(type, m);
    }
    return m;
  };

  creature.blueprint.blocks.forEach((b, i) => {
    const mesh = new THREE.Mesh(geometry, material(b.type));
    mesh.position.set(...creature.localOffsets[i]);
    mesh.castShadow = !opts.ghost;
    groups[creature.segmentOf[i]].add(mesh);
  });

  // コアの正面(+z)マーク
  const markGeometry = new THREE.BoxGeometry(size * 0.5, size * 0.2, 0.02);
  const markMaterial = new THREE.MeshStandardMaterial({ color: 0x222222 });
  const mark = new THREE.Mesh(markGeometry, markMaterial);
  mark.position.set(0, size * 0.15, size / 2 + 0.01);
  groups[0].add(mark);

  // チームの印:コアの上に浮かぶ逆三角形(向きに関係なく真上に出すため、root 直下に置いて毎フレーム位置を合わせる)
  let teamMarker: THREE.Mesh | null = null;
  if (opts.team !== undefined) {
    teamMarker = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.22, 4), new THREE.MeshBasicMaterial({ color: TEAM_COLORS[opts.team] }));
    teamMarker.rotation.x = Math.PI;
    root.add(teamMarker);
  }

  return {
    teamMarker,
    root,
    groups,
    dispose() {
      geometry.dispose();
      markGeometry.dispose();
      if (teamMarker) {
        teamMarker.geometry.dispose();
        (teamMarker.material as THREE.Material).dispose();
      }
      markMaterial.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
}

export function syncCreatureMesh(creature: Creature, mesh: CreatureMesh): void {
  creature.bodies.forEach((body, i) => {
    const t = body.translation();
    const r = body.rotation();
    mesh.groups[i].position.set(t.x, t.y, t.z);
    mesh.groups[i].quaternion.set(r.x, r.y, r.z, r.w);
  });
  if (mesh.teamMarker) {
    const t = creature.bodies[0].translation();
    mesh.teamMarker.position.set(t.x, t.y + 0.75, t.z);
  }
}
