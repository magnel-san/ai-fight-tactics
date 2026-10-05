#!/bin/sh
# 関門2の検証:新しいキャラが、移動 → 追跡 → 生き残り → 押し合い(突進BOT → 標準BOT)の合格まで、
# どれくらいの学習時間で進めるかを測る(画面なし)
set -e
SAMPLE=${1:-crawler}
OUT=${2:-bots/journey.work.json}
npx tsx scripts/train.ts --sample "$SAMPLE" --name 検証キャラ --task move --gens 300 --until-pass --seed 31 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task chase --gens 300 --until-pass --seed 32 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task survive --gens 300 --until-pass --seed 33 --out "$OUT"
npx tsx scripts/train.ts --char "$OUT" --task push --opponents rush,standard --gens 300 --until-pass --seed 34 --out "$OUT"
