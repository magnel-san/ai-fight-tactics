// 成績表の表示:突進BOT・標準BOTとの勝率、押し出し勝ち・自滅負けの数、崩落ステージの生存率
import type { ReportCard, VersusRecord } from '../../core/training/report';

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '-');

function Row({ label, r }: { label: string; r: VersusRecord }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <b>{pct(r.wins, r.games)}</b>
        <span className="muted small">
          {' '}
          ({r.wins}勝{r.losses}敗{r.draws ? `${r.draws}分` : ''})
        </span>
      </td>
      <td>{r.pushWins}</td>
      <td className={r.selfFalls > r.games / 4 ? 'warn' : ''}>{r.selfFalls}</td>
    </tr>
  );
}

/** 成績から、キャラの特徴をひとことで言う */
function summary(c: ReportCard): string[] {
  const out: string[] = [];
  const games = c.vsRush.games + c.vsStandard.games;
  const self = c.vsRush.selfFalls + c.vsStandard.selfFalls;
  const push = c.vsRush.pushWins + c.vsStandard.pushWins;
  if (c.vsRush.wins < c.vsRush.games / 2) out.push('突進してくる相手に弱い。「BOTとの押し合い」で鍛えると、突進のかわし方を覚えます');
  if (self >= games / 4) out.push('自分で落ちることが多い。作戦タイプ「守り」で鍛えるか、「崩落ステージを生き残る」をやり直すのがおすすめ');
  if (push >= games / 3) out.push('押し出しが得意な攻撃タイプ');
  if (c.survive.survived >= c.survive.games * 0.75) out.push('崩落ステージでの立ち回りが上手');
  else if (c.survive.survived <= c.survive.games / 4) out.push('崩れるステージで生き残るのが苦手');
  return out;
}

export function ReportCardView({
  report,
  measuring,
  onMeasure,
  disabled,
}: {
  report: ReportCard | undefined;
  measuring: boolean;
  onMeasure(): void;
  disabled: boolean;
}) {
  return (
    <div className="report-card">
      <div className="report-head">
        <h3>成績表</h3>
        <button className="small-button" onClick={onMeasure} disabled={measuring || disabled} title="決まった試合で実力を測ります(数十秒かかります)">
          {measuring ? '測定中…' : report ? '測り直す' : '成績を測る'}
        </button>
      </div>
      {report ? (
        <>
          <table className="guide-table">
            <thead>
              <tr>
                <th>相手</th>
                <th>勝率</th>
                <th title="相手を押し出して勝った数">押し出し勝ち</th>
                <th title="相手に触れずに自分で落ちて負けた数">自滅負け</th>
              </tr>
            </thead>
            <tbody>
              <Row label="突進BOT" r={report.vsRush} />
              <Row label="標準BOT" r={report.vsStandard} />
            </tbody>
          </table>
          <div className="muted small">
            崩落ステージ(レベル3)の生き残り:{report.survive.survived}/{report.survive.games}回(平均 {report.survive.meanTime.toFixed(0)}秒)・
            {new Date(report.at).toLocaleString()} に測定
          </div>
          <ul className="help">
            {summary(report).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">判断脳のメニューに合格すると、自動で測ります。いつでも「成績を測る」で測れます。</p>
      )}
    </div>
  );
}
