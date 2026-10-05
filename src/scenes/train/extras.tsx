// トレーニング観戦の演出(仕様書セクション10):マイルストーンの通知、留守中のハイライト、比較リプレイ、脳の様子。
import { useEffect, useRef } from 'react';
import type { EpisodeFlags, Episode } from '../../core/training/episode';
import { MatchEpisode } from '../../core/sim/match';
import { EpisodeViewer } from '../../render/EpisodeViewer';

export const MILESTONE_LABELS: Record<keyof EpisodeFlags, string> = {
  stood: '初めて立った',
  reached: '初めて目標に到達',
  crossed: '初めて穴をまたいだ',
  survived60: '60秒生き残った',
  won: '初勝利',
};

export interface Toast {
  id: number;
  title: string;
  detail: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss(id: number): void }) {
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => onDismiss(toasts[0].id), 6000);
    return () => clearTimeout(timer);
  }, [toasts, onDismiss]);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast" onClick={() => onDismiss(t.id)}>
          <div className="toast-title">🎉 {t.title}</div>
          <div className="toast-detail">{t.detail}</div>
        </div>
      ))}
    </div>
  );
}

export interface AwaySummary {
  minutes: number;
  generations: number;
  bestBefore: number | null;
  bestAfter: number | null;
  milestones: string[];
  passed: string[];
}

export function AwayHighlights({ summary, onClose }: { summary: AwaySummary; onClose(): void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>留守中のハイライト</h2>
        <p>
          約{summary.minutes}分のあいだに <strong>{summary.generations}世代</strong> 学習しました。
        </p>
        {summary.bestBefore !== null && summary.bestAfter !== null && (
          <p>
            最高の成績:{summary.bestBefore.toFixed(2)} → <strong>{summary.bestAfter.toFixed(2)}</strong>
          </p>
        )}
        {summary.passed.length > 0 && <p>合格:{summary.passed.join('、')}</p>}
        {summary.milestones.length > 0 && (
          <ul>
            {summary.milestones.map((m) => (
              <li key={m}>🎉 {m}</li>
            ))}
          </ul>
        )}
        <div className="row">
          <button className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/** 第1世代と最新世代を左右に並べ、同じシードで再生する */
export function CompareView({ make, labels, onClose }: { make(side: 0 | 1): Episode | null; labels: [string, string]; onClose(): void }) {
  const left = useRef<HTMLCanvasElement>(null);
  const right = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const viewers = [new EpisodeViewer(left.current!), new EpisodeViewer(right.current!)];
    const restart = () =>
      viewers.forEach((v, i) => {
        v.endPause = Infinity;
        const ep = make(i as 0 | 1);
        if (ep) v.setEpisodes(ep);
      });
    restart();
    // 両方が終わったら、少し待ってからそろえて最初から再生し直す
    let doneTicks = 0;
    const timer = setInterval(() => {
      doneTicks = viewers.every((v) => v.currentEpisode?.done ?? true) ? doneTicks + 1 : 0;
      if (doneTicks >= 3) {
        doneTicks = 0;
        restart();
      }
    }, 500);
    return () => {
      clearInterval(timer);
      viewers.forEach((v) => v.dispose());
    };
  }, [make]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compare" onClick={(e) => e.stopPropagation()}>
        <div className="compare-head">
          <h2>比較リプレイ(同じシード)</h2>
          <button onClick={onClose}>閉じる</button>
        </div>
        <div className="compare-body">
          <div className="compare-pane">
            <canvas ref={left} />
            <div className="hud">{labels[0]}</div>
          </div>
          <div className="compare-pane">
            <canvas ref={right} />
            <div className="hud">{labels[1]}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 脳の様子:隠れ層の各ニューロンの活性を小さなマス目で表示する(青 = 負、橙 = 正) */
export function BrainPanel({ episodeRef }: { episodeRef: { current: Episode | null } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const ctx = canvas.current?.getContext('2d');
      const ep = episodeRef.current;
      if (ctx && ep && ep.fighters[0]) {
        const rows: { label: string; values: ArrayLike<number> }[] = [
          { label: '運動脳', values: ep.fighters[0].motor.hidden },
          { label: '関節', values: ep.fighters[0].motor.output },
        ];
        if (ep instanceof MatchEpisode) {
          const d = ep.decisionBrain(0);
          if (d) rows.unshift({ label: '判断脳', values: d.hidden }, { label: '指令', values: d.output });
        }
        const cell = 9;
        const w = canvas.current!.width;
        ctx.clearRect(0, 0, w, canvas.current!.height);
        ctx.font = '10px system-ui';
        let y = 2;
        for (const r of rows) {
          ctx.fillStyle = '#8a93a5';
          ctx.fillText(r.label, 2, y + 8);
          for (let i = 0; i < r.values.length; i++) {
            const v = Math.max(-1, Math.min(1, r.values[i]));
            const x = 46 + (i % 24) * (cell + 1);
            const yy = y + Math.floor(i / 24) * (cell + 1);
            ctx.fillStyle = v >= 0 ? `rgba(255,138,61,${v})` : `rgba(86,204,242,${-v})`;
            ctx.fillRect(x, yy, cell, cell);
            ctx.strokeStyle = '#2f3747';
            ctx.strokeRect(x + 0.5, yy + 0.5, cell - 1, cell - 1);
          }
          y += Math.ceil(r.values.length / 24) * (cell + 1) + 4;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [episodeRef]);
  return <canvas ref={canvas} className="brain-panel" width={290} height={96} />;
}
