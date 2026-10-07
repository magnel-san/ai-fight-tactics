// キャラの見た目。剛体ごとにグループを作り、毎フレーム剛体の位置・回転を写す。
import * as THREE from 'three';
import type { BlockType } from '../core/config';
import { CREATURE } from '../core/config';
import { pistonStates, type Creature } from '../core/creature/assemble';
import { FACE_DIR, pistonDirection, shapeOf } from '../core/creature/blueprint';
import { BlockGeometries, gripMaterial, gripOverlay, orientBlockMesh, windArrow, windArrowGeometry } from './blockShapes';

export const BLOCK_COLORS: Record<BlockType, number> = {
  core: 0xf2c94c,
  base: 0x9aa5b1,
  joint: 0x56ccf2,
  bouncy: 0xeb5757,
  piston: 0xc58b4a,
  sensor: 0xbb6bd9,
  cloud: 0xf4f7fb,
  wind: 0x7fd8e8,
};

export interface CreatureMesh {
  root: THREE.Group;
  groups: THREE.Group[];
  teamMarker: THREE.Mesh | null;
  /** ピストンの棒(creature.pistons と同じ並び)。伸びに合わせて長さを変える */
  rods: { mesh: THREE.Mesh; base: THREE.Vector3; dir: THREE.Vector3 }[];
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
  // 形ごとの形状(当たり判定と同じ大きさ・向き)
  const geometries = new BlockGeometries(size);
  const grip = gripMaterial({ ghost: opts.ghost });
  // 風の吹く向きの矢印
  const arrowGeometry = windArrowGeometry(size);
  const arrowMaterial = new THREE.MeshStandardMaterial({ color: 0xe0f7fa, transparent: true, opacity: opts.ghost ? 0.15 : 0.8 });
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

  // ピストンの棒:伸びた分だけ、ピストンブロックの後ろ(伸びる向きの反対側)に見える。縮んでいるときは長さ0
  const rodGeometry = new THREE.BoxGeometry(size * 0.35, size * 0.35, 1);
  const rodMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a8f99,
    metalness: 0.6,
    roughness: 0.4,
    transparent: opts.ghost ?? false,
    opacity: opts.ghost ? 0.22 : 1,
  });

  const rodByBlock = new Map<number, CreatureMesh['rods'][number]>();
  creature.blueprint.blocks.forEach((b, i) => {
    const geometry = geometries.get(shapeOf(b));
    const mesh = new THREE.Mesh(geometry, material(b.type));
    mesh.position.set(...creature.localOffsets[i]);
    orientBlockMesh(mesh, b);
    if (b.grip) mesh.add(gripOverlay(geometry, grip));
    if (b.type === 'wind') {
      // 矢印は形の向き(円柱の回転)に関係なく、剛体の座標で置く
      const arrow = windArrow(FACE_DIR[pistonDirection(b)], size, arrowGeometry, arrowMaterial);
      arrow.position.add(mesh.position);
      groups[creature.segmentOf[i]].add(arrow);
    }
    mesh.castShadow = !opts.ghost;
    groups[creature.segmentOf[i]].add(mesh);
    if (b.type === 'piston') {
      const d = new THREE.Vector3(...FACE_DIR[pistonDirection(b)]);
      const rod = new THREE.Mesh(rodGeometry, rodMaterial);
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d);
      rod.visible = false;
      groups[creature.segmentOf[i]].add(rod);
      rodByBlock.set(b.id, { mesh: rod, base: mesh.position.clone(), dir: d });
    }
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
    rods: creature.pistonBlockIds.map((id) => rodByBlock.get(id)!),
    root,
    groups,
    dispose() {
      geometries.dispose();
      grip.dispose();
      arrowGeometry.dispose();
      arrowMaterial.dispose();
      rodGeometry.dispose();
      rodMaterial.dispose();
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
  if (mesh.rods.length > 0) {
    pistonStates(creature).forEach((s, i) => {
      const rod = mesh.rods[i];
      const ext = Math.max(0, Math.min(CREATURE.pistonStroke, s.extension));
      rod.mesh.visible = ext > 0.01;
      rod.mesh.scale.set(1, 1, Math.max(0.001, ext));
      rod.mesh.position.copy(rod.base).addScaledVector(rod.dir, -(CREATURE.blockSize / 2 + ext / 2));
    });
  }
}
