// ゲーム全体の調整パラメータ(仕様書セクション15)。
// 数値はすべて仮の初期値。コード中に直書きせず、必ずここから参照すること。

export const CREATURE = {
  /** 総コスト上限(ブロックの種類と形が増えたので30から40にした) */
  maxCost: 40,
  /** 関節の最大数(脳の入出力サイズを抑えるため) */
  /** 関節とピストン(動かせるブロック)の合計の最大数(脳の入出力サイズを抑えるため) */
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
   * 360°回転の関節(spin):可動範囲がなく、脳の出力(-1〜1)を回る速さ(この値 × 出力 [rad/s])として使う。
   * 速さをそろえる強さ(減衰)[N·m·s/rad]。トルクの上限は jointMaxTorque と同じ
   */
  spinMaxSpeed: 12,
  spinDamping: 20,
  /**
   * ピストン:1マス分(ブロック1辺)だけ伸び縮みする。脳の出力が0以上なら伸ばし、0未満なら縮める
   * (伸び縮みの途中の位置は指定しない)。ばね定数 [N/m]・減衰 [N·s/m]・力の上限 [N]
   */
  pistonStroke: 0.4,
  pistonStiffness: 8000,
  pistonDamping: 300,
  pistonMaxForce: 300,
  /**
   * コライダーを各辺この長さだけ小さくする [m]。
   * 隣り合う別剛体のブロック同士が常に接触して震えるのを防ぐ
   */
  colliderShrink: 0.01,
  /**
   * ブロックの当たり判定の角の丸み [m]。角が立っていると穴の縁やタイルの境目に引っかかりやすいので、
   * 外形の大きさは変えずに角を丸める
   */
  blockRoundness: 0.06,
  /**
   * コアの剛体の回転の減衰(ブレーキ)。関節を動かした反動でコアが回りすぎるのを抑える。
   * 毎秒およそ e^(-値) 倍に弱まる(向きを変える回転にも効くので、大きすぎると曲がりにくくなる)。
   * 既定は0(オフ)。左右2本脚の体で試したところ、10にしても傾きは平均55° → 51° にしか減らなかった
   * (脚が地面について支点になるため、関節のモーターがコアを振り回す)。回転は姿勢の報酬(POSTURE)で学習させて減らす
   */
  coreAngularDamping: 0,
} as const;

/**
 * ブロックの種類。グリップブロックは廃止し、どのブロックにも付けられる「摩擦オン」(BLOCK_OPTIONS)に置き換えた
 * (古いデータのグリップは、読み込むときに「基礎 + 摩擦オン」に変換する。コスト・重さ・摩擦は同じ)
 */
export type BlockType = 'core' | 'base' | 'joint' | 'bouncy' | 'piston' | 'sensor' | 'cloud' | 'wind';

/** ブロックの形。重さはどの形でも同じ */
export type BlockShape = 'cube' | 'sphere' | 'cylinder';

export const BLOCKS: Record<BlockType, { cost: number; mass: number; friction: number; restitution: number }> = {
  core: { cost: 0, mass: 2.0, friction: 0.8, restitution: 0.1 },
  base: { cost: 1, mass: 1.0, friction: 0.8, restitution: 0.1 },
  joint: { cost: 3, mass: 0.5, friction: 0.8, restitution: 0.1 },
  bouncy: { cost: 2, mass: 0.8, friction: 0.8, restitution: 0.9 },
  piston: { cost: 3, mass: 0.6, friction: 0.8, restitution: 0.1 },
  sensor: { cost: 1, mass: 0.5, friction: 0.8, restitution: 0.1 },
  /** 雲:とても軽い。体を大きくしても重くならない(そのぶん押されると飛ばされやすい) */
  cloud: { cost: 1, mass: 0.15, friction: 0.8, restitution: 0.1 },
  /** 風:扇風機のように、吹く向きと反対向きの力が常にかかる(WIND_BLOCK) */
  wind: { cost: 3, mass: 1.0, friction: 0.8, restitution: 0.1 },
};

/** どのブロックにも付けられる設定 */
export const BLOCK_OPTIONS = {
  /** 摩擦オンにしたときの摩擦係数(相手と平均せず大きい方を使う)と、追加のコスト */
  gripFriction: 2.0,
  gripCost: 1,
  /**
   * タイヤモード(円柱にした関節だけ):半径をブロックの半分(0.2m)のこの倍にする。追加のコスト。
   * 回転軸に垂直な4方向の隣のマスには、親以外のブロックを置けない(大きくした円が重ならないように)。
   * 1.5倍(0.3m)なら、斜め隣のマスのブロックとはほぼ重ならない
   */
  tireRadiusScale: 1.5,
  tireCost: 1,
} as const;

/**
 * 風ブロック:扇風機のように、吹く向き(既定は付けた面の向き)と反対向きの力が常にかかる。
 * 力の大きさは「自分の重さ + netLift [kg]」分。下向きに吹けば体が持ち上がり、横向きに吹けば押されて進む。
 * ただし持ち上げる力(上向きの成分)は、ブロックの真下に床があるときだけ働き、床に近いほど強い
 * (床からの高さが groundRange [m] で0)。下に床がない場所(穴の上・ステージの外)では持ち上がらないので、空には逃げられない
 */
export const WIND_BLOCK = {
  netLift: 0.5,
  groundRange: 1.0,
} as const;

/**
 * 弾力ブロック:親のブロックと、付けた面の向きに伸び縮みするばねでつなぐ(脳では動かさない)。
 * 当たると縮み、跳ね返して相手を弾く。縮む量・伸びる量 [m]、ばね定数 [N/m]、減衰 [N·s/m]、力の上限 [N]
 */
export const BOUNCY_SPRING = {
  compress: 0.15,
  stretch: 0.1,
  stiffness: 600,
  damping: 6,
  maxForce: 400,
} as const;

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
  /**
   * ルールB:滞在で危険マークがつくまで [s]、離れたときの減衰比。
   * キャラのどのブロックが触れているタイルにもタイマーが溜まるので、コアだけだったときの3秒から5秒に延ばした
   * (3秒だと脚の多いキャラが立ち止まれず、生き残りの合格がほぼ不可能だった)
   */
  stayLimit: 5.0,
  stayDecayRatio: 0.5,
  /**
   * ルールC:ランダム崩落の開始 [s]、初期間隔 [s]、最終間隔 [s]、最終間隔に達する時刻 [s]。
   * 開始は20秒から12秒に早めた(バトルの4割が20秒より前に決着し、崩落の判断が勝敗に効いていなかったため)
   */
  randomStart: 12,
  randomIntervalStart: 4,
  randomIntervalEnd: 1,
  randomIntervalEndTime: 90,
  /**
   * スポーン:2体の間の距離(マス。中心を挟んで半分ずつ離れる)、落下高さ [m]。
   * 3マスから5マスに広げた(近すぎると開始直後の押し合いだけで決まり、崩落ステージでの立ち回りが効かなかったため)
   */
  spawnDistance: 5,
  spawnHeight: 0.5,
  /** タイルの厚さ [m](上面が y = 0) */
  tileHeight: 0.4,
  tileFriction: 0.8,
  /**
   * ルールB:ブロックの中心の高さがこれ以下なら、そのブロックは真下のタイルに「触れている」とみなす [m]。
   * 置いたブロックの中心は 0.2m(ブロックの半分)なので、少し余裕をもたせる
   */
  stayContactHeight: 0.3,
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

/** トレーニング「ジャンプ」(任意) */
export const JUMP_TASK = {
  timeLimit: 12,
  /** 最初のジャンプ指令の時刻と間隔 [s]、指令を出し続ける長さ [s] */
  firstAt: 1.5,
  interval: 3,
  pulse: 0.5,
  /** 指令からこの時間のあいだの、コアの最高到達点の上がり幅を測る [s] */
  window: 1.0,
  /** 跳ぶ前の高さを測る時間 [s] */
  baseline: 0.5,
  /** 上がり幅 [m] にかける重み */
  heightWeight: 10,
  /** 指令がないのに跳ねたときの減点(上向きの速さがこれを超えたら) [m/s] と、その重み [/s] */
  idleVelocity: 1,
  idlePenalty: 1,
  /** 合格条件:1回のジャンプでコアが上がった高さの平均 [m] */
  passHeight: 0.25,
} as const;

/** トレーニング「危険なタイルを避ける」(崩れないステージで、危険なタイルを踏むと減点) */
export const AVOID_TASK = {
  timeLimit: 60,
  /** 崩落ルールの進み方(生き残りのレベル3と同じ) */
  pace: 0.6,
  /** 安全なタイルの上での加点・危険マークのタイル・崩れたはずのタイル(穴のかわり)の上での減点 [/s] */
  safeBonus: 1,
  warningPenalty: 1,
  forbiddenPenalty: 4,
  fallPenalty: 20,
  /** 合格条件:崩れたはずのタイルに触れていた時間の合計がこれ未満で、60秒落ちなかった [s] */
  passForbiddenTime: 3,
  /** 合格の確認:confirmEpisodes 回のうち、条件を満たす必要がある回数(合格しやすくするため6回から半分にした) */
  confirmEpisodes: 9,
  confirmPassCount: 3,
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
  /**
   * レベル1〜5の崩落ペース(安全円の縮小とランダム崩落の進み方の倍率)。レベル5がバトルと同じペース。
   * バトルのペースでは60秒時点で安全円の中の安全なタイルが十数枚しか残らず、1体でも60秒生き残るのが
   * ほぼ不可能なため、合格のレベル3はバトルの0.6倍のペースにしている(関門2の調整)
   */
  levelPace: [0.4, 0.5, 0.6, 0.8, 1.0],
  /** 合格に必要なレベル */
  passLevel: 3,
  /** 合格の確認:confirmEpisodes 回のうち、生き残る必要がある回数(合格しやすくするため6回から半分にした) */
  confirmEpisodes: 9,
  confirmPassCount: 3,
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
  /**
   * 勝ち負けの報酬。見ていて楽しい「押し出し」を重く、相手の自滅による勝ちは軽くする
   * (押し出し = 2体のブロックが触れてから2秒以内に落ちた)
   */
  winPushBonus: 30,
  winFallBonus: 5,
  losePushedPenalty: 30,
  loseFellPenalty: 20,
  /** 相手に近づいた距離にかける重み [/m](この距離より離れているときだけ) */
  approachWeight: 0.5,
  approachRange: 1.5,
  /** 相手に触れている間の加点 [/s] */
  contactBonus: 1,
  /** 相手を危険な場所へ近づけた量にかける重み */
  pushWeight: 2,
  aliveBonus: 0.2,
  /**
   * 合格の確認:突進BOTと標準BOTのそれぞれと confirmMatches 試合ずつ戦い、どちらにも confirmWins 勝以上(勝率30%)。
   * 以前は標準BOTだけだったので、突進BOTに勝てなくても合格できていた
   */
  confirmMatches: 10,
  confirmWins: 3,
} as const;

/**
 * センサーブロック(罰ブロック):トレーニング中に地面に触れていると減点する(バトルでは普通のブロックと同じ)。
 * 2足歩行の頭など、地面に触れてほしくない場所に付けて「倒れないこと」を学ばせる
 */
export const SENSOR = {
  penaltyPerSec: 2,
} as const;

/** 種目「かけっこ」:まっすぐ走って、ゴールまでのタイム(届かなければ進んだ距離)を競う */
export const RACE = {
  /** ゴールまでの距離 [m] */
  distance: 20,
  timeLimit: 60,
  /** 一度に走る人数と、レーンの間隔 [m] */
  maxRunners: 4,
  laneWidth: 3,
} as const;

/** サッカーの役割:シューター(ボールを取りに行きシュート)・ブロッカー(ゴール前で止める)・キャリアー(拾ってドリブル) */
export type SoccerRole = 'shooter' | 'blocker' | 'carrier';

/**
 * 種目「サッカー」(3対3)。ロケットリーグのような、角の丸い半透明の柵で囲まれた大きなフィールド。
 * 大きなキャラでもゴールに入れるよう、ゴールは幅6m・高さ3m。
 * ボールは少し低重力(重力の ballGravityScale 倍)で、ballMaxSpeed より速くはならない。ゴールしたら上空から落ちてくる
 */
export const SOCCER = {
  /** フィールドの半分の幅(x)と半分の長さ(z) [m] */
  halfWidth: 9,
  halfLength: 15,
  /** 柵の角の丸みの半径 [m] と、丸みを作る板の数 */
  cornerRadius: 3,
  cornerSegments: 6,
  /** ゴールの幅・高さ・奥行き [m] */
  goalWidth: 6,
  goalHeight: 3,
  goalDepth: 2.5,
  /** 柵の高さと厚み [m]、表示の透明度 */
  wallHeight: 5,
  wallThickness: 0.4,
  wallOpacity: 0.18,
  ballRadius: 0.55,
  ballMass: 0.8,
  ballRestitution: 0.6,
  ballFriction: 0.6,
  /** 転がりを少しずつ弱める */
  ballDamping: 0.3,
  /** ボールにかかる重力の倍率(少し低重力)と、速さの上限 [m/s] */
  ballGravityScale: 0.5,
  ballMaxSpeed: 9,
  /** ゴールしたあと、ボールを落とす高さ [m] */
  ballDropHeight: 7,
  timeLimit: 120,
  teamSize: 3,
  /** シューター:ボールの後ろに回り込む距離 [m]。この距離まで近づいたらゴールへ押し込む */
  approachOffset: 1.2,
  pushStartDist: 0.9,
  /** ブロッカー:ゴールラインから前に出て待つ距離 [m]と、ボールを取りに出る距離 [m] */
  blockerLine: 2,
  blockerReach: 7,
  /** キャリアー:ドリブルのときの速さ */
  carrySpeed: 0.75,
} as const;

/**
 * サッカー脳(役割ごとに1つ):入力19・中間16・出力3(進む方向2・速さ1)。センサー値をそろえる目安 [m]・[m/s]。
 * 入力の最後の3つは「お手本の動き」(その役割の手書きの動きの向きと速さ)。最初の脳はお手本どおりに動くように作り、
 * そこから上手になるよう鍛える(何も知らない状態から学ぶと、ボールに触れることすらなかなか覚えないため)
 */
export const SOCCER_BRAIN = {
  inputs: 19,
  hidden: 16,
  outputs: 3,
  posScale: 15,
  velScale: 6,
} as const;

/**
 * サッカーのトレーニング(役割ごとの練習)。1回 time 秒。合格の確認は confirmEpisodes 回のうち confirmPassCount 回
 *   シューター:相手のブロッカー(自分と同じ体のBOT)が守るゴールにシュートを決める
 *   ブロッカー:相手陣から飛んでくるシュート(shots 本)を止め、ボールが遠いときはゴール前に戻る
 *   キャリアー:ボールを拾い、追いかけてくるBOTから守りながら、前へ運ぶ(carryGoal [m] 運べば成功)
 */
export const SOCCER_DRILL = {
  time: 25,
  confirmEpisodes: 9,
  confirmPassCount: 3,
  /** シューター:ゴールの加点、ボールがゴールに近づいた距離の重み [/m]、ボールに近づいた距離の重み [/m] */
  goalBonus: 20,
  ownGoalPenalty: 20,
  ballProgressWeight: 1,
  approachWeight: 0.3,
  /**
   * キャラは歩くのが遅い(標準BOTで秒速0.5mほど)ので、練習はゴールやボールの近くで行う。
   * シューター:ゴールラインから shooterStart [m] 手前に立ち、ボールはその前 ballAhead [m] あたりに落とす
   */
  shooterStart: 7,
  ballAhead: 2,
  /** ブロッカー:シュートの本数・間隔 [s]・速さ [m/s]、許せる失点、止めた加点・決められた減点、ゴール前に戻る重み [/s] */
  shots: 4,
  shotInterval: 6,
  shotSpeedMin: 4,
  shotSpeedMax: 6,
  allowedGoals: 1,
  blockBonus: 5,
  concedePenalty: 10,
  homeWeight: 0.3,
  touchBonus: 0.5,
  /** キャリアー:ボールを持っているとみなす距離 [m]、持っている間の加点 [/s]・前に運んだ距離の重み [/m]、離れている間の減点 [/s] */
  dribbleRadius: 2,
  closeBonus: 0.5,
  carryWeight: 1.5,
  farPenalty: 0.3,
  carryGoal: 3,
  /** キャリアーを追いかけるBOTの速さと、スタートの距離 [m] */
  chaserSpeed: 0.35,
  chaserDistance: 12,
} as const;

/** トレーニング「かけっこ」(全力疾走):RACE.distance を何秒で走れるか。合格は confirmEpisodes 回のうち confirmPassCount 回 passTime 秒以内 */
export const SPRINT_TASK = {
  timeLimit: 40,
  passTime: 30,
  finishBonus: 10,
  confirmEpisodes: 3,
  confirmPassCount: 2,
} as const;

/**
 * 種目「長距離」(かけっこの発展):楕円のトラックを laps 周する。トラックには1周あたり checkpoints 個のチェックポイントがあり、
 * 順番どおりに全部通らないと周回にならない(内側を横切って近道しても、取っていないチェックポイントは数えない)。
 * トラックは、長さ straight [m] のまっすぐな部分2本と、半径 radius [m] の半円2つ。幅 width [m]
 */
export const TRACK = {
  straight: 8,
  radius: 4,
  width: 4,
  checkpoints: 8,
  /** チェックポイントを通ったとみなす、トラックの中心線からの距離 [m] */
  checkpointRadius: 2.2,
  laps: 3,
  timeLimit: 300,
  maxRunners: 4,
  /** トレーニング「長距離」:1周を lapTimeLimit 秒まで。passLapTime 秒以内の1周が confirmEpisodes 回中 confirmPassCount 回で合格 */
  lapTimeLimit: 120,
  passLapTime: 100,
  checkpointBonus: 3,
  lapBonus: 10,
  confirmEpisodes: 3,
  confirmPassCount: 2,
  /** ランキングの長距離の公式記録を測るシード(1体だけで3周を走らせる) */
  recordSeed: 404,
} as const;

/** 種目「ジャンプ」:決まった間隔でジャンプ指令を出し、コアがどれだけ高く上がったかの最高記録を競う */
export const HIGH_JUMP = {
  /** 1人あたりのジャンプの回数・最初の指令の時刻 [s]・間隔 [s]・1回を測る時間 [s] */
  attempts: 5,
  firstAt: 1.5,
  interval: 3,
  window: 1.5,
  /** 一度に跳ぶ人数と、レーンの間隔 [m] */
  maxJumpers: 4,
  laneWidth: 3,
  /** 公式記録のシード(ランキング用) */
  seeds: [11, 22, 33],
} as const;

/**
 * 姿勢の報酬(運動脳のトレーニングだけ):コアの傾きと、前後・左右に転がる回転の速さで減点する。
 * 関節を動かした反動でコアが回ってしまう動きを減らし、回らずに進む動き方を覚えさせる。
 * 鉛直軸まわりの回転(向きを変える回転)は減点しない
 */
export const POSTURE = {
  /**
   * 歩くときの自然な揺れは減点しないよう、傾きは tiltFree [rad] まで、転がる回転は rollFree [rad/s] までは減点しない
   * (はじめは閾値なしにしたところ、2本脚の体が「まったく動かない」ことを覚えてしまった)
   */
  tiltFree: Math.PI / 6,
  rollFree: 2,
  /** 傾きの減点 [/s](横倒しのとき、この値) */
  tiltWeight: 0.3,
  /** 転がる回転の減点 [/s](rollScale 以上の速さで、この値) */
  rollWeight: 0.3,
  rollScale: 5,
} as const;

/** ランクマッチ(自動トーナメント)とランキング */
/**
 * 計算の版。試合の結果が変わる変更(物理・ブロック・脳の入出力・ステージのルールなど)をしたら1つ上げる。
 * ランクマッチの報告にこの版をつけ、サーバーは試合ごとに「いちばん新しい版」の報告の中で多数決をとる
 * (古いページが違う結果を報告しても、新しい版の結果が正式になり、どの端末でも同じ結果になる)
 */
export const SIM_VERSION = 2;

export const RANKED = {
  /** トーナメントの間隔 [s](この間隔ごとに新しいトーナメントが始まる。サーバーの報告のルールと同じ値にすること) */
  interval: 1800,
  /** 1試合の枠 [s](試合の最大150秒 + 前後の間) */
  slot: 180,
  /** 試合が始まるまでの間 [s] */
  intro: 10,
  /** 1回のトーナメントの最大出場数(多いときはシードで抽選する) */
  maxEntrants: 8,
  /** レート(Elo)の初期値と変動の大きさ */
  initialRating: 1500,
  kFactor: 32,
  /** かけっこの記録を測るシード(この中の最速を記録にする) */
  raceSeeds: [101, 202, 303],
} as const;

/** マイルストーンの判定 */
export const MILESTONE = {
  /** 「初めて立った」:コアの上方向の鉛直成分がこれ以上で、コアの高さがこれ以上の状態を、この秒数保つ */
  standUpright: 0.9,
  standHeight: 0.5,
  standSeconds: 3,
} as const;

export const BRAIN = {
  /** 運動脳の入力のうち、体によらない部分(指令3・姿勢3・速度6・リズム2・足元3・ジャンプ指令1) */
  motorFixedInputs: 18,
  motorHidden: 32,
  /** 判断脳の「目」:コアのまわり何周分のタイルを見るか(4周 = 61マス) */
  eyeRings: 4,
  /**
   * 判断脳の入力:目61・自分3・相手7・安全円5・時間1・相手との接触4(触れているか・近づく速さ・いちばん近いブロックまでの距離・相手の周りの危険度)・
   * 相手の向きと体の形9(相手の正面の向き2・こちらを向いているか1・重さの比べ1・体の伸び4方向・体の高さ1)・
   * 体の傾きと回転12(自分と相手の、コアの上が向いている方向3と回転の速さ3)
   */
  decisionInputs: 102,
  decisionHidden: 24,
  /** 判断脳の出力:進む方向2・速さ1・ジャンプ指令1 */
  decisionOutputs: 4,
  /** センサー値を -1〜1 程度にそろえるための目安 */
  linvelScale: 2,
  angvelScale: 5,
  jointVelScale: 10,
  pistonVelScale: 2,
  /** 判断脳のセンサー値をそろえる目安 [m]・[m/s]・[マス] */
  decisionPosScale: 6,
  decisionVelScale: 2,
  decisionDistScale: 8,
  /** 判断脳:いちばん近いブロック同士の距離をそろえる目安 [m](これより離れていれば 1) */
  decisionContactScale: 2,
  /** 判断脳:相手の体の伸び・高さをそろえる目安 [m] */
  decisionShapeScale: 2,
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
  /**
   * 判断脳のメニューは試合の運に左右されやすいので、1世代の評価を多めにし(decisionEpisodesPerGeneration)、
   * さらに上位 reevalTop 個体だけ reevalEpisodes 試合を追加して、合わせた平均で選び直す
   */
  decisionEpisodesPerGeneration: 5,
  reevalTop: 4,
  reevalEpisodes: 5,
  /** 押し合いの自己対戦:この世代数ごとに、その時点の最優秀の判断脳を「過去の自分」として相手に加える */
  selfPlayInterval: 20,
} as const;

/** 成績表(src/core/training/report.ts):相手ごとの試合数・生き残りの回数・固定のシード */
export const REPORT = {
  matches: 8,
  surviveRuns: 8,
  seed: 90210,
} as const;

/** 作戦タイプ(押し合い・ライバル練習試合の報酬の重み)。数値は PUSH_TASK の各報酬にかける倍率 */
export type TrainStyle = 'balanced' | 'attack' | 'survive';
export const STYLES: Record<
  TrainStyle,
  {
    label: string;
    note: string;
    winPush: number;
    winFall: number;
    losePushed: number;
    loseFell: number;
    approach: number;
    contact: number;
    push: number;
    alive: number;
    /** 自分が危険なタイルの上にいる間の減点 [/s](生き残りと同じ考え方) */
    danger: number;
  }
> = {
  balanced: {
    label: 'バランス',
    note: '押し出しと生き残りを両方ほどほどに評価する(これまでと同じ)',
    winPush: 1,
    winFall: 1,
    losePushed: 1,
    loseFell: 1,
    approach: 1,
    contact: 1,
    push: 1,
    alive: 1,
    danger: 0,
  },
  attack: {
    label: '攻め(押し出し重視)',
    note: '押し出して勝つことを高く評価する。相手に近づき、触れて、崖へ押し込む動きを覚えやすい',
    winPush: 2.5,
    winFall: 1,
    losePushed: 1,
    loseFell: 1,
    approach: 2,
    contact: 2,
    push: 1.5,
    alive: 1,
    danger: 0,
  },
  survive: {
    label: '守り(生き残り重視)',
    note: '生き残ることを高く評価する。危ないタイルを避け、自滅しない動きを覚えやすい',
    winPush: 1,
    winFall: 1,
    losePushed: 1.5,
    loseFell: 2,
    approach: 0.5,
    contact: 0.5,
    push: 1,
    alive: 5,
    danger: 1,
  },
};
