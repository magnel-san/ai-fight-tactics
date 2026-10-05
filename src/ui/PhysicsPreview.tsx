// 試運転(P1の確認用)。キャラを床に落とし、関節を周期的に動かして表示する。
// 物理は固定ステップ(1/60秒)で進め、描画のフレームレートとは切り離す。
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CREATURE, PHYSICS } from '../core/config';
import { jointStates, setJointTargets, spawnCreature, type Creature } from '../core/creature/assemble';
import { blockPositions, centerOfMass, jointCount, totalCost, type Blueprint } from '../core/creature/blueprint';
import { sin } from '../core/math/fmath';
import { initRapier } from '../core/physics/rapier';
import { buildCreatureMesh, syncCreatureMesh } from '../render/creatureMesh';

/** 関節を動かす仮の周期 [s]。脳ができたら置き換える */
const GAIT_PERIOD = 1.0;
/** 関節を動かす仮の振幅(-1〜1 の目標角度) */
const GAIT_AMPLITUDE = 0.6;

/** 関節ごとに位相をずらす(4本脚なら左前・右前・左後・右後が 0, π/2, π, 3π/2) */
function gaitPhase(i: number, n: number): number {
  return (2 * Math.PI * i) / n;
}

export function PhysicsPreview({ blueprint }: { blueprint: Blueprint }) {
  const BLUEPRINT = blueprint;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const movingRef = useRef(true);
  const resetRef = useRef<() => void>(() => {});
  const [moving, setMoving] = useState(true);
  const [angles, setAngles] = useState<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let disposed = false;
    let frame = 0;
    let cleanup = () => {};

    initRapier().then((R) => {
      if (disposed) return;

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.shadowMap.enabled = true;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1d2330);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
      camera.position.set(2.2, 1.6, 2.8);
      const controls = new OrbitControls(camera, canvas);
      controls.target.set(0, 0.3, 0);
      // 仕様どおり右ドラッグで回転、ホイールでズーム
      controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.5);
      sun.position.set(3, 6, 2);
      sun.castShadow = true;
      scene.add(sun);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshStandardMaterial({ color: 0x3a4152 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      scene.add(floor);
      scene.add(new THREE.GridHelper(20, 50, 0x556070, 0x465060));

      let world: InstanceType<typeof R.World>;
      let creature: Creature;
      let mesh: ReturnType<typeof buildCreatureMesh> | null = null;
      let step = 0;

      const reset = () => {
        if (mesh) {
          scene.remove(mesh.root);
          mesh.dispose();
        }
        world?.free();
        world = new R.World({ x: 0, y: PHYSICS.gravity, z: 0 });
        world.timestep = PHYSICS.dt;
        world.createCollider(R.ColliderDesc.cuboid(10, 0.1, 10).setTranslation(0, -0.1, 0));
        // 最も低いブロックの底面が床から少し浮く高さに置く
        const minY = Math.min(...blockPositions(BLUEPRINT).map((p) => p[1]));
        const y = (-minY + 0.5) * CREATURE.blockSize + 0.2;
        creature = spawnCreature(R, world, BLUEPRINT, { position: { x: 0, y, z: 0 }, yaw: 0 });
        mesh = buildCreatureMesh(creature);
        scene.add(mesh.root);
        step = 0;
      };
      reset();
      resetRef.current = reset;

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = canvas;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      window.addEventListener('resize', resize);

      let last = performance.now();
      let acc = 0;
      const loop = (now: number) => {
        acc += Math.min(0.1, (now - last) / 1000);
        last = now;
        while (acc >= PHYSICS.dt) {
          if (step % PHYSICS.brainInterval === 0) {
            const t = step * PHYSICS.dt;
            const w = (2 * Math.PI) / GAIT_PERIOD;
            const n = creature.joints.length;
            setJointTargets(
              creature,
              creature.joints.map((_, i) => (movingRef.current ? GAIT_AMPLITUDE * sin(w * t + gaitPhase(i, n)) : 0)),
            );
          }
          world.step();
          step++;
          acc -= PHYSICS.dt;
        }
        syncCreatureMesh(creature, mesh!);
        controls.update();
        renderer.render(scene, camera);
        if (step % 6 === 0) setAngles(jointStates(creature).map((s) => s.angle));
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);

      cleanup = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', resize);
        mesh?.dispose();
        world.free();
        controls.dispose();
        renderer.dispose();
      };
    });

    return () => {
      disposed = true;
      cleanup();
    };
    // 試運転画面は開くたびに作り直すので、設計図は開いた時点のものを使う
  }, []);

  const com = centerOfMass(BLUEPRINT);
  return (
    <section>
      <p>
        コスト {totalCost(BLUEPRINT)} / {CREATURE.maxCost}・関節 {jointCount(BLUEPRINT)} / {CREATURE.maxJoints}・重心(コア基準){' '}
        {com.map((v) => v.toFixed(2)).join(', ')} m
      </p>
      <canvas ref={canvasRef} className="preview-canvas" />
      <p>
        <button
          onClick={() => {
            movingRef.current = !movingRef.current;
            setMoving(movingRef.current);
          }}
        >
          {moving ? '関節を止める' : '関節を動かす'}
        </button>{' '}
        <button onClick={() => resetRef.current()}>リセット</button>{' '}
        <span style={{ color: '#666' }}>右ドラッグで回転、ホイールでズーム</span>
      </p>
      <p style={{ fontFamily: 'monospace' }}>
        関節角度:{angles.map((a) => `${((a * 180) / Math.PI).toFixed(0)}°`).join('  ')}
      </p>
    </section>
  );
}
