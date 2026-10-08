// 「あそびかた」画面:遊び方のまとめと、いまのキャラの進み具合(次にやること)。
// 数値は config.ts などから読むので、調整しても説明がずれない。
import type { Character } from '../../core/character';
import { ENTRY_REQUIRED_TASK } from '../../core/character';
import { BATTLE, BLOCK_OPTIONS, BLOCKS, CREATURE, RACE, RANKED, SOCCER, STAGE, TRACK } from '../../core/config';
import { BRAIN_LABELS } from '../../core/training/brains';
import { OPTIONAL_TASKS, TASK_ORDER, TASKS } from '../../core/training/tasks';
import { BLOCK_COLORS } from '../../render/creatureMesh';
import { PALETTE, SHAPE_LABELS } from '../create/CreateScene';

/** 移動先(タブと、その中の切り替え) */
export type GuideTarget = 'create' | 'train' | 'battle' | 'race' | 'ranked-entry' | 'ranked-live' | 'library';

interface Props {
  character: Character;
  onGo(target: GuideTarget): void;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export function GuideScene({ character, onGo }: Props) {
  const passed = character.progress.passed;
  const steps: { done: boolean; title: string; note: string; go: GuideTarget; button: string }[] = [
    {
      done: character.blueprint.blocks.length > 1,
      title: 'キャラを作る',
      note: 'コアにブロックを付けて体を作ります。迷ったら「サンプル(4本脚)」から始めましょう',
      go: 'create',
      button: 'キャラ作成へ',
    },
    {
      done: passed.includes('move'),
      title: 'トレーニング「1. 目標地点への移動」に合格する',
      note: '歩き方(運動脳)を覚えます。合格するとバトルで戦えます(判断脳がないうちは相手に向かって突進します)',
      go: 'train',
      button: 'トレーニングへ',
    },
    {
      done: passed.includes(ENTRY_REQUIRED_TASK),
      title: `トレーニング「2. ${TASKS[ENTRY_REQUIRED_TASK].label}」に合格する`,
      note: '指示された方向へ進めるようになります。合格すると、かけっこ・サッカー・ランダムマッチ・トーナメントに出られます',
      go: 'train',
      button: 'トレーニングへ',
    },
    {
      done: !!character.decision && passed.includes('survive'),
      title: '判断脳を鍛える(危険なタイルを避ける → 崩落ステージを生き残る)',
      note: '崩れるステージで、どこへ動くかを考える脳です。鍛えると、突進ではなく作戦を考えて戦います',
      go: 'train',
      button: 'トレーニングへ',
    },
    {
      done: passed.includes('push'),
      title: 'BOTとの押し合いに合格する',
      note: '相手を押し出す戦い方を覚えます。ここまで来れば一人前です',
      go: 'train',
      button: 'トレーニングへ',
    },
    {
      done: false,
      title: 'オンラインのトーナメントに出場する',
      note: `プレイヤー名を登録して、モンスターを出場させましょう。${RANKED.interval / 60}分ごとに自動でトーナメントが開かれます`,
      go: 'ranked-entry',
      button: '出場登録へ',
    },
  ];
  const next = steps.find((s) => !s.done);

  return (
    <div className="library guide">
      <section className="card">
        <h2>AI Fight Tactics へようこそ</h2>
        <p>
          ブロックを組み合わせてモンスターを作り、<b>機械学習(進化)</b>で動き方を覚えさせて、崩れていくステージで戦わせるゲームです。
          あなたが操作するのではなく、育てたモンスターが自分で考えて戦います。学習はすべてこのブラウザの中で行われます。
        </p>
      </section>

      <section className="card">
        <h2>「{character.name}」の進み具合</h2>
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={i} className={s.done ? 'done' : s === next ? 'next' : ''}>
              <span className="step-mark">{s.done ? '✔' : i + 1}</span>
              <div>
                <div className="step-title">{s.title}</div>
                <div className="muted small">{s.note}</div>
              </div>
              {s === next && (
                <button className="primary" onClick={() => onGo(s.go)}>
                  {s.button}
                </button>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>1. キャラを作る(キャラ作成)</h2>
        <ul className="help">
          <li>左クリックでブロックの面に新しいブロックを置きます。右ドラッグで回転、ホイールでズーム、右クリックでブロックを選択します</li>
          <li>
            キーボードでも設定を変えられます:1〜7 でブロックの種類、Q で形、G で摩擦、M で左右対称、A・S で関節の軸と回り方、D でピストン・風の向き、 E
            でマウスの下のブロックの設定をまねる(スポイト)、F で視点を戻す。全部の一覧は、キャラ作成の3D表示の右上「キー操作」か H で表示します。
            置く設定はブラウザに保存され、次に開いたときも同じ設定で始まります
          </li>
          <li>
            コストの上限は <b>{CREATURE.maxCost}</b>、ブロックは <b>{CREATURE.maxBlocks}個</b>、関節とピストンは合わせて <b>{CREATURE.maxJoints}個</b> までです
          </li>
          <li>「左右対称モード」をオンにすると、反対側にも同じブロックが付きます</li>
          <li>体を組み直すと、歩き方(運動脳)は最初から覚え直しになります。考える脳(判断脳)はそのまま残ります</li>
        </ul>
        <table className="guide-table">
          <thead>
            <tr>
              <th>ブロック</th>
              <th>コスト</th>
              <th>重さ</th>
              <th>特徴</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <span className="swatch" style={{ background: hex(BLOCK_COLORS.core) }} /> コア
              </td>
              <td>{BLOCKS.core.cost}</td>
              <td>{BLOCKS.core.mass}kg</td>
              <td className="muted">1体に1個(最初からある)。黒い印が正面。コアが落ちると負け</td>
            </tr>
            {PALETTE.map((p) => (
              <tr key={p.type}>
                <td>
                  <span className="swatch" style={{ background: hex(BLOCK_COLORS[p.type]) }} /> {p.label}
                </td>
                <td>{BLOCKS[p.type].cost}</td>
                <td>{BLOCKS[p.type].mass}kg</td>
                <td className="muted">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">
          どのブロックも、形を {SHAPE_LABELS.map((x) => x.label).join('・')} から選べます({SHAPE_LABELS.map((x) => `${x.label}:${x.note}`).join(' / ')})。
          「摩擦オン」にすると滑りにくく踏ん張れるようになります(コスト+{BLOCK_OPTIONS.gripCost}。緑の網目が目印)。
        </p>
        <p className="muted small">
          円柱にしたブロックは、円柱の向き(自動・左右・上下・前後)を選べます。関節を円柱にして「タイヤモード」をオンにすると、半径が
          {BLOCK_OPTIONS.tireRadiusScale}倍の黒いタイヤになります(コスト+{BLOCK_OPTIONS.tireCost}
          )。関節の回り方を「360°(回転)」にして、回転軸と円柱の向きをそろえると、転がって進めます(「180°(角度)」の関節は±90°までしか動かないので、脚や腕に向いています)。
          タイヤの周り(回転軸に垂直な4方向)には、重ならないように親以外のブロックを置けません。
        </p>
      </section>

      <section className="card">
        <h2>2. 鍛える(トレーニング)</h2>
        <p className="muted small">
          モンスターには2つの脳があります。<b>運動脳</b>は手足の動かし方(歩き方)、<b>判断脳</b>はどこへ向かうか(作戦)を決めます。
          メニューを選んで「学習開始」を押すと、たくさんの候補を試して、成績のよいものを残しながら少しずつ上達します。合格すると次のメニューが開きます。
        </p>
        <table className="guide-table">
          <thead>
            <tr>
              <th>メニュー</th>
              <th>鍛える脳</th>
              <th>合格の条件</th>
            </tr>
          </thead>
          <tbody>
            {TASK_ORDER.map((t, i) => (
              <tr key={t}>
                <td>
                  {i + 1}. {TASKS[t].label}
                  {OPTIONAL_TASKS.includes(t) && <span className="optional">任意</span>}
                </td>
                <td>{BRAIN_LABELS[TASKS[t].brain]}</td>
                <td className="muted">{TASKS[t].passCondition}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="help">
          <li>学習が進まないときは、体をシンプルにする・左右対称にする・脚の先を「摩擦オン」にするのがおすすめです</li>
          <li>二足歩行など、倒れてほしくない体には「センサー」ブロックを頭に付けると、地面に触れたときに減点されて倒れにくい動きを覚えます</li>
          <li>学習中は、画面の映像で最新の世代のいちばん上手な動きを見られます。グラフで成績の伸びも確認できます</li>
        </ul>
      </section>

      <section className="card">
        <h2>3. 戦う(対戦)</h2>
        <ul className="help">
          <li>
            <b>バトル</b>:六角形のタイルのステージで1対1。相手を落とすか、相手が自分で落ちたら勝ち。{BATTLE.timeLimit}秒で決着がつかなければ引き分けです
          </li>
          <li>
            ステージは時間とともに崩れます:安全な円がだんだん小さくなる・同じタイルに{STAGE.stayLimit}秒いると崩れる・
            {STAGE.randomStart}秒後からランダムに崩れる。崩れる前のタイルは赤く光ります
          </li>
          <li>
            <b>かけっこ</b>:{RACE.distance}m 先のゴールまでのタイムを競います(最大4体)。
            <b>長距離</b>:楕円のトラックを{TRACK.laps}周します。1周に{TRACK.checkpoints}個あるチェックポイントを順番どおりに全部通らないと周回になりません。
            <b>ジャンプ</b>:合図に合わせて跳び、いちばん高い記録を競います。
            <b>サッカー</b>:{SOCCER.teamSize}対{SOCCER.teamSize}で、ボールをゴールに押し込みます。選手ごとに役割(シューター・キャリアー・ブロッカー)を選び、
            トレーニングでその役割のサッカー脳を鍛えると、お手本の動きより上手になります
          </li>
          <li>
            観戦画面の右上の<b>「AIの考え」</b>をオンにすると、判断脳が見ているタイル(目)と、進みたい向き(矢印)が出ます。
            ジャンプボタンを押している間は、キャラの上に黄色の「JUMP」が出ます
          </li>
          <li>
            <b>ランダムマッチ</b>:オンラインで、まだ戦っていない相手と自動で1対1。結果はランダムマッチのレートに反映されます(同じ相手とは1回だけ)
          </li>
        </ul>
        <div className="row">
          <button onClick={() => onGo('battle')}>バトルへ</button>
          <button onClick={() => onGo('race')}>かけっこへ</button>
        </div>
      </section>

      <section className="card">
        <h2>4. オンライン</h2>
        <ul className="help">
          <li>
            <b>トーナメント</b>:{RANKED.interval / 60}分ごとに、出場登録されたモンスター(最大{RANKED.maxEntrants}体)で自動のトーナメントが開かれ、
            {RANKED.slot / 60}分ごとに1試合ずつ、ライブ配信のように全員の画面で同じ試合が流れます。終わった試合はリプレイで見られます
          </li>
          <li>
            <b>ランキング</b>:トーナメントとランダムマッチのレート(最初は{RANKED.initialRating})・勝利数・かけっこの記録。記録はモンスターごとに残ります
          </li>
          <li>
            <b>出場登録</b>:プレイヤー名を登録して、モンスターを1体出場させます(「2. {TASKS[ENTRY_REQUIRED_TASK].label}」に合格したキャラ)
          </li>
          <li>
            <b>キャラ交換</b>:キャラを公開して、ほかのプレイヤーのキャラと練習試合ができます(レートには関係しません)
          </li>
          <li>通信を減らすため、一覧や結果は「更新」ボタンを押したとき(とトーナメントの開始時)に取得します</li>
        </ul>
        <div className="row">
          <button onClick={() => onGo('ranked-live')}>トーナメント配信へ</button>
          <button onClick={() => onGo('ranked-entry')}>出場登録へ</button>
        </div>
      </section>

      <section className="card">
        <h2>5. マイキャラ</h2>
        <ul className="help">
          <li>キャラはこのブラウザに自動で保存されます。「新しいキャラ」「複製」で何体でも育てられます</li>
          <li>「共有URLを作る」や「ファイルに書き出す」で、友だちにキャラを渡せます(受け取ったキャラは対戦相手になります)</li>
          <li>バトル・トーナメント・ランダムマッチの試合と、トレーニングの名場面はリプレイとして保存され、あとから見られます</li>
        </ul>
        <div className="row">
          <button onClick={() => onGo('library')}>マイキャラへ</button>
        </div>
      </section>
    </div>
  );
}
