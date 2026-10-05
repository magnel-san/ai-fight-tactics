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
  /**
   * 関節モーター(角度制御、Rapier の ForceBased モデル)のばね定数 [N·m/rad] と減衰 [N·m·s/rad]。
   * 弱すぎると、足が床に摩擦で固定されたときに押し負けて関節が動かなくなる
   */
  jointStiffness: 1000,
  jointDamping: 40,
  /** 関節モーターのトルク上限 [N·m]。高速回転のような挙動を防ぐ */
  jointMaxTorque: 50,
  /**
   * コライダーを各辺この長さだけ小さくする [m]。
   * 隣り合う別剛体のブロック同士が常に接触して震えるのを防ぐ
   */
  colliderShrink: 0.01,
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
  /** 運動脳の入力のうち、関節数によらない部分(指令3・姿勢3・速度6・リズム2・足元3) */
  motorFixedInputs: 17,
  motorHidden: 32,
  decisionInputs: 35,
  decisionHidden: 24,
  decisionOutputs: 3,
  /** センサー値を -1〜1 程度にそろえるための目安 */
  linvelScale: 2,
  angvelScale: 5,
  jointVelScale: 10,
  /** リズム信号の周期 [s]。遺伝子として学習するが、この範囲に収める */
  rhythmPeriodMin: 0.3,
  rhythmPeriodMax: 2.0,
  rhythmPeriodInit: 1.0,
} as const;

/** トレーニング「目標地点への移動」(仕様書セクション9) */
export const MOVE_TASK = {
  targetDistMin: 4,
  targetDistMax: 6,
  /** 制限時間 [s](合格条件の「15秒以内に到達」と同じ) */
  timeLimit: 15,
  /** コア中心が目標からこの水平距離以内に入ったら到達 [m] */
  arriveRadius: 0.6,
  /** 到達ボーナスと、残り時間の割合にかける早着ボーナス */
  arriveBonus: 5,
  arriveTimeBonus: 5,
  /** コアが裏返っている間の減点 [/s] */
  flipPenaltyPerSec: 1,
  /** 床の半分の大きさ [m] */
  groundHalfSize: 30,
  /** 合格条件:評価エピソードのうち、到達しなければならない回数 */
  passCount: 2,
  /**
   * 合格の確認。世代の評価で合格条件を満たした個体を、新しいシードのエピソードでもう一度評価し、
   * 同じ割合(2/3)以上で到達したら合格とする。3回だけでは目標の向きの運で合格してしまうため
   */
  confirmEpisodes: 9,
  confirmPassCount: 6,
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
  /** σ の下限(小さくなりすぎて進化が止まるのを防ぐ) */
  sigmaMin: 0.005,
} as const;
