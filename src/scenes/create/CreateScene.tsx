// キャラクリエイト画面(仕様書セクション4)
import { useCallback, useEffect, useRef, useState } from 'react';
import { BLOCKS, CREATURE, type BlockType } from '../../core/config';
import { blockPositions, centerOfMass, jointCount, oppositeFace, pistonDirection, totalCost, type Axis, type Blueprint, type Face } from '../../core/creature/blueprint';
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
  setPistonDir,
  setPistonDirSymmetric,
  type EditResult,
} from '../../core/creature/edit';
import { QUADRUPED } from '../../core/creature/samples';
import { BLOCK_COLORS } from '../../render/creatureMesh';
import { EditorView } from './EditorView';

const PALETTE: { type: Exclude<BlockType, 'core'>; label: string; note: string }[] = [
  { type: 'base', label: '基礎', note: '標準的な摩擦と反発' },
  { type: 'joint', label: '関節', note: '脳で動かせるヒンジ(±90°)' },
  { type: 'bouncy', label: '弾力', note: '当たった相手を弾き飛ばす' },
  { type: 'grip', label: 'グリップ', note: '摩擦が大きく踏ん張れる' },
  { type: 'piston', label: 'ピストン', note: '付けた面の向きに1マス伸び縮みする(ジャンプや押し出しに)' },
  { type: 'sensor', label: 'センサー', note: 'トレーニング中に地面に触れると減点(倒れにくい動きを学ばせる。バトルでは普通のブロック)' },
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

const dirLabel = (f: Face) => PISTON_DIRS.find((d) => d.dir === f)?.label ?? f;

/** 取り消しの最大段数 */
const HISTORY_LIMIT = 100;

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
  const [type, setType] = useState<Exclude<BlockType, 'core'>>('base');
  const [axis, setAxis] = useState<Axis>('x');
  /** 置くピストンの伸びる向き('face' = 付けた面の向き) */
  const [pistonDir, setPistonDirChoice] = useState<Face | 'face'>('face');
  const [symmetric, setSymmetric] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);
  /** 右クリックで選んだブロック */
  const [selected, setSelected] = useState<number | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const undoStack = useRef<Blueprint[]>([]);
  const redoStack = useRef<Blueprint[]>([]);
  const [, forceRender] = useState(0);

  // イベントハンドラから常に最新の値を読むための参照
  const latest = useRef({ blueprint, type, axis, symmetric, hovered, selected, pistonDir });
  latest.current = { blueprint, type, axis, symmetric, hovered, selected, pistonDir };

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
        const { blueprint: bp, type: t, axis: a, symmetric: sym, pistonDir: pd } = latest.current;
        const dir = pd === 'face' ? undefined : pd;
        const result = sym ? addBlockSymmetric(bp, parent, face, t, a, dir) : addBlock(bp, parent, face, t, a, dir);
        const target = cellOnFace(bp, parent, face);
        if (!result.ok) return { cells: [target], ok: false };
        // 追加された分のブロックの位置を表示する
        const pos = blockPositions(result.blueprint);
        return { cells: pos.slice(bp.blocks.length), ok: true };
      },
      onPlace(parent, face) {
        const { blueprint: bp, type: t, axis: a, symmetric: sym, pistonDir: pd } = latest.current;
        const dir = pd === 'face' ? undefined : pd;
        commit(sym ? addBlockSymmetric(bp, parent, face, t, a, dir) : addBlock(bp, parent, face, t, a, dir));
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
  useEffect(() => viewRef.current?.refreshHover(), [axis, symmetric, pistonDir]);

  // キーボード操作
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const { blueprint: bp, symmetric: sym, hovered, selected: sel } = latest.current;
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
      } else if (key === 'r' && h !== null && bp.blocks[h]?.type === 'joint') {
        const next = NEXT_AXIS[bp.blocks[h].axis!];
        commit(sym ? setJointAxisSymmetric(bp, h, next) : setJointAxis(bp, h, next));
      } else if (['1', '2', '3', '4', '5', '6'].includes(e.key) && !e.ctrlKey && !e.metaKey) {
        setType(PALETTE[Number(e.key) - 1].type);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, commit, undo, redo]);

  const replaceAll = (bp: Blueprint) => commit({ ok: true, blueprint: bp, notes: [] });

  const cost = totalCost(blueprint);
  const joints = jointCount(blueprint);
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
        <h2>ブロック</h2>
        <div className="palette">
          {PALETTE.map((p, i) => (
            <button
              key={p.type}
              className={`block-button${type === p.type ? ' selected' : ''}`}
              onClick={() => setType(p.type)}
              title={p.note}
            >
              <span className="swatch" style={{ background: hex(BLOCK_COLORS[p.type]) }} />
              <span className="name">
                {i + 1}. {p.label}
              </span>
              <span className="cost">コスト {BLOCKS[p.type].cost}</span>
            </button>
          ))}
        </div>

        {type === 'joint' && (
          <>
            <h3>関節の回転軸</h3>
            <div className="segmented">
              {AXES.map((a) => (
                <button key={a.axis} className={axis === a.axis ? 'selected' : ''} onClick={() => setAxis(a.axis)}>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}

        {type === 'piston' && (
          <>
            <h3>ピストンの伸びる向き</h3>
            <div className="segmented wrap">
              {PISTON_DIRS.map((d) => (
                <button key={d.dir} className={pistonDir === d.dir ? 'selected' : ''} onClick={() => setPistonDirChoice(d.dir)} title={d.note}>
                  {d.label}
                </button>
              ))}
            </div>
            <p className="muted small">付けた面の逆向き(親のブロックに向かう向き)には伸ばせません</p>
          </>
        )}

        <label className="toggle">
          <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
          左右対称モード
        </label>

        <h2>選択中のブロック</h2>
        {selectedBlock ? (
          <div className="selected-block">
            <div>
              {selectedBlock.type === 'core' ? 'コア' : PALETTE.find((p) => p.type === selectedBlock.type)?.label}
              {selectedBlock.type === 'joint' && `(軸 ${selectedBlock.axis!.toUpperCase()})`}
              {selectedBlock.type === 'piston' && `(${dirLabel(pistonDirection(selectedBlock))}に伸びる)`}
            </div>
            {selectedBlock.type === 'piston' && (
              <div className="segmented wrap">
                {PISTON_DIRS.filter((d) => d.dir !== 'face').map((d) => {
                  const dir = d.dir as Face;
                  return (
                    <button
                      key={dir}
                      className={pistonDirection(selectedBlock) === dir ? 'selected' : ''}
                      disabled={dir === oppositeFace(selectedBlock.face!)}
                      onClick={() => commit(symmetric ? setPistonDirSymmetric(blueprint, selected!, dir) : setPistonDir(blueprint, selected!, dir))}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedBlock.type === 'joint' && (
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
            )}
            <div className="row">
              <button className="danger" onClick={removeSelected} disabled={selectedBlock.type === 'core'} title="このブロックと、その先につながるブロックを削除します">
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
          <dt>関節</dt>
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

        <h3>操作</h3>
        <ul className="help">
          <li>左クリック:面にブロックを置く</li>
          <li>右ドラッグ:回転 / ホイール:ズーム</li>
          <li>右クリック:ブロックを選択(Esc で解除)</li>
          <li>Delete:選択中のブロックとその先を削除(選択がなければマウスの下のブロック)</li>
          <li>R:選択中(またはマウスの下)の関節の軸を切り替え</li>
          <li>Ctrl+Z / Ctrl+Y:取り消し / やり直し</li>
          <li>1〜6:ブロックの種類を選ぶ</li>
        </ul>
      </aside>

      <div className="viewport">
        <canvas ref={canvasRef} />
        <div className="hud">
          {hoveredBlock ? (
            <>
              {hoveredBlock.type === 'core' ? 'コア(黒い印と床の黄色い矢印が正面)' : PALETTE.find((p) => p.type === hoveredBlock.type)?.label}
              {hoveredBlock.type === 'joint' && `・軸 ${hoveredBlock.axis!.toUpperCase()}`}
            </>
          ) : (
            'ブロックの面にマウスを合わせてください'
          )}
        </div>
      </div>
    </div>
  );
}
