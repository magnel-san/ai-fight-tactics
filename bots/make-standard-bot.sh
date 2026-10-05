#!/bin/sh
# 標準BOTを作る手順(画面なしで、移動 → 追跡 → 生き残り → 押し合い の順に学習させる)
# 結果は src/data/standard-bot.json に保存する。所要時間はPCによるが1〜2時間ほど。
set -e
OUT=${1:-bots/standard-bot.work.json}
npx tsx scripts/train.ts --sample standard --name 標準BOT --task move --gens 200 --seed 11 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task chase --gens 150 --seed 12 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task survive --gens 200 --seed 13 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task push --opponents rush,self --gens 200 --seed 14 --out "$OUT"
cp "$OUT" src/data/standard-bot.json
