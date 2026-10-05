// 同梱のBOT(仕様書セクション9「押し合いの対戦相手」)。
// 標準BOTは開発側で学習させたキャラ(scripts/train-bot.ts で作り、standard-bot.json に保存する)。
// 突進BOTは標準BOTと同じ体と運動脳で、判断だけ「相手に向かって直進する」ルールにしたもの。
import type { Character } from '../core/character';
import { parseCharacter } from '../core/codec';
import type { FighterData } from '../core/training/tasks';
import type { Opponent } from '../training/Trainer';
import standardJson from './standard-bot.json';

function load(): Character | null {
  if ((standardJson as { pending?: boolean }).pending) return null;
  try {
    return parseCharacter(standardJson);
  } catch (e) {
    console.error('標準BOTのデータを読めませんでした', e);
    return null;
  }
}

export const STANDARD_BOT: Character | null = load();

export function rushBot(): FighterData | null {
  if (!STANDARD_BOT?.motor) return null;
  return { blueprint: STANDARD_BOT.blueprint, motor: STANDARD_BOT.motor, decision: null, controller: 'rush' };
}

export function standardBot(): FighterData | null {
  if (!STANDARD_BOT?.motor || !STANDARD_BOT.decision) return null;
  return { blueprint: STANDARD_BOT.blueprint, motor: STANDARD_BOT.motor, decision: STANDARD_BOT.decision, controller: 'brain' };
}

/** 押し合いの相手(弱い順)。標準BOTがまだなければ空 */
export function pushOpponents(): Opponent[] {
  const rush = rushBot();
  const standard = standardBot();
  if (!rush || !standard) return [];
  return [
    { label: '突進BOT', data: rush },
    { label: '標準BOT', data: standard },
  ];
}
