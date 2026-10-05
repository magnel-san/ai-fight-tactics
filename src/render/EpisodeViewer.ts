// エピソードの観戦表示。シードと遺伝子からエピソードをメインスレッドで再現し、実時間(または倍速)で描画する。
// 学習Workerで評価したのと同じ core のコードを使うので、Workerで見たのと同じ動きになる。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOVE_TASK, PHYSICS } from '../core/config';
import type { MoveEpisode } from '../core/training/move';
import { buildCreatureMesh, syncCreatureMesh, type CreatureMesh } from './creatureMesh';

export class EpisodeViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  private controls: OrbitControls;
  private targetMarker: THREE.Group;
  private trail: THREE.Line;
  private trailPoints: THREE.Vector3[] = [];
  private episode: MoveEpisode | null = null;
  private mesh: CreatureMesh | null = null;
  private frame = 0;
  private last = 0;
  private acc = 0;
  private resizeObserver: ResizeObserver;
  /** 再生速度(1 = 実時間) */
  speed = 1;
  /** エピソードが終わったときに呼ばれる(次のエピソードを渡すのに使う) */
  onEpisodeEnd: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0x1d2330);
    this.camera.position.set(4, 4, 6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 3);
    sun.castShadow = true;
    sun.shadow.camera.left = -10;
    sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    this.scene.add(sun, sun.target);

    const size = MOVE_TASK.groundHalfSize * 2;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: 0x3a4152 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor, new THREE.GridHelper(size, size, 0x556070, 0x465060));

    // 目標:到達半径の円と旗
    this.targetMarker = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(MOVE_TASK.arriveRadius - 0.05, MOVE_TASK.arriveRadius, 48),
      new THREE.MeshBasicMaterial({ color: 0xf2c94c, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.01;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
    pole.position.y = 0.6;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.02), new THREE.MeshStandardMaterial({ color: 0xf2c94c }));
    flag.position.set(0.18, 1.08, 0);
    this.targetMarker.add(ring, pole, flag);
    this.scene.add(this.targetMarker);

    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x56ccf2 }));
    this.scene.add(this.trail);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.loop);
  }

  /** 表示するエピソードを差し替える(古いエピソードは解放する) */
  setEpisode(episode: MoveEpisode): void {
    this.clearEpisode();
    this.episode = episode;
    this.mesh = buildCreatureMesh(episode.creature);
    this.scene.add(this.mesh.root);
    this.targetMarker.position.set(episode.target.x, 0, episode.target.z);
    this.trailPoints = [];
    syncCreatureMesh(episode.creature, this.mesh);
    // カメラをキャラと目標の中間に向ける
    const p = episode.creature.bodies[0].translation();
    this.controls.target.set((p.x + episode.target.x) / 2, 0.3, (p.z + episode.target.z) / 2);
    this.acc = 0;
  }

  get currentEpisode(): MoveEpisode | null {
    return this.episode;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.clearEpisode();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.controls.dispose();
    this.renderer.dispose();
  }

  private clearEpisode(): void {
    if (this.mesh) {
      this.scene.remove(this.mesh.root);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.episode?.free();
    this.episode = null;
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = (now: number) => {
    const elapsed = this.last === 0 ? 0 : Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const ep = this.episode;
    if (ep && this.canvas.clientWidth > 0 && this.speed > 0) {
      if (!ep.done) {
        this.acc += elapsed * this.speed;
        while (this.acc >= PHYSICS.dt && !ep.done) {
          ep.advance();
          this.acc -= PHYSICS.dt;
        }
        const p = ep.creature.bodies[0].translation();
        this.trailPoints.push(new THREE.Vector3(p.x, 0.02, p.z));
        this.trail.geometry.setFromPoints(this.trailPoints);
      } else {
        this.acc += elapsed;
        // 終了後、少し間を置いてから次へ
        if (this.acc > 1.0) {
          this.acc = 0;
          this.onEpisodeEnd?.();
        }
      }
      if (this.mesh) syncCreatureMesh(ep.creature, this.mesh);
    }
    // 非表示のとき・「描画なし」のときは描画しない
    if (this.canvas.clientWidth > 0 && this.speed > 0) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }
    this.frame = requestAnimationFrame(this.loop);
  };
}
