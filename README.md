# AI Fight Tactics

ブロックで組んだモンスターを機械学習で育て、崩れていく六角タイルのステージで最後まで生き残った方が勝つ、PCブラウザ向けの対戦ゲームです。サーバーなしで、学習もすべてブラウザの中で行います。

## 遊び方

1. **キャラクリエイト**:コアに、基礎・関節・弾力・グリップのブロックをコスト30以内で付けて体を作る。
2. **トレーニング**:メニューを順に解放しながら学習させる。上達していく様子を観戦できる。
   1. 目標地点への移動(運動脳)
   2. 対象を追う(運動脳)
   3. 穴をまたぐ(運動脳・任意)
   4. 崩落ステージを生き残る(判断脳)
   5. BOTとの押し合い(判断脳)
3. **バトル**:BOT・保存したキャラ・友人のキャラと、崩落ステージで戦わせる。
4. **見直し**:負けた原因に応じて、体を組み直すかトレーニングを積み直す。

キャラは「マイキャラ」から共有URLやファイルで友人に渡せます。

## 開発

```bash
npm install
npm run dev          # 開発サーバー
npm test             # 単体テストと決定性テスト
npm run build        # 本番ビルド(dist/ を静的ホスティングに置けば動く)
npm run test:browsers  # Chromium・Firefox・WebKit での決定性テスト(初回は npx playwright install が必要)
```

- 仕様:[docs/SPEC.md](docs/SPEC.md)(実装時に決めたことは付録A)
- 開発ルール:[CLAUDE.md](CLAUDE.md)
- 関門の検証結果:[関門1](docs/gate1-report.md)・[関門2](docs/gate2-report.md)
- オンライン対戦の準備:[docs/ONLINE.md](docs/ONLINE.md)

### 画面なしでのトレーニング

```bash
npx tsx scripts/train.ts --sample quadruped --task move --gens 200 --out my.json
npx tsx scripts/train.ts --char my.json --task chase --gens 200 --until-pass --out my.json
```

同梱の標準BOTは `sh bots/make-standard-bot.sh` で作り直せます。

### 構成

```
src/core/      決定論的コア(物理・ステージ・脳・学習)。three・DOM・Math.random を使わない
src/workers/   学習用 Web Worker
src/training/  学習の進行役と Worker のプール
src/render/    Three.js の描画
src/scenes/    各画面(キャラクリエイト・トレーニング・バトル・マイキャラ・オンライン)
src/storage/   IndexedDB と共有URL
src/online/    Supabase(任意)
scripts/       画面なしの学習・検証スクリプト
e2e/           ブラウザ間の決定性テスト
```

## 配布

`npm run build` の `dist/` を、GitHub Pages(`.github/workflows/pages.yml`)や itch.io(HTML5 ゲームとして zip をアップロード)に置くだけで動きます。相対パスで出力しているので、サブディレクトリに置いても動きます。
