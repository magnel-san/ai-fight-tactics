# CLAUDE.md

## プロジェクト
「AI Fight Tactics」。機械学習でモンスターを育て、崩落する六角ステージで戦わせるPCブラウザゲーム。
仕様は docs/SPEC.md を正とする。仕様と異なる実装が必要なら、先に提案して確認を取ること。

## コマンド
- npm run dev   開発サーバー
- npm test      単体テストと決定性テスト
- npm run build 本番ビルド
- npm run test:browsers  Chromium・Firefox・WebKit での決定性テスト(Playwright)
- npx tsx scripts/train.ts …  画面なしでトレーニング(標準BOTの作成は bots/make-standard-bot.sh)

## 絶対に守ること
- src/core/ では three、DOM、Math.random、Math.sin/exp/tanh を使わない(core/math/ の関数を使う)
- 決定性テストを壊さない。物理や脳を変更したら必ず npm test を通す
- 学習・ステージ・コストの数値は src/core/config.ts に集約し、直書きしない

## 進め方
- 1回の作業は、仕様書の開発フェーズ1つの中の小さな単位にする
- 作業の最後に、何を変えたかと、ブラウザでの確認手順を日本語で報告する
- コメント、コミットメッセージ、報告は日本語で書く
