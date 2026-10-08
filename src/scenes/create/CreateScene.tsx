// キャラクリエイト画面(仕様書セクション4)
import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCK_OPTIONS, BLOCKS, CREATURE, type BlockShape, type BlockType } from '../../core/config';
import {
  actuatorCount,
  blockPositions,
  centerOfMass,
  oppositeFace,
  pistonDirection,
  shapeOf,
  totalCost,
  type Axis,
  type Blueprint,
  type Face,
} from '../../core/creature/blueprint';
import {
  addBlock,
  addBlockSymmetric,
  blockAt,
  cellOnFace,
  emptyBlueprint,
  mirrorCell,
  removeBlock,
  removeBlockSymmetric,
  setJointAxis,
  setJointAxisSymmetric,
  setBlockLook,
  setBlockLookSymmetric,
  setPistonDir,
  setPistonDirSymmetric,
  type EditResult,
} from '../../core/creature/edit';
import { QUADRUPED } from '../../core/creature/samples';
import { BLOCK_COLORS } from '../../render/creatureMesh';
import { EditorView } from './EditorView';

export const PALETTE: { type: Exclude<BlockType, 'core'>; label: string; note: string }[] = [
  { type: 'base', label: '基礎', note: '標準的な重さ・摩擦・反発のブロック' },
  { type: 'joint', label: '関節', note: '脳で動かせるヒンジ。180°(角度を決める)か360°(回り続ける。車輪に)を選べる' },
  { type: 'piston', label: 'ピストン', note: '1マス伸び縮みする(ジャンプや押し出しに)' },
  { type: 'bouncy', label: '弾力', note: 'ばねで伸び縮みし、当たった相手を弾き飛ばす' },
  { type: 'cloud', label: '雲', note: 'とても軽い。体を大きくしても重くならない(押されると飛ばされやすい)' },
  { type: 'wind', label: '風', note: '扇風機のように、吹く向きと反対向きに押す。下向きに吹くと床の近くで体を持ち上げる(たくさん付けると浮く)' },
  { type: 'sensor', label: 'センサー', note: 'トレーニング中に地面に触れると減点(倒れにくい動きを学ばせる。バトルでは普通のブロック)' },
];

/** 円柱の軸の向き('auto' は自動:関節は回転軸、ピストン・風は向き、ほかは付けた面の向き) */
const CYL_AXES: { axis: Axis | 'auto'; label: string }[] = [
  { axis: 'auto', label: '自動' },
  { axis: 'x', label: '左右' },
  { axis: 'y', label: '上下' },
  { axis: 'z', label: '前後' },
];

export const SHAPE_LABELS: { shape: BlockShape; label: string; note: string }[] = [
  { shape: 'cube', label: '立方体', note: '安定して置ける' },
  { shape: 'sphere', label: '球', note: '転がりやすく、引っかかりにくい' },
  { shape: 'cylinder', label: '円柱', note: '関節なら回転軸の向き(車輪)、ピストンなら伸びる向き、ほかは付けた面の向きが軸になる' },
];

const AXES: { axis: Axis; label: string }[] = [
  { axis: 'x', label: 'X(左右)' },
  { axis: 'y', label: 'Y(上下)' },
  { axis: 'z', label: 'Z(前後)' },
];

const NEXT_AXIS: Record<Axis, Axis> = { x: 'y', y: 'z', z: 'x' };

/** ピストンの伸びる向き(コアの正面 +z を向いたとき、+x が左) */
const PISTON_DIRS: { dir: Face | 'face'; label: string; note: string }[] = [
  { dir: 'face', label: '付けた面', note: '付けた面の向き(親から離れる向き)に伸びる' },
  { dir: '+y', label: '上', note: '上に伸びる' },
  { dir: '-y', label: '下', note: '下に伸びる(地面を押してジャンプ)' },
  { dir: '+z', label: '前', note: '正面の向きに伸びる(押し出しに)' },
  { dir: '-z', label: '後ろ', note: '後ろに伸びる' },
  { dir: '+x', label: '左', note: '左に伸びる' },
  { dir: '-x', label: '右', note: '右に伸びる' },
];

/** 関節の回り方 */
const SPIN_MODES: { spin: boolean; label: string; note: string }[] = [
  { spin: false, label: '180°(角度)', note: '±90°の範囲で、脳が角度を決める。脚や腕に' },
  { spin: true, label: '360°(回転)', note: '止まらずに回り続け、脳が回る速さと向きを決める。車輪やタイヤに' },
];

const CYL_AXIS_NOTE = '円柱の軸の向き。自動:関節は回転軸(車輪になる)、ピストン・風は向き、ほかは付けた面の向き';
const TIRE_NOTE =
  '円柱にした関節の半径を大きくして、タイヤにする。回転軸に垂直な4方向の隣には、親以外のブロックを置けない(重ならないように)。関節を360°にして、回転軸と円柱の向きをそろえると転がって進む';

const dirLabel = (f: Face) => PISTON_DIRS.find((d) => d.dir === f)?.label ?? f;

/** 取り消しの最大段数 */
const HISTORY_LIMIT = 100;

/** キー操作の一覧(画面の「キー操作」とヘルプに出す) */
const KEY_HELP: { keys: string; text: string }[] = [
  { keys: '左クリック', text: '面にブロックを置く' },
  { keys: '右クリック', text: 'ブロックを選択(Esc で解除)' },
  { keys: '右ドラッグ / ホイール', text: '回転 / ズーム(中ボタンのドラッグで移動)' },
  { keys: `1〜${PALETTE.length}`, text: '置くブロックの種類' },
  { keys: 'Q', text: '形を切り替え(立方体 → 球 → 円柱)' },
  { keys: 'C', text: '円柱の向きを切り替え' },
  { keys: 'G', text: '摩擦オン / オフ' },
  { keys: 'A', text: '関節の回転軸を切り替え(置くとき)' },
  { keys: 'S', text: '関節の 180° / 360° を切り替え' },
  { keys: 'T', text: 'タイヤモード(円柱の関節)' },
  { keys: 'D', text: 'ピストン・風の向きを切り替え' },
  { keys: 'M', text: '左右対称モード オン / オフ' },
  { keys: 'E', text: 'スポイト:マウスの下(または選択中)のブロックの設定をまねる' },
  { keys: 'R', text: '選択中(またはマウスの下)の関節の軸を回す' },
  { keys: 'Delete', text: '選択中(またはマウスの下)のブロックとその先を削除' },
  { keys: 'Ctrl+Z / Ctrl+Y', text: '取り消し / やり直し' },
  { keys: 'F', text: 'カメラを元の位置に戻す' },
  { keys: 'H', text: 'この一覧を表示 / 非表示' },
];

const SHAPE_ORDER: BlockShape[] = ['cube', 'sphere', 'cylinder'];
const cycle = <T,>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length];

/** 置くブロックの設定(ブラウザに保存して、次に開いたときも同じ設定で始める) */
interface Placement {
  type: Exclude<BlockType, 'core'>;
  axis: Axis;
  pistonDir: Face | 'face';
  symmetric: boolean;
  shape: BlockShape;
  grip: boolean;
  cylAxis: Axis | 'auto';
  tire: boolean;
  spin: boolean;
}
const PLACEMENT_KEY = 'create-placement';
const DEFAULT_PLACEMENT: Placement = {
  type: 'base',
  axis: 'x',
  pistonDir: 'face',
  symmetric: true,
  shape: 'cube',
  grip: false,
  cylAxis: 'auto',
  tire: false,
  spin: false,
};
function loadPlacement(): Placement {
  try {
    const raw = localStorage.getItem(PLACEMENT_KEY);
    if (!raw) return DEFAULT_PLACEMENT;
    const p = { ...DEFAULT_PLACEMENT, ...(JSON.parse(raw) as Partial<Placement>) };
    // 保存した値が今の選択肢にないときは、初期値に戻す
    if (!PALETTE.some((x) => x.type === p.type)) p.type = DEFAULT_PLACEMENT.type;
    if (!SHAPE_ORDER.includes(p.shape)) p.shape = DEFAULT_PLACEMENT.shape;
    if (!AXES.some((a) => a.axis === p.axis)) p.axis = DEFAULT_PLACEMENT.axis;
    if (!CYL_AXES.some((a) => a.axis === p.cylAxis)) p.cylAxis = DEFAULT_PLACEMENT.cylAxis;
    if (!PISTON_DIRS.some((d) => d.dir === p.pistonDir)) p.pistonDir = DEFAULT_PLACEMENT.pistonDir;
    return p;
  } catch {
    return DEFAULT_PLACEMENT;
  }
}
function savePlacement(p: Placement): void {
  try {
    localStorage.setItem(PLACEMENT_KEY, JSON.stringify(p));
  } catch {
    // 保存できなくても(プライベートブラウズなど)、そのまま使える
  }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

interface Props {
  blueprint: Blueprint;
  onChange(bp: Blueprint): void;
  /** 表示中か。非表示のときはキーボード操作を受け付けない */
  active: boolean;
}

export function CreateScene({ blueprint, onChange, active }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [initial] = useState(loadPlacement);
  const [type, setType] = useState<Exclude<BlockType, 'core'>>(initial.type);
  const [axis, setAxis] = useState<Axis>(initial.axis);
  /** 置くピストンの伸びる向き('face' = 付けた面の向き) */
  const [pistonDir, setPistonDirChoice] = useState<Face | 'face'>(initial.pistonDir);
  const [symmetric, setSymmetric] = useState(initial.symmetric);
  /** 置くブロックの形と摩擦 */
  const [shape, setShape] = useState<BlockShape>(initial.shape);
  const [grip, setGrip] = useState(initial.grip);
  /** 置く円柱の軸の向きと、タイヤモード(円柱の関節だけ) */
  const [cylAxis, setCylAxis] = useState<Axis | 'auto'>(initial.cylAxis);
  const [tire, setTire] = useState(initial.tire);
  /** 置く関節の回り方(false = 180°、true = 360°) */
  const [spin, setSpin] = useState(initial.spin);
  /** キー操作の一覧を表示するか */
  const [showKeys, setShowKeys] = useState(false);
  /** キーで設定を変えたときに、画面に一瞬出す知らせ */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1400);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  // 置く設定はブラウザに保存する
  useEffect(
    () => savePlacement({ type, axis, pistonDir, symmetric, shape, grip, cylAxis, tire, spin }),
    [type, axis, pistonDir, symmetric, shape, grip, cylAxis, tire, spin],
  );
  const [hovered, setHovered] = useState<number | null>(null);
  /** 右クリックで選んだブロック */
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const undoStack = useRef<Blueprint[]>([]);
  const redoStack = useRef<Blueprint[]>([]);
  const [, forceRender] = useState(0);

  // イベントハンドラから常に最新の値を読むための参照
  /** 置くブロックの見た目(形・摩擦・円柱の向き・タイヤ) */
  const look = {
    shape,
    grip,
    cylAxis: cylAxis === 'auto' ? null : cylAxis,
    tire: shape === 'cylinder' && type === 'joint' && tire,
    spin: type === 'joint' && spin,
  };
  const latest = useRef({ blueprint, type, axis, symmetric, hovered, selected, pistonDir, look, shape, cylAxis, spin, grip, tire });
  latest.current = { blueprint, type, axis, symmetric, hovered, selected, pistonDir, look, shape, cylAxis, spin, grip, tire };

  const commit = useCallback(
    (result: EditResult) => {
      if (!result.ok) {
        setMessage({ text: result.errors[0], error: true });
        return;
      }
      undoStack.current.push(latest.current.blueprint);
      if (undoStack.current.length > HISTORY_LIMIT) undoStack.current.shift();
      redoStack.current = [];
      onChange(result.blueprint);
      setMessage(result.notes.length > 0 ? { text: result.notes[0], error: false } : null);
    },
    [onChange],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(latest.current.blueprint);
    onChange(prev);
    setMessage(null);
    forceRender((n) => n + 1);
  }, [onChange]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(latest.current.blueprint);
    onChange(next);
    setMessage(null);
    forceRender((n) => n + 1);
  }, [onChange]);

  // 3D表示の作成(1回だけ)
  useEffect(() => {
    const view = new EditorView(canvasRef.current!, {
      getPlacement(parent, face) {
        const { blueprint: bp, type: t, axis: a, symmetric: sym, pistonDir: pd, look } = latest.current;
        const dir = pd === 'face' ? undefined : pd;
        const result = sym ? addBlockSymmetric(bp, parent, face, t, a, dir, look) : addBlock(bp, parent, face, t, a, dir, look);
        const target = cellOnFace(bp, parent, face);
        if (!result.ok) return { cells: [target], ok: false };
        // 追加された分のブロックの位置と形を表示する
        const pos = blockPositions(result.blueprint);
        return { cells: pos.slice(bp.blocks.length), blocks: result.blueprint.blocks.slice(bp.blocks.length), ok: true };
      },
      onPlace(parent, face) {
        const { blueprint: bp, type: t, axis: a, symmetric: sym, pistonDir: pd, look } = latest.current;
        const dir = pd === 'face' ? undefined : pd;
        commit(sym ? addBlockSymmetric(bp, parent, face, t, a, dir, look) : addBlock(bp, parent, face, t, a, dir, look));
      },
      onHover: setHovered,
      onSelect: setSelected,
    });
    viewRef.current = view;
    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, [commit]);

  useEffect(() => viewRef.current?.setBlueprint(blueprint), [blueprint]);
  useEffect(() => viewRef.current?.setSelected(selected), [selected]);
  // ブロックが増減するとIDが詰め直されるので、選択を解除する
  useEffect(() => setSelected(null), [blueprint.blocks.length]);
  useEffect(() => viewRef.current?.setSymmetric(symmetric), [symmetric]);
  useEffect(() => viewRef.current?.setGhostType(type), [type]);
  useEffect(() => viewRef.current?.refreshHover(), [axis, symmetric, pistonDir, shape, grip, cylAxis, tire, spin, type]);

  // キーボード操作
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const cur = latest.current;
      const { blueprint: bp, symmetric: sym, hovered, selected: sel } = cur;
      // 操作の対象は、選択中のブロック(なければマウスの下のブロック)
      const h = sel ?? hovered;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (h === null) return;
        e.preventDefault();
        commit(sym ? removeBlockSymmetric(bp, h) : removeBlock(bp, h));
        setSelected(null);
      } else if (e.key === 'Escape') {
        setSelected(null);
      } else if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      } else if (key === 'r' && h !== null && bp.blocks[h]?.type === 'joint') {
        const next = NEXT_AXIS[bp.blocks[h].axis!];
        commit(sym ? setJointAxisSymmetric(bp, h, next) : setJointAxis(bp, h, next));
        notify(`関節の軸:${next.toUpperCase()}`);
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= PALETTE.length) {
        const p = PALETTE[Number(e.key) - 1];
        setType(p.type);
        notify(`ブロック:${p.label}`);
      } else if (key === 'q') {
        const next = cycle(SHAPE_ORDER, cur.shape);
        setShape(next);
        notify(`形:${SHAPE_LABELS.find((x) => x.shape === next)!.label}`);
      } else if (key === 'c') {
        const next = cycle(
          CYL_AXES.map((x) => x.axis),
          cur.cylAxis,
        );
        setCylAxis(next);
        setShape('cylinder');
        notify(`円柱の向き:${CYL_AXES.find((x) => x.axis === next)!.label}`);
      } else if (key === 'g') {
        setGrip(!cur.grip);
        notify(`摩擦:${!cur.grip ? 'オン' : 'オフ'}`);
      } else if (key === 'a') {
        const next = NEXT_AXIS[cur.axis];
        setAxis(next);
        notify(`置く関節の回転軸:${AXES.find((x) => x.axis === next)!.label}`);
      } else if (key === 's') {
        setSpin(!cur.spin);
        notify(`関節の回り方:${!cur.spin ? '360°(回転)' : '180°(角度)'}`);
      } else if (key === 't') {
        setTire(!cur.tire);
        notify(`タイヤモード:${!cur.tire ? 'オン(円柱の関節に付く)' : 'オフ'}`);
      } else if (key === 'd') {
        const next = cycle(
          PISTON_DIRS.map((d) => d.dir),
          cur.pistonDir,
        );
        setPistonDirChoice(next);
        notify(`ピストン・風の向き:${PISTON_DIRS.find((d) => d.dir === next)!.label}`);
      } else if (key === 'm') {
        setSymmetric(!sym);
        notify(`左右対称モード:${!sym ? 'オン' : 'オフ'}`);
      } else if (key === 'e') {
        // スポイト:ブロックの設定をまねる
        const b = h !== null ? bp.blocks[h] : undefined;
        if (!b || b.type === 'core') {
          notify('まねるブロックにマウスを合わせてください');
          return;
        }
        setType(b.type);
        setShape(shapeOf(b));
        setGrip(!!b.grip);
        setCylAxis(b.cylAxis ?? 'auto');
        setTire(!!b.tire);
        if (b.type === 'joint') {
          setAxis(b.axis!);
          setSpin(!!b.spin);
        }
        if (b.type === 'piston' || b.type === 'wind') setPistonDirChoice(pistonDirection(b));
        notify(`スポイト:${PALETTE.find((p) => p.type === b.type)?.label}の設定をまねました`);
      } else if (key === 'f') {
        viewRef.current?.resetCamera();
      } else if (key === 'h' || e.key === '?') {
        setShowKeys((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, commit, undo, redo, notify]);

  const replaceAll = (bp: Blueprint) => commit({ ok: true, blueprint: bp, notes: [] });

  const cost = totalCost(blueprint);
  const joints = actuatorCount(blueprint);
  const com = centerOfMass(blueprint);
  const hoveredBlock = hovered !== null ? blueprint.blocks[hovered] : undefined;
  const selectedBlock = selected !== null ? blueprint.blocks[selected] : undefined;
  const removeSelected = () => {
    if (selected === null) return;
    commit(symmetric ? removeBlockSymmetric(blueprint, selected) : removeBlock(blueprint, selected));
    setSelected(null);
  };
  const isSymmetricBody = blockPositions(blueprint).every((p) => blockAt(blueprint, mirrorCell(p)) !== undefined);

  return (
    <div className="create">
      <aside className="panel">
        <h2>
          置くブロック <kbd>1〜{PALETTE.length}</kbd>
        </h2>
        <div className="palette">
          {PALETTE.map((p, i) => (
            <button key={p.type} className={`block-button${type === p.type ? ' selected' : ''}`} onClick={() => setType(p.type)} title={p.note}>
              <span className="swatch" style={{ background: hex(BLOCK_COLORS[p.type]) }} />
              <span className="name">
                {i + 1}. {p.label}
              </span>
              <span className="cost">コスト {BLOCKS[p.type].cost}</span>
            </button>
          ))}
        </div>

        <h3>
          形 <kbd>Q</kbd>
        </h3>
        <div className="segmented">
          {SHAPE_LABELS.map((x) => (
            <button key={x.shape} className={shape === x.shape ? 'selected' : ''} onClick={() => setShape(x.shape)} title={x.note}>
              {x.label}
            </button>
          ))}
        </div>
        {shape === 'cylinder' && (
          <>
            <h3>
              円柱の向き <kbd>C</kbd>
            </h3>
            <div className="segmented">
              {CYL_AXES.map((x) => (
                <button key={x.axis} className={cylAxis === x.axis ? 'selected' : ''} onClick={() => setCylAxis(x.axis)} title={CYL_AXIS_NOTE}>
                  {x.label}
                </button>
              ))}
            </div>
            {type === 'joint' && (
              <label className="toggle" title={TIRE_NOTE}>
                <input type="checkbox" checked={tire} onChange={(e) => setTire(e.target.checked)} />
                タイヤモード(半径{BLOCK_OPTIONS.tireRadiusScale}倍・コスト+{BLOCK_OPTIONS.tireCost}) <kbd>T</kbd>
              </label>
            )}
          </>
        )}
        <label className="toggle" title={`摩擦が大きく、踏ん張れる・滑りにくい(コスト+${BLOCK_OPTIONS.gripCost})`}>
          <input type="checkbox" checked={grip} onChange={(e) => setGrip(e.target.checked)} />
          摩擦オン(コスト+{BLOCK_OPTIONS.gripCost}) <kbd>G</kbd>
        </label>

        {type === 'joint' && (
          <>
            <h3>
              関節の回転軸 <kbd>A</kbd>
            </h3>
            <div className="segmented">
              {AXES.map((a) => (
                <button key={a.axis} className={axis === a.axis ? 'selected' : ''} onClick={() => setAxis(a.axis)}>
                  {a.label}
                </button>
              ))}
            </div>
            <h3>
              関節の回り方 <kbd>S</kbd>
            </h3>
            <div className="segmented">
              {SPIN_MODES.map((m) => (
                <button key={String(m.spin)} className={spin === m.spin ? 'selected' : ''} onClick={() => setSpin(m.spin)} title={m.note}>
                  {m.label}
                </button>
              ))}
            </div>
          </>
        )}

        {(type === 'piston' || type === 'wind') && (
          <>
            <h3>
              {type === 'piston' ? 'ピストンの伸びる向き' : '風の吹く向き'} <kbd>D</kbd>
            </h3>
            <div className="segmented wrap">
              {PISTON_DIRS.map((d) => (
                <button key={d.dir} className={pistonDir === d.dir ? 'selected' : ''} onClick={() => setPistonDirChoice(d.dir)} title={d.note}>
                  {d.label}
                </button>
              ))}
            </div>
            <p className="muted small">
              {type === 'piston'
                ? '付けた面の逆向き(親のブロックに向かう向き)には伸ばせません'
                : '体は風と反対向きに押されます。「下」に吹くと、下に床があるとき体を持ち上げます(床がなければ持ち上がりません)'}
            </p>
          </>
        )}

        <label className="toggle">
          <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
          左右対称モード <kbd>M</kbd>
        </label>

        <h2>選択中のブロック</h2>
        {selectedBlock ? (
          <div className="selected-block">
            <div>
              {selectedBlock.type === 'core' ? 'コア' : PALETTE.find((p) => p.type === selectedBlock.type)?.label}
              {selectedBlock.type === 'joint' && `(軸 ${selectedBlock.axis!.toUpperCase()}・${selectedBlock.spin ? '360°' : '180°'})`}
              {selectedBlock.type === 'piston' && `(${dirLabel(pistonDirection(selectedBlock))}に伸びる)`}
              {selectedBlock.type === 'wind' && `(${dirLabel(pistonDirection(selectedBlock))}に吹く)`}
            </div>
            {(selectedBlock.type === 'piston' || selectedBlock.type === 'wind') && (
              <div className="segmented wrap">
                {PISTON_DIRS.filter((d) => d.dir !== 'face').map((d) => {
                  const dir = d.dir as Face;
                  return (
                    <button
                      key={dir}
                      className={pistonDirection(selectedBlock) === dir ? 'selected' : ''}
                      disabled={selectedBlock.type === 'piston' && dir === oppositeFace(selectedBlock.face!)}
                      onClick={() => commit(symmetric ? setPistonDirSymmetric(blueprint, selected!, dir) : setPistonDir(blueprint, selected!, dir))}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="segmented">
              {SHAPE_LABELS.map((x) => (
                <button
                  key={x.shape}
                  className={shapeOf(selectedBlock) === x.shape ? 'selected' : ''}
                  title={x.note}
                  onClick={() =>
                    commit(symmetric ? setBlockLookSymmetric(blueprint, selected!, { shape: x.shape }) : setBlockLook(blueprint, selected!, { shape: x.shape }))
                  }
                >
                  {x.label}
                </button>
              ))}
            </div>
            {shapeOf(selectedBlock) === 'cylinder' && (
              <>
                <div className="segmented">
                  {CYL_AXES.map((x) => {
                    const lookOf = { cylAxis: x.axis === 'auto' ? null : x.axis };
                    return (
                      <button
                        key={x.axis}
                        className={(selectedBlock.cylAxis ?? 'auto') === x.axis ? 'selected' : ''}
                        title={CYL_AXIS_NOTE}
                        onClick={() => commit(symmetric ? setBlockLookSymmetric(blueprint, selected!, lookOf) : setBlockLook(blueprint, selected!, lookOf))}
                      >
                        円柱:{x.label}
                      </button>
                    );
                  })}
                </div>
                {selectedBlock.type === 'joint' && (
                  <label className="toggle" title={TIRE_NOTE}>
                    <input
                      type="checkbox"
                      checked={!!selectedBlock.tire}
                      onChange={(e) =>
                        commit(
                          symmetric
                            ? setBlockLookSymmetric(blueprint, selected!, { tire: e.target.checked })
                            : setBlockLook(blueprint, selected!, { tire: e.target.checked }),
                        )
                      }
                    />
                    タイヤモード(半径{BLOCK_OPTIONS.tireRadiusScale}倍・コスト+{BLOCK_OPTIONS.tireCost})
                  </label>
                )}
              </>
            )}
            <label className="toggle">
              <input
                type="checkbox"
                checked={!!selectedBlock.grip}
                onChange={(e) =>
                  commit(
                    symmetric
                      ? setBlockLookSymmetric(blueprint, selected!, { grip: e.target.checked })
                      : setBlockLook(blueprint, selected!, { grip: e.target.checked }),
                  )
                }
              />
              摩擦オン(コスト+{BLOCK_OPTIONS.gripCost})
            </label>
            {selectedBlock.type === 'joint' && (
              <>
                <div className="segmented">
                  {AXES.map((a) => (
                    <button
                      key={a.axis}
                      className={selectedBlock.axis === a.axis ? 'selected' : ''}
                      onClick={() => commit(symmetric ? setJointAxisSymmetric(blueprint, selected!, a.axis) : setJointAxis(blueprint, selected!, a.axis))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
                <div className="segmented">
                  {SPIN_MODES.map((m) => (
                    <button
                      key={String(m.spin)}
                      className={!!selectedBlock.spin === m.spin ? 'selected' : ''}
                      title={m.note}
                      onClick={() =>
                        commit(symmetric ? setBlockLookSymmetric(blueprint, selected!, { spin: m.spin }) : setBlockLook(blueprint, selected!, { spin: m.spin }))
                      }
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="row">
              <button
                className="danger"
                onClick={removeSelected}
                disabled={selectedBlock.type === 'core'}
                title="このブロックと、その先につながるブロックを削除します"
              >
                削除{symmetric ? '(左右とも)' : ''}
              </button>
              <button onClick={() => setSelected(null)}>選択を解除</button>
            </div>
          </div>
        ) : (
          <p className="muted small">ブロックを右クリックすると選択できます</p>
        )}

        <h2>ステータス</h2>
        <dl className="stats">
          <dt>コスト</dt>
          <dd className={cost > CREATURE.maxCost ? 'over' : ''}>
            {cost} / {CREATURE.maxCost}
            <meter min={0} max={CREATURE.maxCost} value={cost} />
          </dd>
          <dt>関節・ピストン</dt>
          <dd>
            {joints} / {CREATURE.maxJoints}
          </dd>
          <dt>ブロック</dt>
          <dd>
            {blueprint.blocks.length} / {CREATURE.maxBlocks}
          </dd>
          <dt>重心</dt>
          <dd className="mono">
            左右 {com[0].toFixed(2)} 上下 {com[1].toFixed(2)} 前後 {com[2].toFixed(2)} m
          </dd>
          <dt>形</dt>
          <dd>{isSymmetricBody ? '左右対称' : '非対称'}</dd>
        </dl>

        {message && <p className={message.error ? 'message error' : 'message'}>{message.text}</p>}

        <div className="row">
          <button onClick={undo} disabled={undoStack.current.length === 0}>
            取り消し
          </button>
          <button onClick={redo} disabled={redoStack.current.length === 0}>
            やり直し
          </button>
        </div>
        <div className="row">
          <button onClick={() => replaceAll(emptyBlueprint())}>コアだけにする</button>
          <button onClick={() => replaceAll(QUADRUPED)}>サンプル(4本脚)</button>
        </div>

        <p className="muted small">
          キー操作の一覧は、3D表示の右上の「キー操作」か <kbd>H</kbd> で表示します。置く設定はこのブラウザに保存され、次に開いたときも同じ設定で始まります。
        </p>
      </aside>

      <div className="viewport">
        <canvas ref={canvasRef} />
        <div className="view-tools">
          <button onClick={() => viewRef.current?.resetCamera()} title="カメラを元の位置に戻す(F)">
            視点を戻す
          </button>
          <button className={showKeys ? 'selected' : ''} onClick={() => setShowKeys((v) => !v)} title="キー操作の一覧(H)">
            キー操作
          </button>
        </div>
        {showKeys && (
          <div className="key-help">
            <table>
              <tbody>
                {KEY_HELP.map((k) => (
                  <tr key={k.keys}>
                    <td>
                      <kbd>{k.keys}</kbd>
                    </td>
                    <td>{k.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
        <div className="placement">
          <span className="chip" title="置くブロック(1〜7)">
            <span className="swatch" style={{ background: hex(BLOCK_COLORS[type]) }} />
            {PALETTE.find((p) => p.type === type)?.label}
          </span>
          <button className="chip" onClick={() => setShape(cycle(SHAPE_ORDER, shape))} title="形(Q)">
            {SHAPE_LABELS.find((x) => x.shape === shape)?.label}
            {shape === 'cylinder' && `・${CYL_AXES.find((x) => x.axis === cylAxis)?.label}`}
          </button>
          {type === 'joint' && (
            <>
              <button className="chip" onClick={() => setAxis(NEXT_AXIS[axis])} title="関節の回転軸(A)">
                軸 {axis.toUpperCase()}
              </button>
              <button className="chip" onClick={() => setSpin(!spin)} title="関節の回り方(S)">
                {spin ? '360°' : '180°'}
              </button>
              {shape === 'cylinder' && tire && <span className="chip">タイヤ</span>}
            </>
          )}
          {(type === 'piston' || type === 'wind') && (
            <button
              className="chip"
              onClick={() =>
                setPistonDirChoice(
                  cycle(
                    PISTON_DIRS.map((d) => d.dir),
                    pistonDir,
                  ),
                )
              }
              title="ピストン・風の向き(D)"
            >
              向き:{PISTON_DIRS.find((d) => d.dir === pistonDir)?.label}
            </button>
          )}
          <button className={`chip${grip ? ' on' : ''}`} onClick={() => setGrip(!grip)} title="摩擦オン(G)">
            摩擦{grip ? 'オン' : 'オフ'}
          </button>
          <button className={`chip${symmetric ? ' on' : ''}`} onClick={() => setSymmetric(!symmetric)} title="左右対称モード(M)">
            左右対称{symmetric ? 'オン' : 'オフ'}
          </button>
        </div>
        <div className="hud">
          {hoveredBlock ? (
            <>
              {hoveredBlock.type === 'core' ? 'コア(黒い印と床の黄色い矢印が正面)' : PALETTE.find((p) => p.type === hoveredBlock.type)?.label}
              {hoveredBlock.type === 'joint' && `・軸 ${hoveredBlock.axis!.toUpperCase()}・${hoveredBlock.spin ? '360°' : '180°'}`}
              {(hoveredBlock.type === 'piston' || hoveredBlock.type === 'wind') && `・${dirLabel(pistonDirection(hoveredBlock))}向き`}
              {`・${BLOCKS[hoveredBlock.type].mass}kg`}
              {hoveredBlock.type !== 'core' && <span className="muted">(E でこの設定をまねる)</span>}
            </>
          ) : (
            'ブロックの面にマウスを合わせてください'
          )}
        </div>
      </div>
    </div>
  );
}
