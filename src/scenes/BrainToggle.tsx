// 「AIの考え」の表示を切り替えるチェックボックス(観戦画面の右上に置く)
import { useState } from 'react';
import type { EpisodeViewer } from '../render/EpisodeViewer';

export function BrainToggle({ viewer }: { viewer: () => EpisodeViewer | null }) {
  const [on, setOn] = useState(false);
  return (
    <label className="ghost-toggle" title="判断脳が見ているタイル(白:安全・オレンジ〜赤:危険マーク・紫:穴)と、進みたい向き(矢印)を表示します">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          const v = viewer();
          if (v) v.showBrain = e.target.checked;
        }}
      />
      AIの考え
    </label>
  );
}
