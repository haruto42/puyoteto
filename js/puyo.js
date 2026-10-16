// ぷよぷよのルール（ぷよぷよ通を基準にした仕様）
const PUYO_COLS = 6;
const PUYO_ROWS = 13; // 0段目は見えない13段目。ここのぷよは連結・消去の対象外
const PUYO_HIDDEN_ROWS = 1;
const PUYO_COLORS = ["red", "green", "blue", "yellow"];
const PUYO_NEXT_COUNT = 2;
const PUYO_SPAWN_X = 2; // 左から3列目
const PUYO_SPAWN_Y = 1; // 見える一番上の段（12段目）。ここが埋まるとゲームオーバー
const PUYO_POP_COUNT = 4; // 何個つながったら消えるか

const PUYO_DROP_INTERVAL = 800; // 自然落下の間隔（ミリ秒）
const PUYO_LOCK_DELAY = 500; // 接地してから置かれるまで（ミリ秒）
const PUYO_MAX_LOCK_RESETS = 15; // 接地中に置かれるまでの時間をやり直せる回数
// 連鎖・おじゃま落下の時間（硬直）は、ぷよスポ（ぷよぷよeスポーツ）の計測値に合わせている。ぷよぷよテトリス自体の計測は見つからなかった
// 連鎖1回 = 消える時間 + 落ち始めるまでの間 + 落下（1段 + 1段ごと）。1段落ちなら80F、2段なら82F、落ちないとき（最後の連鎖）は55F
// 参考: https://puyo-camp.jp/posts/71019（連鎖にかかる時間: 0段55F・1段80F・2段82F・3段84F・4段86F）
const PUYO_POP_DELAY = 55 * FRAME; // 消える前に光らせておく時間
const PUYO_POST_POP_FALL_DELAY = 23 * FRAME; // 消えてから、浮いたぷよが落ち始めるまでの間
const PUYO_FALL_STEP = 2 * FRAME; // 浮いているぷよが1段落ちる間隔
// おじゃまぷよの落下：降り始めの間 + 1段ごとの間隔。1段落ちで約16F、13段落ちで約55F
// 参考: https://puyonexus.com/wiki/Puyo_Puyo_Tsu/Frame_Data_Tables（おじゃまぷよの落下フレーム表）
const PUYO_NUISANCE_FALL_DELAY = 13 * FRAME;
const PUYO_NUISANCE_FALL_STEP = 3.25 * FRAME;
// 降る数が多いほど硬直が長い。8個までは0、20個で18F、30個で25F（その間は直線でつなぐ）
// 参考: https://puyo-camp.jp/posts/71019（お邪魔ぷよによる硬直）
const PUYO_NUISANCE_STIFFNESS = [[8, 0], [20, 18], [30, 25]];

// ハードドロップは本家にないので無効。true にすると ↑ で使える
const PUYO_HARD_DROP_ENABLED = false;

// 得点（ぷよぷよ通）：10 × 消した数 × (連鎖ボーナス + 連結ボーナス + 色数ボーナス)
const PUYO_CHAIN_BONUS = [0, 8, 16, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 480, 512];
const PUYO_CONNECT_BONUS = { 4: 0, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7 }; // 11個以上は10
const PUYO_COLOR_BONUS = [0, 3, 6, 12, 24]; // 添字は色数 - 1
const PUYO_SOFT_DROP_POINTS = 1;
// 組ぷよが出てから、押しっぱなしのソフトドロップが効き始めるまでの時間（ミリ秒）
// ↓を押したまま着地させたとき、次の組ぷよまで勢いで落ちないようにする
const PUYO_SOFT_DROP_SPAWN_DELAY = 150;
const PUYO_ALL_CLEAR_BONUS = 2100; // 全消しの次の連鎖の1連鎖目に加算する点数（攻撃力のみ）

const PUYO_NUISANCE = "nuisance"; // おじゃまぷよ
const PUYO_MAX_NUISANCE_DROP = 30; // 一度に降るおじゃまぷよの最大数（5段分）

// 軸ぷよから見た子ぷよの位置。向き 0:上 1:右 2:下 3:左
const PUYO_CHILD_OFFSETS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

class Puyo {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = Array.from({ length: PUYO_ROWS }, () => Array(PUYO_COLS).fill(null));
    this.score = 0;
    this.chain = 0; // 今の連鎖数
    this.lastChain = 0; // 直前の連鎖数（表示用）
    this.maxChain = 0;
    this.gameOver = false;
    this.events = []; // 効果音・エフェクト用。描画側が毎フレーム取り出す
    this.queue = [];
    this.popping = null; // 消える直前のぷよの座標（光らせる表示用）
    this.allClearPending = false; // 全消しした後、次の連鎖にボーナスが乗る
    // 対戦用：連鎖が終わったときに呼ばれ、降らせるおじゃまぷよの数を返す（一人用では null）
    this.takeNuisance = null;
    this.nuisanceDropped = false; // このターンにおじゃまぷよを降らせ済みか
    this.spawn();
  }

  // 色は1個ずつ4色から1/4で抽選する（7種1巡のような偏り防止はしない）
  randomColor() {
    return PUYO_COLORS[Math.floor(Math.random() * PUYO_COLORS.length)];
  }

  // 次の組ぷよを取り出す。NEXT 表示のため、取り出した後も PUYO_NEXT_COUNT 組が残るように補充する
  nextColors() {
    while (this.queue.length < PUYO_NEXT_COUNT + 1) {
      this.queue.push({ axis: this.randomColor(), child: this.randomColor() });
    }
    return this.queue.shift();
  }

  spawn() {
    const colors = this.nextColors();
    this.pair = { x: PUYO_SPAWN_X, y: PUYO_SPAWN_Y, rotation: 0, colors };
    // control: 操作中 / falling: ちぎれたぷよ・おじゃまぷよの落下中 / popping: 消える直前
    this.phase = "control";
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.touchedGround = false;
    this.lowestY = this.pair.y;
    this.quickTurnReady = false;
    this.dropBonus = 0; // ソフトドロップの点数。1連鎖目の攻撃力に加わる（ぷよぷよ通の落下ボーナス）
    this.softDropWait = PUYO_SOFT_DROP_SPAWN_DELAY;
    this.nuisanceDropped = false;
  }

  // 組ぷよの2個の座標と色。1個目が軸ぷよ
  pairCells(x = this.pair.x, y = this.pair.y, rotation = this.pair.rotation) {
    const [dx, dy] = PUYO_CHILD_OFFSETS[rotation];
    return [
      { x, y, color: this.pair.colors.axis },
      { x: x + dx, y: y + dy, color: this.pair.colors.child },
    ];
  }

  // 盤面より上（y < 0）は空いている扱い。回転で一時的にはみ出せるようにするため
  isBlocked(x, y) {
    if (x < 0 || x >= PUYO_COLS || y >= PUYO_ROWS) return true;
    return y >= 0 && this.board[y][x] !== null;
  }

  fits(x, y, rotation) {
    return this.pairCells(x, y, rotation).every((c) => !this.isBlocked(c.x, c.y));
  }

  canControl() {
    return !this.gameOver && this.phase === "control";
  }

  isGrounded() {
    const { x, y, rotation } = this.pair;
    return !this.fits(x, y + 1, rotation);
  }

  move(dx, dy) {
    if (!this.canControl()) return false;
    const { x, y, rotation } = this.pair;
    if (!this.fits(x + dx, y + dy, rotation)) return false;
    this.pair.x += dx;
    this.pair.y += dy;
    this.quickTurnReady = false;
    if (dx !== 0) this.events.push({ type: "move" });
    if (dy > 0) {
      this.onFall();
    } else {
      this.onManipulate();
    }
    return true;
  }

  // 回転：ぶつかる場合は軸ぷよを押し出して回す。左右とも塞がっていて回れないときは、
  // もう一度回転を押すと上下が入れ替わる（クイックターン）
  rotate(clockwise) {
    if (!this.canControl()) return;
    const { x, y, rotation } = this.pair;
    const to = (rotation + (clockwise ? 1 : 3)) % 4;
    const [dx, dy] = PUYO_CHILD_OFFSETS[to];

    // 子ぷよが行く側の反対へ軸ぷよを1マス押し出す候補
    const candidates = [[x, y], [x - dx, y - dy]];
    for (const [nx, ny] of candidates) {
      if (this.fits(nx, ny, to)) {
        this.applyRotation(nx, ny, to);
        return;
      }
    }

    if (dx !== 0) {
      // 横に回れない＝左右とも塞がっている
      if (this.quickTurnReady) {
        const flipped = (rotation + 2) % 4;
        const [, fy] = PUYO_CHILD_OFFSETS[flipped];
        for (const [nx, ny] of [[x, y], [x, y - fy]]) {
          if (this.fits(nx, ny, flipped)) {
            this.applyRotation(nx, ny, flipped);
            return;
          }
        }
      } else {
        this.quickTurnReady = true;
      }
    }
  }

  applyRotation(x, y, rotation) {
    this.pair.x = x;
    this.pair.y = y;
    this.pair.rotation = rotation;
    this.quickTurnReady = false;
    this.events.push({ type: "rotate" });
    this.onManipulate();
    this.onFall();
  }

  step() {
    return this.move(0, 1);
  }

  // 本家と同じく、接地中にソフトドロップするとその場で置く
  // held：↓の押しっぱなしによる連続入力。出現直後のしばらくは無視する（押し直せばすぐ効く）
  softDrop(held = false) {
    if (!this.canControl()) return;
    if (held && this.softDropWait > 0) return;
    if (this.isGrounded()) {
      this.lock();
    } else if (this.step()) {
      this.score += PUYO_SOFT_DROP_POINTS;
      this.dropBonus += PUYO_SOFT_DROP_POINTS;
    }
  }

  hardDrop() {
    if (!PUYO_HARD_DROP_ENABLED || !this.canControl()) return;
    while (this.step()) {}
    this.lock();
  }

  // 今置いたときに、ちぎれた後それぞれが落ち着く位置（ゴースト表示用）
  // 盤面より上（y < 0）に残るものは置いたときに消える
  landingCells() {
    const board = this.board.map((row) => [...row]);
    // 下にある方から落とす（縦向きのとき、上のぷよが下のぷよの上に乗るように）
    const cells = this.pairCells().sort((a, b) => b.y - a.y);
    return cells.map(({ x, y, color }) => {
      while (y + 1 < PUYO_ROWS && !board[y + 1][x]) y++;
      if (y >= 0) board[y][x] = color;
      return { x, y, color };
    });
  }

  // 今置いたら最初に消えるぷよ（巻き込まれるおじゃまぷよも含む）の座標。消えなければ空の配列
  predictPops() {
    const sim = Object.create(Puyo.prototype);
    sim.board = this.board.map((row) => [...row]);
    this.landingCells().forEach(({ x, y, color }) => {
      if (y >= 0) sim.board[y][x] = color;
    });
    const cells = sim.findGroups().flatMap((g) => g.cells);
    return [...cells, ...sim.adjacentNuisance(cells)];
  }

  // 組ぷよのまま落とした場合の y（AIが着地までの余裕を見るのに使う）
  ghostY() {
    const { x, rotation } = this.pair;
    let y = this.pair.y;
    while (this.fits(x, y + 1, rotation)) y++;
    return y;
  }

  // 接地後の移動・回転で置かれるまでの時間をやり直す（回数に上限あり）
  onManipulate() {
    if (!this.touchedGround) return;
    this.lockResets++;
    if (this.lockResets <= PUYO_MAX_LOCK_RESETS) this.lockTimer = 0;
  }

  onFall() {
    if (this.pair.y > this.lowestY) {
      this.lowestY = this.pair.y;
      this.lockTimer = 0;
      this.lockResets = 0;
      this.touchedGround = false;
    }
  }

  update(dt) {
    if (this.gameOver) return;
    if (this.phase === "control") this.updateControl(dt);
    else if (this.phase === "falling") this.updateFalling(dt);
    else if (this.phase === "popping") this.updatePopping(dt);
  }

  updateControl(dt) {
    this.softDropWait -= dt;
    this.dropTimer += dt;
    if (this.dropTimer >= PUYO_DROP_INTERVAL) {
      this.dropTimer = 0;
      this.step();
    }
    if (!this.isGrounded()) return;
    this.touchedGround = true;
    if (this.lockResets > PUYO_MAX_LOCK_RESETS) {
      this.lock();
      return;
    }
    this.lockTimer += dt;
    if (this.lockTimer >= PUYO_LOCK_DELAY) this.lock();
  }

  // 組ぷよを盤面に置く。13段目より上にはみ出した分は消える
  lock() {
    const cells = this.pairCells();
    cells.forEach(({ x, y, color }) => {
      if (y >= 0) this.board[y][x] = color;
    });
    this.events.push({ type: "lock", cells });
    this.chain = 0;
    this.startFalling(PUYO_FALL_STEP);
  }

  // delay：落ち始めるまでの間（ミリ秒）
  startFalling(step, delay = 0) {
    this.phase = "falling";
    this.fallTimer = -delay;
    this.fallStep = step;
  }

  // 浮いているぷよが1つでもあるか
  hasFloating() {
    for (let y = 0; y < PUYO_ROWS - 1; y++) {
      for (let x = 0; x < PUYO_COLS; x++) {
        if (this.board[y][x] && !this.board[y + 1][x]) return true;
      }
    }
    return false;
  }

  // 浮いているぷよを1段ずつ落とす。落ちるものがなくなったら消去判定へ
  updateFalling(dt) {
    this.fallTimer += dt;
    while (this.fallTimer >= this.fallStep) {
      this.fallTimer -= this.fallStep;
      this.fallOneStep();
      if (!this.hasFloating()) {
        this.checkPops();
        return;
      }
    }
  }

  // 下から順に見ていくので、積み重なったぷよも1回で1段ずつそろって落ちる
  fallOneStep() {
    let moved = false;
    for (let y = PUYO_ROWS - 2; y >= 0; y--) {
      for (let x = 0; x < PUYO_COLS; x++) {
        if (this.board[y][x] && !this.board[y + 1][x]) {
          this.board[y + 1][x] = this.board[y][x];
          this.board[y][x] = null;
          moved = true;
        }
      }
    }
    return moved;
  }

  // 同じ色が上下左右に PUYO_POP_COUNT 個以上つながったまとまりを探す（13段目は除く）
  findGroups() {
    const visited = Array.from({ length: PUYO_ROWS }, () => Array(PUYO_COLS).fill(false));
    const groups = [];
    for (let y = PUYO_HIDDEN_ROWS; y < PUYO_ROWS; y++) {
      for (let x = 0; x < PUYO_COLS; x++) {
        const color = this.board[y][x];
        if (!color || color === PUYO_NUISANCE || visited[y][x]) continue;
        const group = [];
        const stack = [{ x, y }];
        visited[y][x] = true;
        while (stack.length > 0) {
          const cell = stack.pop();
          group.push(cell);
          for (const [dx, dy] of PUYO_CHILD_OFFSETS) {
            const nx = cell.x + dx;
            const ny = cell.y + dy;
            if (nx < 0 || nx >= PUYO_COLS || ny < PUYO_HIDDEN_ROWS || ny >= PUYO_ROWS) continue;
            if (visited[ny][nx] || this.board[ny][nx] !== color) continue;
            visited[ny][nx] = true;
            stack.push({ x: nx, y: ny });
          }
        }
        if (group.length >= PUYO_POP_COUNT) groups.push({ color, cells: group });
      }
    }
    return groups;
  }

  checkPops() {
    const groups = this.findGroups();
    if (groups.length === 0) {
      this.endTurn();
      return;
    }
    this.chain++;
    const gained = this.chainScore(groups);
    this.score += gained;
    // 1連鎖目だけ、落下ボーナスと全消しボーナスを攻撃力に加える
    let bonus = 0;
    if (this.chain === 1) {
      bonus = this.dropBonus;
      if (this.allClearPending) {
        bonus += PUYO_ALL_CLEAR_BONUS;
        this.allClearPending = false;
      }
    }
    const cells = groups.flatMap((g) => g.cells);
    this.popping = [...cells, ...this.adjacentNuisance(cells)];
    this.phase = "popping";
    this.popTimer = PUYO_POP_DELAY;
    this.events.push({ type: "pop", chain: this.chain, cells: this.popping, score: gained, bonus });
  }

  // 消えるぷよに上下左右で隣接しているおじゃまぷよ（13段目は除く）。一緒に消える
  adjacentNuisance(cells) {
    const found = new Map();
    cells.forEach(({ x, y }) => {
      for (const [dx, dy] of PUYO_CHILD_OFFSETS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= PUYO_COLS || ny < PUYO_HIDDEN_ROWS || ny >= PUYO_ROWS) continue;
        if (this.board[ny][nx] === PUYO_NUISANCE) found.set(`${nx},${ny}`, { x: nx, y: ny });
      }
    });
    return [...found.values()];
  }

  // おじゃまぷよを上から降らせる。6個ごとに横1段、余りはランダムな列に1個ずつ
  dropNuisance(count) {
    const rows = Math.floor(count / PUYO_COLS);
    const columns = [...Array(PUYO_COLS).keys()].sort(() => Math.random() - 0.5);
    const extra = new Set(columns.slice(0, count % PUYO_COLS));
    for (let x = 0; x < PUYO_COLS; x++) {
      let toPlace = rows + (extra.has(x) ? 1 : 0);
      // 上から空いているマスに積み、あとは落下処理でまとめて落とす。入りきらない分は消える
      for (let y = 0; y < PUYO_ROWS && toPlace > 0 && !this.board[y][x]; y++) {
        this.board[y][x] = PUYO_NUISANCE;
        toPlace--;
      }
    }
    this.events.push({ type: "nuisance", count });
  }

  chainScore(groups) {
    const count = groups.reduce((sum, g) => sum + g.cells.length, 0);
    const chainBonus = PUYO_CHAIN_BONUS[Math.min(this.chain, PUYO_CHAIN_BONUS.length) - 1];
    const connectBonus = groups.reduce((sum, g) => sum + (PUYO_CONNECT_BONUS[g.cells.length] ?? 10), 0);
    const colorCount = new Set(groups.map((g) => g.color)).size;
    const colorBonus = PUYO_COLOR_BONUS[colorCount - 1];
    // ボーナスの合計は 1〜999 の範囲に収める（ぷよぷよ通の仕様）
    const multiplier = Math.min(999, Math.max(1, chainBonus + connectBonus + colorBonus));
    return 10 * count * multiplier;
  }

  updatePopping(dt) {
    this.popTimer -= dt;
    if (this.popTimer > 0) return;
    this.popping.forEach(({ x, y }) => (this.board[y][x] = null));
    this.popping = null;
    if (this.hasFloating()) this.startFalling(PUYO_FALL_STEP, PUYO_POST_POP_FALL_DELAY);
    else this.checkPops();
  }

  // おじゃまぷよが count 個降るときの、落ち始めるまでの間（ミリ秒）
  nuisanceFallDelay(count) {
    const table = PUYO_NUISANCE_STIFFNESS;
    let frames = table[table.length - 1][1];
    for (let i = 1; i < table.length; i++) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      if (count <= x1) {
        frames = count <= x0 ? y0 : y0 + ((y1 - y0) * (count - x0)) / (x1 - x0);
        break;
      }
    }
    return PUYO_NUISANCE_FALL_DELAY + frames * FRAME;
  }

  // 連鎖が終わったら次の組ぷよへ。出現位置が埋まっていればゲームオーバー
  endTurn() {
    if (this.chain > 0) {
      this.lastChain = this.chain;
      this.maxChain = Math.max(this.maxChain, this.chain);
      this.events.push({ type: "chainEnd", chain: this.chain });
      if (this.board.every((row) => row.every((cell) => cell === null))) {
        this.allClearPending = true;
        this.events.push({ type: "allClear" });
      }
      this.chain = 0;
    }
    // 対戦中：溜まっているおじゃまぷよを降らせ、落ち切ってからもう一度ここに戻る
    if (!this.nuisanceDropped && this.takeNuisance) {
      this.nuisanceDropped = true;
      const count = this.takeNuisance();
      if (count > 0) {
        this.dropNuisance(count);
        this.startFalling(PUYO_NUISANCE_FALL_STEP, this.nuisanceFallDelay(count));
        return;
      }
    }
    if (this.board[PUYO_SPAWN_Y][PUYO_SPAWN_X]) {
      this.gameOver = true;
      this.events.push({ type: "gameOver" });
      return;
    }
    this.spawn();
  }
}
