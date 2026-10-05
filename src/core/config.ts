// ゲーム全体の調整パラメータ(仕様書セクション15)。
// 数値はすべて仮の初期値。コード中に直書きせず、必ずここから参照すること。

export const CREATURE = {
  /** 総コスト上限 */
  maxCost: 30,
  /** 関節の最大数(脳の入出力サイズを抑えるため) */
  maxJoints: 8,
  /** ブロックの最大数 */
  maxBlocks: 24,
  /** ブロックの1辺 [m] */
  blockSize: 0.4,
  /** 関節の可動範囲 [rad](±90°) */
  jointLimit: Math.PI / 2,
  /** 関節モーター(角度制御)のばね定数と減衰。トルク上限の扱いは関節実装時に決める */
  jointStiffness: 50,
  jointDamping: 5,
} as const;

export type BlockType = 'core' | 'base' | 'joint' | 'bouncy' | 'grip';

export const BLOCKS: Record<
  BlockType,
  { cost: number; mass: number; friction: number; restitution: number }
> = {
  core: { cost: 0, mass: 2.0, friction: 0.8, restitution: 0.1 },
  base: { cost: 1, mass: 1.0, friction: 0.8, restitution: 0.1 },
  joint: { cost: 3, mass: 0.5, friction: 0.8, restitution: 0.1 },
  bouncy: { cost: 2, mass: 0.8, friction: 0.8, restitution: 0.9 },
  grip: { cost: 2, mass: 1.0, friction: 2.0, restitution: 0.1 },
};

export const PHYSICS = {
  /** 固定タイムステップ [s] */
  dt: 1 / 60,
  /** 脳の更新間隔(物理ステップ数)。1/20秒 */
  brainInterval: 3,
  gravity: -9.81,
  /** コア中心がタイル上面からこれ以上下に落ちたら脱落 [m] */
  fallDepth: 1.0,
} as const;

export const STAGE = {
  /** 六角グリッドの半径(127枚) */
  radius: 6,
  /** タイルの外接半径 [m] */
  tileCircumradius: 0.6,
  /** 危険マークの時間 [s] */
  warningTime: 2.0,
  /** 最終地点を選ぶ範囲(中心からの六角距離) */
  finalPointMaxDist: 4,
  /** ルールA:安全円の縮小開始 [s]、間隔 [s]、最小半径 */
  shrinkStart: 10,
  shrinkInterval: 8,
  minSafeRadius: 1,
  /** ルールB:滞在で危険マークがつくまで [s]、離れたときの減衰比 */
  stayLimit: 3.0,
  stayDecayRatio: 0.5,
  /** ルールC:ランダム崩落の開始 [s]、初期間隔 [s]、最終間隔 [s]、最終間隔に達する時刻 [s] */
  randomStart: 20,
  randomIntervalStart: 4,
  randomIntervalEnd: 1,
  randomIntervalEndTime: 90,
  /** スポーン:中心を挟んだ距離(マス)、落下高さ [m] */
  spawnDistance: 3,
  spawnHeight: 0.5,
} as const;

export const BATTLE = {
  /** 試合の時間制限 [s] */
  timeLimit: 150,
} as const;

export const BRAIN = {
  motorHidden: 32,
  decisionInputs: 35,
  decisionHidden: 24,
  decisionOutputs: 3,
} as const;

export const TRAINING = {
  population: 64,
  populationMin: 32,
  populationMax: 128,
  episodesPerGeneration: 3,
  elites: 4,
  tournamentSize: 3,
  sigmaInit: 0.05,
  sigmaMax: 0.2,
  sigmaDecay: 0.7,
  sigmaGrow: 1.1,
  /** この世代数だけ最優秀スコアが改善しなければσを縮める */
  stagnationGenerations: 10,
  workersMin: 2,
  workersMax: 8,
} as const;
