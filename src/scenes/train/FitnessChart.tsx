// 世代ごとの最高・平均の適応度の折れ線グラフ
import type { HistoryPoint } from '../../storage/db';

const W = 248;
const H = 140;
const PAD = { left: 30, right: 6, top: 8, bottom: 18 };

export function FitnessChart({ history }: { history: HistoryPoint[] }) {
  if (history.length < 2) return <p className="chart-empty">2世代以上でグラフを表示します</p>;

  const values = history.flatMap((r) => [r.best, r.mean]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < 1e-6) {
    max += 1;
    min -= 1;
  }
  const x = (i: number) => PAD.left + (i / (history.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min)) * (H - PAD.top - PAD.bottom);
  const line = (key: 'best' | 'mean') => history.map((r, i) => `${x(i).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const passedAt = history.findIndex((r) => r.passed);

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="成績グラフ">
      <line x1={PAD.left} x2={W - PAD.right} y1={y(0)} y2={y(0)} className="zero" />
      <text x={PAD.left - 4} y={y(max) + 4} className="tick" textAnchor="end">
        {max.toFixed(0)}
      </text>
      <text x={PAD.left - 4} y={y(min)} className="tick" textAnchor="end">
        {min.toFixed(0)}
      </text>
      <text x={W - PAD.right} y={H - 4} className="tick" textAnchor="end">
        {history.length}世代
      </text>
      {passedAt >= 0 && <line x1={x(passedAt)} x2={x(passedAt)} y1={PAD.top} y2={H - PAD.bottom} className="pass" />}
      <polyline points={line('mean')} className="mean" />
      <polyline points={line('best')} className="best" />
      <g className="legend" transform={`translate(${PAD.left + 6}, ${PAD.top + 8})`}>
        <line x1={0} x2={12} y1={0} y2={0} className="best" />
        <text x={16} y={4}>
          最高
        </text>
        <line x1={52} x2={64} y1={0} y2={0} className="mean" />
        <text x={68} y={4}>
          平均
        </text>
      </g>
    </svg>
  );
}
