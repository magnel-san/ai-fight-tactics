// エピソードの観戦表示。シードと遺伝子からエピソードをメインスレッドで再現し、実時間(または倍速)で描画する。
// 学習Workerで評価したのと同じ core のコードを使うので、Workerで見たのと同じ動きになる。
// 主役のエピソードに加えて、ゴースト(半透明で重ねる別個体のエピソード)も同時に進められる。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOVE_TASK, PHYSICS } from '../core/config';
import type { Episode } from '../core/training/episode';
import { buildCreatureMesh, syncCreatureMesh, type CreatureMesh } from './creatureMesh';
import { StageMesh } from './StageMesh';

interface Shown {
  episode: Episode;
  meshes: CreatureMesh[];
}

export class EpisodeViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  private controls: OrbitControls;
  private floor: THREE.Group;
  private targetMarker: THREE.Group;
  private trail: THREE.Line;
  private trailPoints: THREE.Vector3[] = [];
  private main: Shown | null = null;
  private ghosts: Shown[] = [];
  private stageMesh: StageMesh | null = null;
  private frame = 0;
  private last = 0;
  private acc = 0;
  private endWait = 0;
  private resizeObserver: ResizeObserver;
  private focus = new THREE.Vector3();
  /** 再生速度(1 = 実時間、0 = 止める) */
  speed = 1;
  /** カメラがキャラを追いかけるか */
  follow = true;
  /** エピソードが終わったときに呼ばれる(次のエピソードを渡すのに使う) */
  onEpisodeEnd: (() => void) | null = null;
  /** 毎フレーム呼ばれる(HUDの更新用) */
  onFrame: ((episode: Episode) => void) | null = null;
  /** 終了後、次へ進むまでの待ち時間 [s] */
  endPause = 1.0;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.scene.background = new THREE.Color(0x1d2330);
    this.scene.fog = new THREE.Fog(0x1d2330, 25, 60);
    this.camera.position.set(4, 5, 7);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    this.controls.maxDistance = 40;
    this.controls.update();
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(5, 10, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    for (const k of ['left', 'bottom'] as const) sun.shadow.camera[k] = -10;
    for (const k of ['right', 'top'] as const) sun.shadow.camera[k] = 10;
    this.scene.add(sun, sun.target);

    const size = MOVE_TASK.groundHalfSize * 2;
    this.floor = new THREE.Group();
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ color: 0x3a4152 }));
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.floor.add(plane, new THREE.GridHelper(size, size, 0x556070, 0x465060));
    this.scene.add(this.floor);

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
  setEpisodes(main: Episode, ghosts: Episode[] = []): void {
    this.clear();
    const twoTeams = main.fighters.length === 2;
    this.main = {
      episode: main,
      meshes: main.fighters.map((f, i) => buildCreatureMesh(f.creature, twoTeams ? { team: i } : {})),
    };
    this.ghosts = ghosts.map((episode) => ({
      episode,
      meshes: episode.fighters.slice(0, 1).map((f) => buildCreatureMesh(f.creature, { ghost: true })),
    }));
    for (const s of [this.main, ...this.ghosts]) for (const m of s.meshes) this.scene.add(m.root);

    this.floor.visible = !main.stage;
    if (main.stage) {
      this.stageMesh = new StageMesh(main.stage);
      this.scene.add(this.stageMesh.root);
    }
    this.targetMarker.visible = !!main.target;
    this.trailPoints = [];
    this.trail.geometry.setFromPoints([]);
    this.acc = 0;
    this.endWait = 0;
    this.sync();

    // カメラの注視点:ステージなら中心、平地ならキャラと目標の中間
    const p = main.fighters[0].position();
    if (main.stage) this.focus.set(0, 0, 0);
    else if (main.target) this.focus.set((p.x + main.target.x) / 2, 0.3, (p.z + main.target.z) / 2);
    else this.focus.set(p.x, 0.3, p.z);
    this.moveFocus(this.focus, true);
  }

  /** 何も表示しない状態にする(表示できるエピソードがないとき) */
  showNothing(): void {
    this.clear();
    this.targetMarker.visible = false;
    this.floor.visible = true;
    this.trailPoints = [];
    this.trail.geometry.setFromPoints([]);
  }

  get currentEpisode(): Episode | null {
    return this.main?.episode ?? null;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.clear();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    this.controls.dispose();
    this.renderer.dispose();
  }

  private clear(): void {
    for (const s of [this.main, ...this.ghosts]) {
      if (!s) continue;
      for (const m of s.meshes) {
        this.scene.remove(m.root);
        m.dispose();
      }
      s.episode.free();
    }
    this.main = null;
    this.ghosts = [];
    if (this.stageMesh) {
      this.scene.remove(this.stageMesh.root);
      this.stageMesh.dispose();
      this.stageMesh = null;
    }
  }

  private sync(): void {
    for (const s of [this.main, ...this.ghosts]) {
      if (!s) continue;
      s.meshes.forEach((m, i) => syncCreatureMesh(s.episode.fighters[i].creature, m));
    }
    this.stageMesh?.update();
    const t = this.main?.episode.target;
    if (t) this.targetMarker.position.set(t.x, 0, t.z);
  }

  /** 注視点を動かす。カメラも同じだけ平行移動して、見る角度を保つ */
  private moveFocus(p: THREE.Vector3, jump: boolean): void {
    const target = this.controls.target;
    const next = jump ? p.clone() : target.clone().lerp(p, 0.04);
    const delta = next.clone().sub(target);
    target.copy(next);
    this.camera.position.add(delta);
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
    const visible = this.canvas.clientWidth > 0 && this.speed > 0;
    const main = this.main;
    if (main && visible) {
      const ep = main.episode;
      if (!ep.done) {
        this.acc += elapsed * this.speed;
        while (this.acc >= PHYSICS.dt && !ep.done) {
          ep.advance();
          for (const g of this.ghosts) g.episode.advance();
          this.acc -= PHYSICS.dt;
        }
        if (!ep.stage && ep.fighters.length === 1) {
          const p = ep.fighters[0].position();
          this.trailPoints.push(new THREE.Vector3(p.x, 0.02, p.z));
          this.trail.geometry.setFromPoints(this.trailPoints);
        }
      } else {
        this.endWait += elapsed;
        if (this.endWait > this.endPause) {
          this.endWait = 0;
          this.onEpisodeEnd?.();
        }
      }
      if (this.main) {
        this.sync();
        this.onFrame?.(this.main.episode);
        if (this.follow && this.main.episode.fighters.length === 1 && !this.main.episode.fighters[0].out) {
          const p = this.main.episode.fighters[0].position();
          if (Number.isFinite(p.x)) this.moveFocus(new THREE.Vector3(p.x, Math.max(0, p.y * 0.5), p.z), false);
        }
      }
    }
    if (visible) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }
    this.frame = requestAnimationFrame(this.loop);
  };
}
