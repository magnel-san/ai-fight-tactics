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
  /** スポーン:中心からの距離(マス。2体は中心を挟んで反対側)、落下高さ [m] */
  spawnDistance: 3,
  spawnHeight: 0.5,
  /** タイルの厚さ [m](上面が y = 0) */
  tileHeight: 0.4,
  tileFriction: 0.8,
} as const;

export const BATTLE = {
  /** 試合の時間制限 [s] */
  timeLimit: 150,
} as const;

/** トレーニング「対象を追う」(メニュー2) */
export const CHASE_TASK = {
  /** 目標の初期距離 [m] */
  startDist: 3,
  /** 目標が逃げる速さ [m/s] */
  targetSpeed: 0.25,
  /** 目標が曲がる間隔 [s] と、曲がる角度の最大 [rad] */
  turnIntervalMin: 2,
  turnIntervalMax: 4,
  turnAngleMax: Math.PI / 2,
  timeLimit: 15,
  /** 一致度の計算で、これより遅い動きは速さをこの値とみなす(止まっていると一致度が上がらない) [m/s] */
  alignMinSpeed: 0.1,
  /** 移動方向を測る時間 [s]。歩くと体が左右に揺れるので、瞬間の速度ではなくこの時間の変位で測る */
  alignWindow: 1,
  /** 一致度の計測を始めるまでの時間 [s](動き出すまでの猶予) */
  warmup: 1,
  /** 報酬で一致度にかける重み [/s] */
  alignWeight: 0.5,
  /** 合格条件:一致度の平均 */
  passAlignment: 0.7,
} as const;

/** トレーニング「穴をまたぐ」(メニュー3) */
export const HOLES_TASK = {
  /** 穴の列の位置(アキシャル座標の r)。スタートは r = startRow */
  holeRows: [-2, 1, 4],
  startRow: -5,
  timeLimit: 20,
  /** 落下したときの減点 */
  fallPenalty: 10,
  /** 合格条件:越えなければならない穴の列の数 */
  passRows: 2,
} as const;

/** トレーニング「崩落ステージを生き残る」(メニュー4) */
export const SURVIVE_TASK = {
  timeLimit: 60,
  /** レベル1〜5の崩落ペース(安全円の縮小とランダム崩落の進み方の倍率) */
  levelPace: [0.6, 0.8, 1.0, 1.25, 1.5],
  /** 合格に必要なレベル */
  passLevel: 3,
  /** 安全なタイルの上にいるときの加点、危険なタイルの上にいるときの減点 [/s] */
  safeBonus: 1,
  dangerPenalty: 1,
  /** 生存時間1秒あたりの加点 */
  aliveBonus: 0.5,
  fallPenalty: 20,
} as const;

/** トレーニング「BOTとの押し合い」(メニュー5) */
export const PUSH_TASK = {
  /** トレーニング中の試合時間 [s](本番の試合より短くして学習を速くする) */
  timeLimit: 60,
  winBonus: 20,
  losePenalty: 20,
  /** 相手を危険な場所へ近づけた量にかける重み */
  pushWeight: 2,
  aliveBonus: 0.2,
  /** 合格の確認の試合数と、必要な勝ち数(勝率60%) */
  confirmMatches: 10,
  confirmWins: 6,
} as const;

/** マイルストーンの判定 */
export const MILESTONE = {
  /** 「初めて立った」:コアの上方向の鉛直成分がこれ以上で、コアの高さがこれ以上の状態を、この秒数保つ */
  standUpright: 0.9,
  standHeight: 0.5,
  standSeconds: 3,
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
  /** 判断脳のセンサー値をそろえる目安 [m]・[m/s]・[マス] */
  decisionPosScale: 6,
  decisionVelScale: 2,
  decisionDistScale: 8,
  safeRadiusScale: 12,
  /** 運動脳の「足元」:指令方向の前方のこれらの距離 [m] が穴かどうか */
  footingDistances: [0.6, 1.2, 1.8],
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
  sigmaMin: 0.02,
} as const;
