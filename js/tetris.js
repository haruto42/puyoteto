const COLS = 10;
const VISIBLE_ROWS = 20; // 見える段数
const BUFFER_ROWS = 20; // 見える盤面より上の、見えない段数（ガイドラインと同じく20段）
const ROWS = VISIBLE_ROWS + BUFFER_ROWS; // 盤面の配列の段数。0〜19段目が見えない段
const NEXT_COUNT = 5; // ぷよテトと同じくNEXTを5個表示
const LOCK_DELAY = 500; // 接地してから固定されるまで（ミリ秒、ガイドライン標準）
const MAX_LOCK_RESETS = 15; // 接地中に固定タイマーをやり直せる回数
// 置いてから次のミノが出るまでの硬直（ぷよぷよテトリス PS4版の計測値。操作は効かない）
// 参考: https://harddrop.com/wiki/Puyo_Puyo_Tetris_timings
//   ライン消しなし 7F / ライン消し 30F + 消した段数ごとの追加（1段 5F・2〜3段 10F・4段 15F）/ 全消し 1F
const ENTRY_DELAY = 7 * FRAME;
const LINE_CLEAR_BASE_DELAY = 30 * FRAME;
const LINE_CLEAR_EXTRA_DELAY = [0, 5 * FRAME, 10 * FRAME, 10 * FRAME, 15 * FRAME]; // 添字は消した段数
const PERFECT_CLEAR_DELAY = 1 * FRAME;

function lineClearDelay(cleared, perfectClear) {
  if (perfectClear) return PERFECT_CLEAR_DELAY;
  return LINE_CLEAR_BASE_DELAY + (LINE_CLEAR_EXTRA_DELAY[cleared] ?? 0);
}
const GARBAGE_RISE_STEP = 80; // おじゃまブロックが1段せり上がる間隔（ミリ秒）

// 得点（ガイドライン標準、レベル1あたり）。添字は消したライン数
const SCORE_LINES = [0, 100, 300, 500, 800];
const SCORE_TSPIN = [400, 800, 1200, 1600];
const SCORE_TSPIN_MINI = [100, 200, 400];
const SCORE_PERFECT_CLEAR = [0, 800, 1200, 1800, 2000];
const BACK_TO_BACK_MULTIPLIER = 1.5;
const COMBO_POINTS = 50; // × REN数
const SOFT_DROP_POINTS = 1; // 1段ごと
const HARD_DROP_POINTS = 2; // 1段ごと

// 攻撃力（ぷよテトの解析値。対テト・対ぷよ共通）。添字は消したライン数
const ATTACK_LINES = [0, 0, 1, 2, 4];
const ATTACK_TSPIN = [0, 2, 4, 6];
const ATTACK_TSPIN_MINI = [0, 0, 1];
const ATTACK_BACK_TO_BACK = 1;
const ATTACK_PERFECT_CLEAR = 10;
const GARBAGE_COLOR = "G"; // せり上がったおじゃまブロック

// REN数に応じた攻撃力の追加分（1〜3REN:1、4〜5:2、6〜7:3、8〜10:4、11以上:5）
function renAttack(combo) {
  if (combo <= 0) return 0;
  if (combo <= 3) return 1;
  if (combo <= 5) return 2;
  if (combo <= 7) return 3;
  if (combo <= 10) return 4;
  return 5;
}

// 消し方（lastClear と同じ形）から攻撃力を求める
function attackOf(clear) {
  if (clear.cleared === 0) return 0;
  const table = clear.tSpin === "full" ? ATTACK_TSPIN : clear.tSpin === "mini" ? ATTACK_TSPIN_MINI : ATTACK_LINES;
  let attack = table[clear.cleared] ?? 0;
  if (clear.backToBack) attack += ATTACK_BACK_TO_BACK;
  attack += renAttack(clear.combo);
  if (clear.perfectClear) attack += ATTACK_PERFECT_CLEAR;
  return attack;
}

// 各ミノの形（1 = ブロック）。回転は行列の回転で求める
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
};

const COLORS = {
  I: "cyan",
  O: "yellow",
  T: "purple",
  S: "lime",
  Z: "red",
  J: "blue",
  L: "orange",
  G: "#777",
};

// SRSの壁蹴りテーブル（ガイドライン標準）。キーは "回転前>回転後"、0=出現時 1=R 2=180° 3=L
// 座標は公式表記どおり y が上向きなので、適用時に符号を反転する
const KICKS_JLSTZ = {
  "0>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "1>0": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "1>2": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "2>1": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "2>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "3>2": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "3>0": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "0>3": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I = {
  "0>1": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "1>0": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "1>2": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  "2>1": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "2>3": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  "3>2": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  "3>0": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  "0>3": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// ミノの出現位置。見える盤面のすぐ上の2段に出る
function spawnPosition(type) {
  return { x: Math.floor((COLS - SHAPES[type].length) / 2), y: BUFFER_ROWS - 2 };
}

function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

function rotateClockwise(shape) {
  const n = shape.length;
  return shape.map((row, y) => row.map((_, x) => shape[n - 1 - x][y]));
}

function rotateCounterClockwise(shape) {
  const n = shape.length;
  return shape.map((row, y) => row.map((_, x) => shape[x][n - 1 - y]));
}

class Tetris {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = createBoard();
    this.lines = 0;
    this.score = 0;
    this.level = 1;
    this.combo = -1; // ライン消しが続いた回数 - 1（-1 は途切れている状態）
    this.backToBack = false;
    this.lastClear = null; // 直前の消し方（画面表示用）
    this.gameOver = false;
    this.clearDelay = 0; // 置いた後、次のミノが出るまでの残り時間（ミリ秒）
    this.clearingBoard = null; // 待ち時間中に表示する、消える行が残った状態の盤面
    this.events = []; // 効果音・エフェクト用に起きたことを記録する。描画側が毎フレーム取り出す
    this.queue = [];
    this.hold = null;
    this.canHold = true;
    // 対戦用：ラインを消さずに置いたときに呼ばれ、対戦側が queueGarbage() でせり上げる量を決める（一人用では null）
    this.onNoClearLock = null;
    this.garbageToRise = 0; // これからせり上がる段数。0 になるまで次のミノは出ない
    this.garbageHole = 0;
    this.riseTimer = 0;
    this.spawn(this.nextType());
  }

  // せり上げるおじゃまを予約する。次のミノが出る前に1段ずつせり上がる
  queueGarbage(count, hole) {
    this.garbageToRise += count;
    this.garbageHole = hole;
  }

  // おじゃまブロックを下からせり上げる。各段の hole 列だけ空ける
  // 押し上げられたブロックは見えない段に残る。見えない段（20段）の上端まで突き抜けたときだけゲームオーバー
  addGarbage(count, hole) {
    for (let i = 0; i < count; i++) {
      if (this.board[0].some((cell) => cell)) {
        this.gameOver = true;
        this.events.push({ type: "gameOver" });
        return;
      }
      this.board.shift();
      const row = Array(COLS).fill(GARBAGE_COLOR);
      row[hole] = null;
      this.board.push(row);
    }
  }

  // 7種1巡（7-bag）で偏りなくミノを出す。NEXT表示のため常に先の分まで補充しておく
  fillQueue() {
    while (this.queue.length < NEXT_COUNT) {
      const bag = Object.keys(SHAPES);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      this.queue.push(...bag);
    }
  }

  nextType() {
    this.fillQueue();
    const type = this.queue.shift();
    this.fillQueue();
    return type;
  }

  // ホールドは1ミノにつき1回まで（固定されると再び使える）
  holdPiece() {
    if (!this.canControl() || !this.canHold) return;
    const current = this.piece.type;
    const next = this.hold ?? this.nextType();
    this.hold = current;
    this.canHold = false;
    this.events.push({ type: "hold" });
    this.spawn(next);
  }

  // 現在のミノのブロックの盤面座標の一覧
  pieceCells() {
    const { shape, x, y } = this.piece;
    const cells = [];
    shape.forEach((row, dy) => {
      row.forEach((cell, dx) => {
        if (cell) cells.push({ x: x + dx, y: y + dy });
      });
    });
    return cells;
  }

  spawn(type) {
    this.piece = {
      type,
      shape: SHAPES[type],
      rotation: 0,
      ...spawnPosition(type),
    };
    this.lockTimer = 0;
    this.lockResets = 0;
    this.touchedGround = false;
    this.lowestY = this.piece.y;
    this.lastWasRotation = false; // Tスピン判定用：最後の操作が回転だったか
    this.lastKickIndex = 0;
    // ブロックアウト：出現位置が埋まっていたらゲームオーバー
    if (this.collides(this.piece.shape, this.piece.x, this.piece.y)) {
      this.gameOver = true;
      this.events.push({ type: "gameOver" });
    }
  }

  // ハードドロップした場合に止まる y 座標（ゴースト表示用）
  ghostY() {
    const { shape, x } = this.piece;
    let y = this.piece.y;
    while (!this.collides(shape, x, y + 1)) y++;
    return y;
  }

  isGrounded() {
    const { shape, x, y } = this.piece;
    return this.collides(shape, x, y + 1);
  }

  // 接地後の移動・回転で固定タイマーをやり直す（ガイドライン：やり直しは15回まで）
  onManipulate() {
    if (!this.touchedGround) return;
    this.lockResets++;
    if (this.lockResets <= MAX_LOCK_RESETS) {
      this.lockTimer = 0;
    }
  }

  // これまでより低い段に落ちたら、やり直し回数も含めて最初から数え直す
  onFall() {
    if (this.piece.y > this.lowestY) {
      this.lowestY = this.piece.y;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.touchedGround = false;
    }
  }

  // ライン消しの待ち時間中とゲームオーバー後は操作できない（piece が null）
  canControl() {
    return !this.gameOver && this.piece !== null;
  }

  // 毎フレーム呼ぶ。ライン消しの待ち時間を進め、接地中は固定タイマーを進める
  update(dt) {
    if (this.garbageToRise > 0) {
      this.updateGarbageRise(dt);
      return;
    }
    if (this.clearDelay > 0) {
      this.clearDelay -= dt;
      if (this.clearDelay <= 0) {
        this.clearingBoard = null;
        this.spawn(this.nextType());
      }
      return;
    }
    if (!this.canControl() || !this.isGrounded()) return;
    this.touchedGround = true;
    if (this.lockResets > MAX_LOCK_RESETS) {
      this.lock();
      return;
    }
    this.lockTimer += dt;
    if (this.lockTimer >= LOCK_DELAY) {
      this.lock();
    }
  }

  updateGarbageRise(dt) {
    this.riseTimer += dt;
    while (this.riseTimer >= GARBAGE_RISE_STEP && this.garbageToRise > 0) {
      this.riseTimer -= GARBAGE_RISE_STEP;
      this.addGarbage(1, this.garbageHole);
      this.garbageToRise--;
      if (this.gameOver) return;
    }
    if (this.garbageToRise === 0) this.spawn(this.nextType());
  }

  collides(shape, px, py) {
    for (let y = 0; y < shape.length; y++) {
      for (let x = 0; x < shape[y].length; x++) {
        if (!shape[y][x]) continue;
        const bx = px + x;
        const by = py + y;
        if (bx < 0 || bx >= COLS || by >= ROWS) return true;
        if (by >= 0 && this.board[by][bx]) return true;
      }
    }
    return false;
  }

  move(dx, dy) {
    if (!this.canControl()) return false;
    const { shape, x, y } = this.piece;
    if (this.collides(shape, x + dx, y + dy)) return false;
    this.piece.x += dx;
    this.piece.y += dy;
    this.lastWasRotation = false;
    if (dx !== 0) this.events.push({ type: "move" });
    if (dy > 0) {
      this.onFall();
    } else {
      this.onManipulate();
    }
    return true;
  }

  // SRS：回転後にぶつかる場合、テーブルの順に位置をずらして最初に置ける場所へ移す
  rotate(clockwise) {
    if (!this.canControl()) return;
    const piece = this.piece;
    if (piece.type === "O") return;

    const rotated = clockwise
      ? rotateClockwise(piece.shape)
      : rotateCounterClockwise(piece.shape);
    const to = (piece.rotation + (clockwise ? 1 : 3)) % 4;
    const table = piece.type === "I" ? KICKS_I : KICKS_JLSTZ;

    const kicks = table[`${piece.rotation}>${to}`];
    for (let i = 0; i < kicks.length; i++) {
      const [kx, ky] = kicks[i];
      if (!this.collides(rotated, piece.x + kx, piece.y - ky)) {
        piece.shape = rotated;
        piece.rotation = to;
        piece.x += kx;
        piece.y -= ky;
        this.lastWasRotation = true;
        this.lastKickIndex = i;
        this.events.push({ type: "rotate" });
        this.onManipulate();
        // 壁蹴りで下に落ちた場合も「より低い段」として扱う
        this.onFall();
        return;
      }
    }
  }

  // 1段落とす。接地していても固定はしない（固定は update() の猶予で判断）
  step() {
    return this.move(0, 1);
  }

  softDrop() {
    if (this.step()) this.score += SOFT_DROP_POINTS;
  }

  hardDrop() {
    if (!this.canControl()) return;
    const startCells = this.pieceCells();
    let distance = 0;
    while (this.move(0, 1)) {
      this.score += HARD_DROP_POINTS;
      distance++;
    }
    this.events.push({ type: "hardDrop", cells: startCells, distance });
    this.lock();
  }

  // 固定する直前に呼ぶ。null / "mini" / "full" を返す
  // ガイドラインの3コーナールール：Tの中心から見た四隅のうち3つ以上が埋まっていればTスピン
  detectTSpin() {
    const { type, x, y, rotation } = this.piece;
    if (type !== "T" || !this.lastWasRotation) return null;

    const isFilled = (bx, by) =>
      bx < 0 || bx >= COLS || by >= ROWS || (by >= 0 && this.board[by][bx] !== null);
    const cx = x + 1;
    const cy = y + 1;
    // 四隅を 左上・右上・右下・左下 の順に並べる
    const corners = [
      isFilled(cx - 1, cy - 1),
      isFilled(cx + 1, cy - 1),
      isFilled(cx + 1, cy + 1),
      isFilled(cx - 1, cy + 1),
    ];
    if (corners.filter(Boolean).length < 3) return null;

    // Tの尖った側の2隅（向き 0:上 1:右 2:下 3:左）。両方埋まっていれば通常のTスピン
    const front = [corners[rotation], corners[(rotation + 1) % 4]];
    // 壁蹴りの5番目（最後の候補）で入った場合も通常のTスピン扱い（TSTなど）
    if ((front[0] && front[1]) || this.lastKickIndex === 4) return "full";
    return "mini";
  }

  lock() {
    const tSpin = this.detectTSpin();
    const { shape, x, y, type } = this.piece;
    const cells = this.pieceCells();
    // ロックアウト：ミノ全体が見える盤面より上に置かれたらゲームオーバー
    const lockOut = cells.every((cell) => cell.y < BUFFER_ROWS);
    shape.forEach((row, dy) => {
      row.forEach((cell, dx) => {
        if (cell && y + dy >= 0) this.board[y + dy][x + dx] = type;
      });
    });
    const clearedRows = this.board
      .map((row, i) => (row.every((cell) => cell) ? i : -1))
      .filter((i) => i >= 0);
    const boardBeforeClear = this.board.map((row) => [...row]);
    const cleared = this.clearLines();
    this.addClearScore(cleared, tSpin);
    this.events.push({
      type: "lock",
      pieceType: type,
      cells,
      clearedRows,
      clear: cleared > 0 || tSpin ? this.lastClear : null,
      attack: cleared > 0 ? attackOf(this.lastClear) : 0,
      delay: cleared > 0 ? lineClearDelay(cleared, this.lastClear.perfectClear) : ENTRY_DELAY,
    });
    this.canHold = true;
    if (lockOut) {
      this.gameOver = true;
      this.piece = null;
      this.events.push({ type: "gameOver" });
      return;
    }
    if (cleared === 0 && this.onNoClearLock) {
      // 対戦中：ラインを消さずに置いたら、溜まっているおじゃまがせり上がる
      this.onNoClearLock();
      if (this.garbageToRise > 0) {
        // せり上がりが終わるまでミノを出さない
        this.events.push({ type: "garbage", count: this.garbageToRise });
        this.piece = null;
        this.riseTimer = 0;
        return;
      }
    }
    if (cleared > 0) {
      // 消える行を見せるため少し止める。盤面の計算は済ませ、表示だけ消える前の状態を使う
      this.piece = null;
      this.clearingBoard = boardBeforeClear;
      this.clearDelay = lineClearDelay(cleared, this.lastClear.perfectClear);
    } else {
      this.piece = null;
      this.clearDelay = ENTRY_DELAY;
    }
  }

  addClearScore(cleared, tSpin) {
    const table = tSpin === "full" ? SCORE_TSPIN : tSpin === "mini" ? SCORE_TSPIN_MINI : SCORE_LINES;
    let points = table[cleared] ?? 0;

    if (cleared > 0) {
      // テトリスとTスピン系のライン消しが「難しい消し方」。続けるとBack-to-Backで1.5倍
      const difficult = cleared === 4 || tSpin !== null;
      const isBackToBack = difficult && this.backToBack;
      if (isBackToBack) points *= BACK_TO_BACK_MULTIPLIER;
      this.backToBack = difficult;

      this.combo++;
      points += COMBO_POINTS * this.combo;

      const perfectClear = this.board.every((row) => row.every((cell) => cell === null));
      if (perfectClear) points += SCORE_PERFECT_CLEAR[cleared];

      this.lastClear = { cleared, tSpin, backToBack: isBackToBack, combo: this.combo, perfectClear };
    } else {
      this.combo = -1;
      // ライン消しなしのTスピンは表示だけ残す（B2Bは継続も途切れもしない）
      this.lastClear = tSpin ? { cleared, tSpin, backToBack: false, combo: -1, perfectClear: false } : this.lastClear;
    }

    this.score += points * this.level;
  }

  // 消えた行数を返す
  clearLines() {
    const remaining = this.board.filter((row) => row.some((cell) => !cell));
    const cleared = ROWS - remaining.length;
    for (let i = 0; i < cleared; i++) {
      remaining.unshift(Array(COLS).fill(null));
    }
    this.board = remaining;
    this.lines += cleared;
    return cleared;
  }
}
