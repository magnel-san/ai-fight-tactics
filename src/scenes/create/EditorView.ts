// キャラクリエイト画面の3D表示と、マウスによる操作。
// 設計図を物理なしでそのまま格子に並べて表示する(関節はすべて0°の姿勢)。
// 左クリックで面に配置、右ドラッグでカメラ回転、ホイールでズーム。
// 置く面は格子(立方体)で決めるので、当たり判定は見えない立方体で行い、見た目だけをブロックの形(球・円柱)にする。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BlockGeometries, gripMaterial, gripOverlay, orientBlockMesh, windArrow, windArrowGeometry } from '../../render/blockShapes';
import { CREATURE, type BlockType } from '../../core/config';
import {
  AXIS_DIR,
  blockPositions,
  centerOfMass,
  FACE_DIR,
  pistonDirection,
  shapeOf,
  type BlockSpec,
  type Blueprint,
  type Face,
  type Vec3i,
} from '../../core/creature/blueprint';
import { BLOCK_COLORS } from '../../render/creatureMesh';
import { guardContext, type ContextGuard } from '../../render/webglContext';

export interface Placement {
  /** 置かれる格子座標(左右対称なら2つ) */
  cells: Vec3i[];
  /** 置かれるブロック(cells と同じ並び。置けないときは省略) */
  blocks?: BlockSpec[];
  ok: boolean;
}

export interface EditorHandlers {
  /** 親の面にブロックを置いたらどうなるか(置く前の半透明表示に使う) */
  getPlacement(parent: number, face: Face): Placement;
  onPlace(parent: number, face: Face): void;
  /** マウスの下にあるブロックが変わった */
  onHover(id: number | null): void;
  /** 右クリック(ドラッグしない)でブロックを選んだ。何もないところなら null */
  onSelect(id: number | null): void;
}

const SIZE = CREATURE.blockSize;
/** クリックとドラッグを区別するしきい値 [px] */
const CLICK_TOLERANCE = 5;

function faceFromNormal(n: THREE.Vector3): Face {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ax >= ay && ax >= az) return n.x > 0 ? '+x' : '-x';
  if (ay >= az) return n.y > 0 ? '+y' : '-y';
  return n.z > 0 ? '+z' : '-z';
}

export class EditorView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private blocksGroup = new THREE.Group();
  private ghostGroup = new THREE.Group();
  private hoverOutline: THREE.LineSegments;
  /** 選択中のブロックの枠(黄色) */
  private selectOutline: THREE.LineSegments;
  private selected: number | null = null;
  private mirrorPlane: THREE.Mesh;
  private comMarker: THREE.Mesh;
  private grid: THREE.GridHelper;
  /** 床に置く「正面」の矢印。コアの正面マークがブロックに隠れても向きが分かるようにする */
  private frontArrow: THREE.Mesh;
  /** 当たり判定用の見えない立方体 */
  private blockGeometry = new RoundedBoxGeometry(SIZE * 0.98, SIZE * 0.98, SIZE * 0.98, 2, CREATURE.blockRoundness);
  private pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
  /** 見た目の形 */
  private shapes = new BlockGeometries(SIZE * 0.98);
  private gripMat = gripMaterial();
  private arrowGeometry = windArrowGeometry(SIZE);
  private arrowMaterial = new THREE.MeshStandardMaterial({ color: 0xe0f7fa, transparent: true, opacity: 0.85 });
  private axisGeometry = new THREE.CylinderGeometry(0.025, 0.025, SIZE * 1.3, 8);
  private axisMaterial = new THREE.MeshBasicMaterial({ color: 0x0b3954 });
  /** ピストンの伸びる向きの印 */
  private pistonMaterial = new THREE.MeshBasicMaterial({ color: 0x5a3a12 });
  private frontGeometry = new THREE.BoxGeometry(SIZE * 0.5, SIZE * 0.2, 0.02);
  private frontMaterial = new THREE.MeshBasicMaterial({ color: 0x222222 });
  private materials = new Map<BlockType, THREE.MeshStandardMaterial>();
  private disposables: { dispose(): void }[] = [];
  private blockMeshes: THREE.Mesh[] = [];
  private blueprint: Blueprint = { blocks: [] };
  private context: ContextGuard;
  private ghostType: BlockType = 'base';
  private hovered: { id: number; face: Face } | null = null;
  private downAt: { x: number; y: number } | null = null;
  private rightDownAt: { x: number; y: number } | null = null;
  /** 最後のマウス位置(キャンバス外なら null)。設計図が変わったときの再判定に使う */
  private lastPointer: { clientX: number; clientY: number } | null = null;
  private frame = 0;
  private resizeObserver: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private handlers: EditorHandlers,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    // 描画領域が失われても、復旧したら作り直して描き直す
    this.context = guardContext(this.renderer, canvas, () => {
      this.resize();
      this.setBlueprint(this.blueprint);
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x1d2330);
    this.camera.position.set(2.0, 1.6, 2.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 12;
    // カメラを注視点に向けておく(描画ループが回る前でもマウス判定が正しくなるように)
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.3));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);

    this.grid = new THREE.GridHelper(8, 20, 0x556070, 0x3a4352);
    this.scene.add(this.grid, this.blocksGroup, this.ghostGroup);

    const outlineGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(SIZE * 1.02, SIZE * 1.02, SIZE * 1.02));
    const outlineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    this.hoverOutline = new THREE.LineSegments(outlineGeometry, outlineMaterial);
    this.hoverOutline.visible = false;
    this.scene.add(this.hoverOutline);
    const selectMaterial = new THREE.LineBasicMaterial({ color: 0xf2c94c, depthTest: false });
    this.selectOutline = new THREE.LineSegments(outlineGeometry, selectMaterial);
    this.selectOutline.renderOrder = 11;
    this.selectOutline.visible = false;
    this.scene.add(this.selectOutline);
    this.disposables.push(selectMaterial);

    const planeGeometry = new THREE.PlaneGeometry(6, 6);
    const planeMaterial = new THREE.MeshBasicMaterial({
      color: 0x56ccf2,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.mirrorPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    this.mirrorPlane.rotation.y = Math.PI / 2;
    this.mirrorPlane.raycast = () => {};
    this.scene.add(this.mirrorPlane);

    const comGeometry = new THREE.SphereGeometry(0.05, 16, 12);
    const comMaterial = new THREE.MeshBasicMaterial({ color: 0xff4fd8, depthTest: false });
    this.comMarker = new THREE.Mesh(comGeometry, comMaterial);
    this.comMarker.renderOrder = 10;
    this.comMarker.raycast = () => {};
    this.scene.add(this.comMarker);

    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.25);
    arrowShape.lineTo(0.2, 0);
    arrowShape.lineTo(0.07, 0);
    arrowShape.lineTo(0.07, -0.2);
    arrowShape.lineTo(-0.07, -0.2);
    arrowShape.lineTo(-0.07, 0);
    arrowShape.lineTo(-0.2, 0);
    arrowShape.closePath();
    const arrowGeometry = new THREE.ShapeGeometry(arrowShape);
    // 形は xy 平面で +y 向きなので、床(xz 平面)に寝かせて +z を向かせる
    arrowGeometry.rotateX(Math.PI / 2);
    const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0xf2c94c, side: THREE.DoubleSide });
    this.frontArrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
    this.frontArrow.raycast = () => {};
    this.scene.add(this.frontArrow);

    this.disposables.push(
      arrowGeometry,
      arrowMaterial,
      this.blockGeometry,
      this.axisGeometry,
      this.axisMaterial,
      this.pistonMaterial,
      this.frontGeometry,
      this.frontMaterial,
      outlineGeometry,
      outlineMaterial,
      planeGeometry,
      planeMaterial,
      comGeometry,
      comMaterial,
    );

    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = requestAnimationFrame(this.loop);
  }

  setBlueprint(bp: Blueprint): void {
    this.blueprint = bp;
    this.blocksGroup.clear();
    this.blockMeshes = [];

    const pos = blockPositions(bp);
    bp.blocks.forEach((b, i) => {
      const mesh = new THREE.Mesh(this.blockGeometry, this.pickMaterial);
      mesh.position.set(pos[i][0] * SIZE, pos[i][1] * SIZE, pos[i][2] * SIZE);
      mesh.userData.blockId = i;
      this.blocksGroup.add(mesh);
      this.blockMeshes.push(mesh);
      mesh.add(this.shapeMesh(b));
      if (b.type === 'joint') mesh.add(this.axisIndicator(AXIS_DIR[b.axis!]));
      if (b.type === 'piston') {
        // 伸びる向きに、ブロックから少し突き出た棒を出す
        const dir = FACE_DIR[pistonDirection(b)];
        const rod = new THREE.Mesh(this.axisGeometry, this.pistonMaterial);
        rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir));
        rod.position.set(dir[0] * SIZE * 0.3, dir[1] * SIZE * 0.3, dir[2] * SIZE * 0.3);
        rod.raycast = () => {};
        mesh.add(rod);
      }
      if (b.type === 'wind') mesh.add(windArrow(FACE_DIR[pistonDirection(b)], SIZE, this.arrowGeometry, this.arrowMaterial));
      if (b.type === 'core') mesh.add(this.frontMark());
    });

    const com = centerOfMass(bp);
    this.comMarker.position.set(com[0], com[1], com[2]);
    // 床の目安は最も低いブロックの底面に合わせる
    const minY = Math.min(...pos.map((p) => p[1]));
    this.grid.position.y = (minY - 0.5) * SIZE;
    const maxZ = Math.max(...pos.map((p) => p[2]));
    this.frontArrow.position.set(0, this.grid.position.y + 0.005, (maxZ + 1.5) * SIZE);
    // ブロックが増減するとマウスの下のブロックも変わるので、マウスを動かさなくても判定し直す
    this.updateHovered(this.lastPointer ? this.pick(this.lastPointer) : null);
    this.updateSelectOutline();
    this.updateGhost();
  }

  /** 選択中のブロックを表示する(null で選択なし) */
  setSelected(id: number | null): void {
    this.selected = id;
    this.updateSelectOutline();
  }

  private updateSelectOutline(): void {
    const id = this.selected;
    if (id === null || !this.blueprint.blocks[id]) {
      this.selectOutline.visible = false;
      return;
    }
    const p = blockPositions(this.blueprint)[id];
    this.selectOutline.position.set(p[0] * SIZE, p[1] * SIZE, p[2] * SIZE);
    this.selectOutline.visible = true;
  }

  setSymmetric(on: boolean): void {
    this.mirrorPlane.visible = on;
  }

  setGhostType(type: BlockType): void {
    this.ghostType = type;
    this.refreshHover();
  }

  /** 設計図や設定が変わったときに、マウス位置のプレビューを作り直す */
  refreshHover(): void {
    this.updateGhost();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.clearGhost();
    for (const d of this.disposables) d.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.shapes.dispose();
    this.gripMat.dispose();
    this.arrowGeometry.dispose();
    this.arrowMaterial.dispose();
    this.pickMaterial.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.context.release();
  }

  private material(type: BlockType): THREE.MeshStandardMaterial {
    let m = this.materials.get(type);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: BLOCK_COLORS[type], roughness: 0.6 });
      this.materials.set(type, m);
    }
    return m;
  }

  /** ブロックの見た目(形・色・摩擦オンの網目)。当たり判定はしない */
  private shapeMesh(b: BlockSpec): THREE.Mesh {
    const geometry = this.shapes.get(shapeOf(b));
    const mesh = new THREE.Mesh(geometry, this.material(b.type));
    orientBlockMesh(mesh, b);
    mesh.raycast = () => {};
    if (b.grip) {
      const g = gripOverlay(geometry, this.gripMat);
      g.raycast = () => {};
      mesh.add(g);
    }
    return mesh;
  }

  private axisIndicator(dir: Vec3i): THREE.Mesh {
    const mesh = new THREE.Mesh(this.axisGeometry, this.axisMaterial);
    // シリンダーは y 軸方向なので、関節の軸に向ける
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...dir));
    mesh.raycast = () => {};
    return mesh;
  }

  private frontMark(): THREE.Mesh {
    const mesh = new THREE.Mesh(this.frontGeometry, this.frontMaterial);
    mesh.position.set(0, SIZE * 0.15, SIZE * 0.5);
    mesh.raycast = () => {};
    return mesh;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    // 非表示(タブ切り替え中)は描画しない
    if (this.canvas.clientWidth > 0) {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }
    this.frame = requestAnimationFrame(this.loop);
  };

  private pick(e: { clientX: number; clientY: number }): { id: number; face: Face } | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    // ワールド行列は通常は描画時に更新される。追加直後のブロックや、描画が止まっている間
    // (タブが裏にあるときなど)でも正しく判定できるよう、ここで更新する
    this.camera.updateMatrixWorld();
    this.blocksGroup.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.blockMeshes, false)[0];
    if (!hit || !hit.face) return null;
    // ブロックは回転させずに置いているので、ジオメトリの法線がそのままコア基準の向きになる
    return { id: hit.object.userData.blockId as number, face: faceFromNormal(hit.face.normal) };
  }

  /** マウスの下のブロックを更新する。変わったら true */
  private updateHovered(next: { id: number; face: Face } | null): boolean {
    const prevId = this.hovered?.id ?? null;
    const changed = next?.id !== this.hovered?.id || next?.face !== this.hovered?.face;
    this.hovered = next;
    if ((next?.id ?? null) !== prevId) this.handlers.onHover(next?.id ?? null);
    return changed;
  }

  private onPointerMove = (e: PointerEvent) => {
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY };
    if (this.updateHovered(this.pick(e))) this.updateGhost();
  };

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY };
    if (e.button === 2) this.rightDownAt = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    // 右ボタン:ドラッグしていなければ選択(ドラッグはカメラの回転)
    if (e.button === 2 && this.rightDownAt) {
      const moved = Math.hypot(e.clientX - this.rightDownAt.x, e.clientY - this.rightDownAt.y);
      this.rightDownAt = null;
      if (moved <= CLICK_TOLERANCE) this.handlers.onSelect(this.pick(e)?.id ?? null);
      return;
    }
    if (e.button !== 0 || !this.downAt) return;
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    this.downAt = null;
    if (moved > CLICK_TOLERANCE) return;
    const target = this.pick(e);
    if (target) this.handlers.onPlace(target.id, target.face);
  };

  private onPointerLeave = () => {
    this.lastPointer = null;
    this.updateHovered(null);
    this.updateGhost();
  };

  private onContextMenu = (e: Event) => e.preventDefault();

  private clearGhost(): void {
    for (const child of this.ghostGroup.children) {
      const mesh = child as THREE.Mesh;
      (mesh.material as THREE.Material).dispose();
    }
    this.ghostGroup.clear();
  }

  private updateGhost(): void {
    this.clearGhost();
    const h = this.hovered;
    if (!h || !this.blueprint.blocks[h.id]) {
      this.hoverOutline.visible = false;
      return;
    }
    const pos = blockPositions(this.blueprint)[h.id];
    this.hoverOutline.visible = true;
    this.hoverOutline.position.set(pos[0] * SIZE, pos[1] * SIZE, pos[2] * SIZE);

    const placement = this.handlers.getPlacement(h.id, h.face);
    for (const cell of placement.cells) {
      const material = new THREE.MeshStandardMaterial({
        color: placement.ok ? BLOCK_COLORS[this.ghostType] : 0xff3b3b,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const spec = placement.blocks?.[placement.cells.indexOf(cell)];
      const ghost = new THREE.Mesh(spec ? this.shapes.get(shapeOf(spec)) : this.blockGeometry, material);
      ghost.position.set(cell[0] * SIZE, cell[1] * SIZE, cell[2] * SIZE);
      if (spec) orientBlockMesh(ghost, spec);
      ghost.raycast = () => {};
      this.ghostGroup.add(ghost);
    }
  }
}
