// 対戦のおじゃまのやり取り。数値はぷよテト（WiiU/3DS版）の非公式解析を参考にしている
// 参考: http://clocklaboratory.s1001.xrea.com/game/others/puyotetris.html
// PS4/Switch版では調整が入っている（ぷよ側の攻撃力強化、テトリス側のREN・全消しの弱体化、マージンタイムはぷよ側のみ）が、変更幅の数値は見つからなかった
// 参考: https://ja.wikipedia.org/wiki/ぷよぷよテトリス

// テトリスの攻撃（ランプ数）→ おじゃまぷよ数（添字がランプ数、最大60）
const LAMPS_TO_NUISANCE = [
  0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68, 75, 83, 92,
  102, 113, 125, 138, 152, 167, 183, 200, 218, 237, 257, 278, 300, 323, 347, 372, 398, 425, 453, 482,
  512, 543, 575, 608, 642, 677, 713, 750, 788, 827, 867, 908, 950, 993, 1037, 1082, 1128, 1175, 1223, 1272,
];
const MAX_LAMPS = 60;

// ぷよの連鎖1回分の点数（＋持ち越し）→ テトリスへ送るライン数の基準点。添字+1 がライン数
// 6・7段の値は解析元でも「?」付き。8段以上は不明なので7段で頭打ちにしている
const PUYO_TO_LINES_THRESHOLDS = [210, 630, 1050, 1710, 3500, 7000, 14000];

// 相手に送るおじゃまの量にかける倍率（ゲームバランス調整用。1 で解析値そのまま＝公式に近い）
// 相殺に使う量にはかけない。以前は送る量が多すぎると感じて 0.7 にしていた（戻したいときは 0.7 にする）
const GARBAGE_MULTIPLIER = {
  tetrisToTetris: 1.0,
  tetrisToPuyo: 1.0,
  puyoToTetris: 1.0,
  puyoToPuyo: 1.0,
};

// 大きな予告が来たときの警告（画面を赤く光らせ、警告音を鳴らす）の基準
// ぷよ側：テトリスのランプが11以上（おじゃまぷよ33個相当）になると警告が出る。これは解析元に書かれている
//   参考: http://clocklaboratory.s1001.xrea.com/game/others/puyotetris.html
// テトリス側：ぷよの予告の「大」（6段）以上。予告の記号の大きさは公式の仕様
//   参考: https://puyonexus.com/wiki/Nuisance_queue
// 警告「音」の仕様は調べても見つからなかったので、鳴らす条件を上の基準に合わせて、音は独自に作っている
const ALERT_PUYO_NUISANCE = 33;
const ALERT_PUYO_LAMPS = 11;
const ALERT_TETRIS_LINES = 6;

const PUYO_TARGET_POINTS = 70; // ぷよ同士：70点でおじゃまぷよ1個（ぷよぷよ通）
const TETRIS_MAX_RISE_VS_PUYO = 7; // ぷよから受けたおじゃまは一度に7段までせり上がる

// マージンタイム：開始から96秒後、16秒ごとにぷよのレートを 3/4 → 2/3 → 3/4 … 倍にしていく
const MARGIN_TIME = 96000;
const MARGIN_STEP = 16000;
const MARGIN_RATIOS = [3 / 4, 2 / 3];
// PS4/Switch版（アップデート後）のマージンタイムはぷよ側のみに効くため、テトリス側は増やさない
// （WiiU/3DS版はテトリス側も増えるが増え方は不明）。テトリス側も増やしたいときは 0〜1 でぷよの増加分に対する割合を指定する
const TETRIS_MARGIN_SHARE = 0;

const Garbage = {
  multiplier(fromTetris, toTetris) {
    const from = fromTetris ? "tetris" : "puyo";
    const to = toTetris ? "Tetris" : "Puyo";
    return GARBAGE_MULTIPLIER[`${from}To${to}`];
  },

  // 経過時間に応じたぷよのレート（大きいほど攻撃が弱い）
  puyoRate(elapsed) {
    let rate = PUYO_TARGET_POINTS;
    if (elapsed < MARGIN_TIME) return rate;
    const steps = Math.floor((elapsed - MARGIN_TIME) / MARGIN_STEP) + 1;
    for (let i = 0; i < steps; i++) {
      rate = Math.max(1, Math.floor(rate * MARGIN_RATIOS[i % 2]));
    }
    return rate;
  },

  // テトリスの攻撃にかける倍率
  tetrisMultiplier(elapsed) {
    const puyoBoost = PUYO_TARGET_POINTS / this.puyoRate(elapsed);
    return 1 + (puyoBoost - 1) * TETRIS_MARGIN_SHARE;
  },

  lampsToNuisance(lamps) {
    return LAMPS_TO_NUISANCE[Math.min(lamps, MAX_LAMPS)];
  },

  // ぷよの点数をテトリスへのライン数に変える。基準点はマージンタイムのレートに合わせて下げる
  // 返り値 { lines, carry }：carry は次の連鎖に持ち越す点数
  puyoScoreToLines(points, rate) {
    const scale = rate / PUYO_TARGET_POINTS;
    let lines = 0;
    while (lines < PUYO_TO_LINES_THRESHOLDS.length && points >= PUYO_TO_LINES_THRESHOLDS[lines] * scale) {
      lines++;
    }
    const used = lines > 0 ? PUYO_TO_LINES_THRESHOLDS[lines - 1] * scale : 0;
    return { lines, carry: points - used };
  },
};

// 1人分のおじゃまの状態。数は受け取る側の単位（テトリスならライン数、ぷよなら個数）
class GarbageState {
  constructor() {
    this.ready = 0; // 次の機会に降る分
    this.pending = 0; // 相手の連鎖中で、まだ確定していない分（連鎖が終わると ready に移る）
    this.gauge = 0; // テトリスが対ぷよで溜めているランプ数
    this.carry = 0; // ぷよの攻撃の持ち越し点
    this.fraction = 0; // 送る量に倍率をかけて出た端数（次の攻撃に持ち越す）
    this.offsetCarry = 0; // ぷよがテトリスのおじゃまを相殺するときの持ち越し点
    this.counterStarted = false; // ぷよ vs テトリス：相殺し切って攻撃に移ったか
    this.alerted = false; // 大きな予告の警告を出している間 true（下がるまで二重に鳴らさない）
    this.hole = Math.floor(Math.random() * COLS); // テトリスのおじゃまの穴の列
  }

  get total() {
    return this.ready + this.pending;
  }

  // 自分に来ているおじゃまを amount だけ打ち消し、打ち消し切れなかった攻撃量を返す
  offset(amount) {
    const fromReady = Math.min(this.ready, amount);
    this.ready -= fromReady;
    amount -= fromReady;
    const fromPending = Math.min(this.pending, amount);
    this.pending -= fromPending;
    return amount - fromPending;
  }

  // 連鎖が終わったら次の連鎖のために持ち越しを捨てる
  resetChain() {
    this.carry = 0;
    this.offsetCarry = 0;
    this.counterStarted = false;
  }
}
