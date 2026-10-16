// 簡易AI。置ける場所をすべて試して点数を付け、一番高い場所に置く
// 盤面のシミュレーションには tetris.js / puyo.js の判定処理をそのまま使う

// 「つよい」の操作速度の倍率（テトリス・ぷよ共通）。下の基準の速さに対して何倍速くするか
const HARD_SPEED = 1.5;

// ぷよの「つよい」が、組ぷよが出てから動かし始めるまでの基準の時間（ミリ秒）。人間が考える時間の代わり
const PUYO_HARD_PAIR_DELAY = 300;

// tetrisInterval / puyoInterval: 回転・移動1回ごとの間隔（ミリ秒）、puyoDropInterval: ぷよを落とすときのソフトドロップ間隔
// puyoPairDelay: 組ぷよが出てから動かし始めるまでの時間（ミリ秒。指定がなければ待たない）
// tetrisDropInterval: テトリスで Tスピンや差し込みのために下ろすときの1段あたりの間隔（指定がなければ人間の押しっぱなしと同じ）
// tetrisDepth / tetrisBeam / tetrisNoise: テトリスAIが何手先まで読むか・候補をいくつ残すか・判断のぶれの大きさ
// puyoTarget: ぷよで撃つ連鎖数の目標、puyoPotential: 伸びしろを見るときに足すぷよの数
// puyoGarbageAssume: おじゃまが来ていなくても、これだけ来るものとして形の強さを評価する（個数）
const AI_LEVELS = {
  easy: { label: "よわい", tetrisInterval: 350, tetrisDepth: 2, tetrisBeam: 6, tetrisNoise: 100, puyoInterval: 400, puyoDropInterval: 4 * FRAME, useHold: false, lookahead: false, noise: 1.5, puyoTarget: 3, puyoPotential: 0, puyoGarbageAssume: 0 },
  normal: { label: "ふつう", tetrisInterval: 200, tetrisDepth: 2, tetrisBeam: 8, tetrisNoise: 110, puyoInterval: 250, puyoDropInterval: 3 * FRAME, useHold: true, lookahead: false, noise: 1.5, puyoTarget: 3, puyoPotential: 1, puyoGarbageAssume: 6 },
  hard: {
    label: "つよい",
    tetrisInterval: 100 / HARD_SPEED,
    tetrisDropInterval: SOFT_DROP_INTERVAL / HARD_SPEED,
    tetrisDepth: 4,
    tetrisBeam: 30,
    tetrisNoise: 0,
    puyoInterval: 50 / HARD_SPEED,
    puyoDropInterval: (2 * FRAME) / HARD_SPEED,
    puyoPairDelay: PUYO_HARD_PAIR_DELAY / HARD_SPEED,
    puyoEngine: "beam", useHold: true, lookahead: true, noise: 0, puyoTarget: 7, puyoPotential: 2, puyoGarbageAssume: 6 },
};

// 着地しそうなときの操作間隔。遅いAIでも、動かし終わる前に置かれてしまわないようにする
const AI_URGENT_INTERVAL = 2 * FRAME;

// ---------- テトリス ----------

// テトリスAIのモード（何を狙って積むか）
const TETRIS_AI_MODES = {
  balance: "バランス",
  ren: "REN特化",
  pc: "パフェ特化",
  dig: "掘り特化",
};

// 最強AI（tetris-ai-core.js）に渡すルールの数値
const TETRIS_AI_RULES = {
  cols: COLS,
  rows: ROWS,
  buffer: BUFFER_ROWS,
  shapes: Object.fromEntries(Object.entries(SHAPES).filter(([type]) => type !== GARBAGE_COLOR)),
  kicksJLSTZ: KICKS_JLSTZ,
  kicksI: KICKS_I,
  attackLines: ATTACK_LINES,
  attackTSpin: ATTACK_TSPIN,
  attackTSpinMini: ATTACK_TSPIN_MINI,
  attackB2B: ATTACK_BACK_TO_BACK,
  attackPerfect: ATTACK_PERFECT_CLEAR,
};

// 盤面を「1行 = 1つの数値」（埋まっている列のビットが立つ）に変える
function encodeTetrisBoard(board) {
  return board.map((row) => row.reduce((mask, cell, x) => (cell ? mask | (1 << x) : mask), 0));
}

// テトリスの判定処理を盤面だけ差し替えて使うための入れ物
function tetrisSim(board, piece) {
  const sim = Object.create(Tetris.prototype);
  sim.board = board;
  sim.piece = { ...piece };
  sim.gameOver = false;
  sim.events = [];
  sim.touchedGround = false;
  sim.lowestY = piece.y;
  sim.lastWasRotation = false;
  sim.lastKickIndex = 0;
  return sim;
}

// 探索で使う操作。手数が同じなら先に並んだ操作が優先されるので、回転を先にしている
// sonic は「一番下まで落とす（固定はしない）」で、Tスピンや差し込みのときだけ使われる
function rotateSim(sim, clockwise) {
  const before = sim.piece.rotation;
  sim.rotate(clockwise);
  return sim.piece.rotation !== before;
}

function sonicDrop(target) {
  let moved = false;
  while (target.move(0, 1)) moved = true;
  return moved;
}

class TetrisAI {
  // getOpponent はぷよのAIと呼び出し方をそろえるための引数（テトリスAIでは今は使っていない）
  // mode：TETRIS_AI_MODES のどれか
  constructor(game, level, getIncoming, getOpponent, mode = "balance") {
    this.game = game;
    this.level = AI_LEVELS[level];
    this.getIncoming = getIncoming;
    this.mode = mode;
    this.plan = null;
    this.timer = 0;
    // 裏側（Web Worker）で考える。考えている間に対象のミノが変わったら結果は捨てる
    this.thinker = new TetrisThinker();
    this.waitingFor = null;
    this.afterHold = null; // ホールドした後に置く予定（ホールドで出てくるミノの置き方）
  }

  dispose() {
    if (this.thinker) this.thinker.dispose();
  }

  requestPlan() {
    const game = this.game;
    const piece = game.piece;
    this.waitingFor = piece;
    const request = {
      board: encodeTetrisBoard(game.board),
      piece: { type: piece.type, x: piece.x, y: piece.y, rot: piece.rotation },
      queue: game.queue.slice(0, NEXT_COUNT),
      hold: game.hold,
      canHold: this.level.useHold && game.canHold,
      b2b: game.backToBack,
      combo: game.combo,
      incoming: this.getIncoming(),
      mode: this.mode,
      depth: this.level.tetrisDepth,
      beamWidth: this.level.tetrisBeam,
      noise: this.level.tetrisNoise,
    };
    this.thinker.request(request, (result) => {
      if (this.waitingFor !== piece || game.piece !== piece || !game.canControl()) return;
      if (!result) {
        this.waitingFor = null; // 失敗したら次のフレームで考え直す
        return;
      }
      if (!result.found) {
        this.plan = [{ action: "hardDrop", expected: null }];
      } else if (result.hold) {
        this.plan = [{ action: "hold", expected: null }];
        this.afterHold = result;
      } else {
        this.plan = this.buildPlan(result);
        if (!this.plan) this.waitingFor = null; // 考えている間に落ちて経路が使えなくなったら考え直す
      }
      this.timer = 0;
    });
  }

  // 最強AIの経路を、今のミノの位置から実際にたどれるか確かめて、操作の計画にする
  buildPlan(result) {
    const game = this.game;
    const sim = tetrisSim(game.board, game.piece);
    const steps = [];
    for (const action of [...result.path, "hardDrop"]) {
      steps.push({ action, expected: { ...sim.piece } });
      if (action !== "hardDrop" && !this.doAction(action, sim)) return null;
    }
    sonicDrop(sim);
    const target = result.piece;
    const p = sim.piece;
    if (p.x !== target.x || p.y !== target.y || p.rotation !== target.rot) return null;
    this.target = target;
    return steps;
  }

  // 自然落下で位置がずれたとき、残りの操作で同じ場所に置けるなら、その計画で続ける
  // （置けなければ null。考え直しを待つより速い）
  resumePlan(remainingActions) {
    if (!this.target) return null;
    const path = remainingActions.filter((a) => a !== "hardDrop");
    return this.buildPlan({ path, piece: this.target });
  }

  // 計画した位置と実際の位置が同じか
  onPlan(expected) {
    if (!expected) return true;
    const { x, y, rotation } = this.game.piece;
    return x === expected.x && y === expected.y && rotation === expected.rotation;
  }

  update(dt) {
    const game = this.game;
    if (!game.canControl()) {
      this.plan = null;
      this.dropping = false;
      return;
    }
    if (!this.plan) {
      // ホールドした後は、考えておいた置き方をそのまま使う
      if (this.afterHold && this.afterHold.type === game.piece.type) {
        this.plan = this.buildPlan(this.afterHold);
        this.timer = 0;
      }
      this.afterHold = null;
      if (!this.plan && this.waitingFor !== game.piece) this.requestPlan();
      if (!this.plan) return; // 考え中
    }
    this.timer += dt;
    for (;;) {
      if (!this.plan) return;
      const { action, expected } = this.plan[0];

      // 「一番下まで下ろす」（Tスピンや差し込みの前）は、ワープさせずにソフトドロップで1段ずつ下ろす
      if (action === "sonic") {
        const dropWait = this.level.tetrisDropInterval ?? SOFT_DROP_INTERVAL;
        if (this.timer < dropWait) return;
        this.timer -= dropWait;
        // 下ろし始めるときだけ、計画どおりの位置にいるか確かめる
        if (!this.dropping && !this.onPlan(expected)) {
          const resumed = this.resumePlan(this.plan.map((step) => step.action));
          if (!resumed) {
            this.abortPlan();
            return;
          }
          this.plan = resumed;
          continue;
        }
        this.dropping = true;
        game.softDrop();
        if (game.isGrounded()) {
          this.dropping = false;
          this.plan.shift();
        }
        continue;
      }

      // 着地しそうなときは、置かれてしまう前に残りの操作を急いで行う
      const urgent = game.ghostY() - game.piece.y <= 1;
      const wait = urgent ? AI_URGENT_INTERVAL : this.level.tetrisInterval;
      if (this.timer < wait) return;
      this.timer -= wait;
      // 自然落下でずれていたら、残りの操作で同じ場所に置けるか確かめて続ける
      if (!this.onPlan(expected)) {
        const resumed = this.resumePlan(this.plan.map((step) => step.action));
        if (!resumed) {
          this.abortPlan();
          return;
        }
        this.plan = resumed;
        continue;
      }
      this.plan.shift();
      // 操作が失敗したら考え直す（今の位置から改めて考えてもらう）
      if (!this.doAction(action, game)) {
        this.abortPlan();
        return;
      }
      if (action === "hold" || this.plan.length === 0 || !game.canControl()) this.plan = null;
    }
  }

  abortPlan() {
    this.plan = null;
    this.dropping = false;
    this.waitingFor = null;
  }

  // target は本物のゲームか、計画を立てるときのシミュレーション
  doAction(action, target) {
    switch (action) {
      case "left":
        return target.move(-1, 0);
      case "right":
        return target.move(1, 0);
      case "sonic":
        return sonicDrop(target);
      case "cw":
      case "ccw":
        return rotateSim(target, action === "cw");
      case "hold":
        target.holdPiece();
        return true;
      case "hardDrop":
        if (target === this.game) target.hardDrop();
        return true;
    }
    return false;
  }
}

// ---------- ぷよぷよ ----------

// 最強AI（puyo-ai-core.js）に渡すルールの数値
const PUYO_AI_RULES = {
  cols: PUYO_COLS,
  rows: PUYO_ROWS,
  hidden: PUYO_HIDDEN_ROWS,
  spawnX: PUYO_SPAWN_X,
  spawnY: PUYO_SPAWN_Y,
  popCount: PUYO_POP_COUNT,
  chainBonus: PUYO_CHAIN_BONUS,
  // 添字がつながった数。11個以上は10
  connectBonus: [...Array(12).keys()].map((n) => (n < PUYO_POP_COUNT ? 0 : PUYO_CONNECT_BONUS[n] ?? 10)),
  colorBonus: PUYO_COLOR_BONUS,
  targetPoints: PUYO_TARGET_POINTS,
  maxNuisanceDrop: PUYO_MAX_NUISANCE_DROP,
  childOffsets: PUYO_CHILD_OFFSETS,
};

// 盤面の色を最強AI用の数値に変える（0:空 1〜4:色 5:おじゃま）
function puyoColorCode(color) {
  if (!color) return 0;
  return color === PUYO_NUISANCE ? 5 : PUYO_COLORS.indexOf(color) + 1;
}

function encodePuyoBoard(board) {
  return board.flat().map(puyoColorCode);
}

// 最強AIの思考を裏側（Web Worker）で動かす窓口。Worker が使えない環境では画面側でそのまま計算する
// Worker は思考部分（createCore）の関数の中身から作るので、別ファイルを読み込めない環境（HTMLを直接開く・1ファイル版）でも動く
class AIThinker {
  constructor(createCore, rules) {
    this.createCore = createCore;
    this.rules = rules;
    this.nextId = 0;
    this.callbacks = new Map();
    try {
      const source =
        `const core = (${createCore.toString()})(${JSON.stringify(rules)});
` +
        "onmessage = (e) => postMessage({ id: e.data.id, result: core.think(e.data.request) });";
      this.url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      this.worker = new Worker(this.url);
      this.worker.onmessage = (e) => this.finish(e.data.id, e.data.result);
      this.worker.onerror = () => this.fallBack();
    } catch {
      this.fallBack();
    }
  }

  fallBack() {
    this.dispose();
    this.core = this.createCore(this.rules);
    // 返事が来ないまま待っている依頼には「失敗」を返して、考え直してもらう
    [...this.callbacks.keys()].forEach((id) => this.finish(id, null));
  }

  request(request, callback) {
    if (this.core) {
      callback(this.core.think(request));
      return;
    }
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    this.worker.postMessage({ id, request });
  }

  finish(id, result) {
    const callback = this.callbacks.get(id);
    this.callbacks.delete(id);
    if (callback) callback(result);
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    if (this.url) URL.revokeObjectURL(this.url);
    this.worker = null;
    this.url = null;
  }
}

class PuyoThinker extends AIThinker {
  constructor() {
    super(createPuyoAICore, PUYO_AI_RULES);
  }
}

class TetrisThinker extends AIThinker {
  constructor() {
    super(createTetrisAICore, TETRIS_AI_RULES);
  }
}

// ぷよの判定処理を盤面だけ差し替えて使うための入れ物
function puyoSim(board) {
  const sim = Object.create(Puyo.prototype);
  sim.board = board.map((row) => [...row]);
  sim.chain = 0;
  return sim;
}

// 浮いているぷよを一気に下まで落とす
function puyoSettle(board) {
  for (let x = 0; x < PUYO_COLS; x++) {
    const column = [];
    for (let y = PUYO_ROWS - 1; y >= 0; y--) if (board[y][x]) column.push(board[y][x]);
    for (let y = PUYO_ROWS - 1, i = 0; y >= 0; y--, i++) board[y][x] = column[i] ?? null;
  }
}

// 連鎖を最後まで進め、連鎖数と点数と最終盤面を返す
function puyoResolve(board) {
  const sim = puyoSim(board);
  let score = 0;
  for (;;) {
    puyoSettle(sim.board);
    const groups = sim.findGroups();
    if (groups.length === 0) break;
    sim.chain++;
    score += sim.chainScore(groups);
    const cells = groups.flatMap((g) => g.cells);
    [...cells, ...sim.adjacentNuisance(cells)].forEach(({ x, y }) => (sim.board[y][x] = null));
  }
  return { chain: sim.chain, score, board: sim.board };
}

// 列の一番上に1個積む。入らなければ false
function puyoDropInto(board, x, color) {
  for (let y = PUYO_ROWS - 1; y >= 0; y--) {
    if (!board[y][x]) {
      board[y][x] = color;
      return true;
    }
  }
  return false;
}

// 組ぷよの置き方（列と向き）の候補。出現位置から横に動いて行けない列は除く
function puyoPlacements(board) {
  const results = [];
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let x = 0; x < PUYO_COLS; x++) {
      const childX = x + PUYO_CHILD_OFFSETS[rotation][0];
      if (childX < 0 || childX >= PUYO_COLS) continue;
      const from = Math.min(PUYO_SPAWN_X, x, childX);
      const to = Math.max(PUYO_SPAWN_X, x, childX);
      let reachable = true;
      for (let c = from; c <= to; c++) if (board[PUYO_SPAWN_Y][c]) reachable = false;
      if (reachable) results.push({ x, rotation });
    }
  }
  return results;
}

function puyoPlace(board, colors, { x, rotation }) {
  const next = board.map((row) => [...row]);
  const [dx, dy] = PUYO_CHILD_OFFSETS[rotation];
  // 縦向きは下になる方から積む（子ぷよが下なら子ぷよから）
  const order = dy === 1
    ? [[x + dx, colors.child], [x, colors.axis]]
    : [[x, colors.axis], [x + dx, colors.child]];
  for (const [cx, color] of order) {
    if (!puyoDropInto(next, cx, color)) return null;
  }
  return next;
}

// 同じ色が隣り合っている数（連鎖の土台ができているほど高い）
function puyoConnectivity(board) {
  let score = 0;
  for (let y = PUYO_HIDDEN_ROWS; y < PUYO_ROWS; y++) {
    for (let x = 0; x < PUYO_COLS; x++) {
      const c = board[y][x];
      if (!c || c === PUYO_NUISANCE) continue;
      if (x + 1 < PUYO_COLS && board[y][x + 1] === c) score++;
      if (y + 1 < PUYO_ROWS && board[y + 1][x] === c) score++;
    }
  }
  return score;
}

// あと何個か足したら何連鎖になるか（いちばん大きいもの）
function puyoPotential(board, maxAdd) {
  let best = 0;
  for (let x = 0; x < PUYO_COLS; x++) {
    for (const color of PUYO_COLORS) {
      const next = board.map((row) => [...row]);
      for (let i = 0; i < maxAdd; i++) {
        if (!puyoDropInto(next, x, color)) break;
        best = Math.max(best, puyoResolve(next).chain);
      }
    }
  }
  return best;
}

// 見える盤面がこの割合まで埋まったら、目標の連鎖数を待たずに撃つ
const PUYO_AI_FULL_RATIO = 0.6;

// おじゃまぷよを降らせた後の盤面（評価用）。6個ごとに横1段、余りは低い列から1個ずつ
// （本物は余りの列がランダムなので、ここでは谷が埋まる場合で見積もる）
function puyoWithNuisance(board, count) {
  const next = board.map((row) => [...row]);
  const rows = Math.floor(count / PUYO_COLS);
  const lowFirst = [...Array(PUYO_COLS).keys()].sort((a, b) => puyoColumnHeight(next, a) - puyoColumnHeight(next, b));
  const extra = new Set(lowFirst.slice(0, count % PUYO_COLS));
  for (let x = 0; x < PUYO_COLS; x++) {
    const n = rows + (extra.has(x) ? 1 : 0);
    for (let i = 0; i < n; i++) puyoDropInto(next, x, PUYO_NUISANCE);
  }
  return next;
}

// 出現位置から横移動でたどり着けない列のうち、まだ空きがある列の数
// （組ぷよは出現位置の段を横に動かすので、途中の列がその段まで埋まると先へ行けない）
function puyoBlockedColumns(board) {
  let blocked = 0;
  for (const dir of [-1, 1]) {
    let wall = false;
    for (let x = PUYO_SPAWN_X + dir; x >= 0 && x < PUYO_COLS; x += dir) {
      if (board[PUYO_SPAWN_Y][x]) wall = true;
      else if (wall) blocked++;
    }
  }
  return blocked;
}

function puyoColumnHeight(board, x) {
  for (let y = 0; y < PUYO_ROWS; y++) if (board[y][x]) return PUYO_ROWS - y;
  return 0;
}

class PuyoAI {
  // getOpponent：相手の情報 { danger: どれだけ危ないか（0〜1）, isTetris }。潰しや撃つ早さの判断に使う
  constructor(game, level, getIncoming, getOpponent = () => ({ danger: 0, isTetris: false })) {
    this.game = game;
    this.level = AI_LEVELS[level];
    this.getIncoming = getIncoming;
    this.getOpponent = getOpponent;
    this.plan = null;
    this.timer = 0;
    // 最強AIは裏側（Web Worker）で考える。考えている間に対象の組ぷよが変わったら結果は捨てる
    this.thinker = this.level.puyoEngine === "beam" ? new PuyoThinker() : null;
    this.waitingFor = null;
  }

  dispose() {
    if (this.thinker) this.thinker.dispose();
  }

  planFor(x, rotation) {
    const actions = rotation === 3 ? ["ccw"] : Array(rotation).fill("cw");
    return [...actions, { moveTo: x }, "drop"];
  }

  // 最強AIに考えてもらう（結果は後から届く）
  requestPlan() {
    const game = this.game;
    const pair = game.pair;
    this.waitingFor = pair;
    const request = {
      board: encodePuyoBoard(game.board),
      pairs: [pair.colors, ...game.queue.slice(0, PUYO_NEXT_COUNT)].map(({ axis, child }) => [
        puyoColorCode(axis),
        puyoColorCode(child),
      ]),
      incoming: this.getIncoming(),
      opponentDanger: this.getOpponent().danger,
      opponentIsTetris: this.getOpponent().isTetris,
    };
    this.thinker.request(request, (result) => {
      if (this.waitingFor !== pair) return;
      if (!result) {
        this.waitingFor = null; // 失敗したら次のフレームで考え直す
        return;
      }
      if (game.pair === pair && game.canControl()) {
        this.plan = this.planFor(result.x, result.rotation);
        this.timer = 0;
      }
    });
  }

  // 今の状況。"lethal"：おじゃまを受けると負ける（どうしようもない）、
  // "full"：盤面が埋まってきて、目標の連鎖まで待つ余裕がない、
  // "buried"：組んでいる連鎖がおじゃまに埋もれて撃てなくなる、null：普段どおり
  situation(board, incoming) {
    if (puyoColumnHeight(board, PUYO_SPAWN_X) >= 11) return "lethal";
    const buried = puyoWithNuisance(board, incoming);
    if (incoming > 0 && buried[PUYO_SPAWN_Y][PUYO_SPAWN_X]) return "lethal";
    // おじゃまを受けた後の見える盤面が FULL_RATIO 以上埋まるなら、待たずに撃つ
    let filled = 0;
    for (let y = PUYO_HIDDEN_ROWS; y < PUYO_ROWS; y++) filled += buried[y].filter(Boolean).length;
    if (filled >= PUYO_COLS * (PUYO_ROWS - PUYO_HIDDEN_ROWS) * PUYO_AI_FULL_RATIO) return "full";
    if (incoming === 0) return null;
    const maxAdd = Math.max(1, this.level.puyoPotential);
    const now = puyoPotential(board, maxAdd);
    return now >= 2 && puyoPotential(buried, maxAdd) < now ? "buried" : null;
  }

  // 撃つかどうか。1連鎖は相手に攻撃が入らないので、負けるとき以外は撃たない
  shouldFire(result, incoming, situation) {
    if (result.chain >= this.level.puyoTarget) return true;
    if (situation === "lethal") return true;
    if (situation === "full") return result.chain >= 2;
    if (situation === "buried" && result.chain >= 2) {
      // 来ているおじゃまをある程度（最大1段分）相殺できる連鎖なら、埋もれる前に撃つ
      const offset = Math.floor(result.score / PUYO_TARGET_POINTS);
      return offset >= Math.min(incoming, PUYO_COLS);
    }
    return false;
  }

  evaluate(board, colors, candidate, incoming, situation) {
    const placed = puyoPlace(board, colors, candidate);
    if (!placed) return -Infinity;
    const result = puyoResolve(placed);
    if (result.board[PUYO_SPAWN_Y][PUYO_SPAWN_X]) return -100000; // 置いたら負け

    let score = 0;
    if (result.chain > 0) {
      // 撃つべきときは大きい連鎖ほど高く。それ以外で消えるのは土台を崩すので嫌う（1連鎖は特に無駄）
      if (this.shouldFire(result, incoming, situation)) score += 1000 + result.score / 10;
      else score -= result.chain === 1 ? 400 : 200 * result.chain;
    } else if (incoming > 0 && puyoWithNuisance(result.board, incoming)[PUYO_SPAWN_Y][PUYO_SPAWN_X]) {
      return -50000; // 撃たずにおじゃまを受けると負ける
    }
    score += puyoConnectivity(result.board) * 3;

    if (this.level.puyoPotential > 0) {
      // おじゃまを受けた後でも撃てる連鎖を重視する（発火点が埋もれない形を好む）
      // 来ていなくても、1段分は来るものとして備える。計算量を抑えるため、今の盤面の伸びしろは1個足す場合だけ見る
      const assumed = Math.max(incoming, this.level.puyoGarbageAssume);
      const afterGarbage = assumed > 0
        ? puyoPotential(puyoWithNuisance(result.board, assumed), this.level.puyoPotential)
        : 0;
      score += puyoPotential(result.board, 1) * 15 + afterGarbage * 30;
    }

    // 出現位置の列（3列目）が高いのは危険。両隣の列も高いと通り道をふさぐので減点
    score -= Math.max(0, puyoColumnHeight(result.board, PUYO_SPAWN_X) - 8) * 60;
    score -= Math.max(0, puyoColumnHeight(result.board, PUYO_SPAWN_X - 1) - 9) * 30;
    score -= Math.max(0, puyoColumnHeight(result.board, PUYO_SPAWN_X + 1) - 9) * 30;
    // 出現位置から横移動で行けなくなった列にまだ空きがあるなら、その空きは使えなくなるので大きく減点
    score -= puyoBlockedColumns(result.board) * 300;
    // 全体は10段を超えたら減点（発火点を高く持てるように）
    const maxHeight = Math.max(...[...Array(PUYO_COLS).keys()].map((x) => puyoColumnHeight(result.board, x)));
    score -= Math.max(0, maxHeight - 9) * 15;
    return score + (Math.random() - 0.5) * this.level.noise * 20;
  }

  think() {
    const game = this.game;
    // 一度に降るのは30個まで
    const incoming = Math.min(this.getIncoming(), PUYO_MAX_NUISANCE_DROP);
    const situation = this.situation(game.board, incoming);
    let best = null;
    for (const candidate of puyoPlacements(game.board)) {
      let score = this.evaluate(game.board, game.pair.colors, candidate, incoming, situation);
      // つよい：次の組ぷよも置いてみて、良い方を足す
      if (this.level.lookahead && score > -10000 && game.queue[0]) {
        const placed = puyoResolve(puyoPlace(game.board, game.pair.colors, candidate)).board;
        let nextBest = -Infinity;
        for (const nextCandidate of puyoPlacements(placed)) {
          const placedNext = puyoPlace(placed, game.queue[0], nextCandidate);
          if (!placedNext) continue;
          const r = puyoResolve(placedNext);
          // 先読みは軽く：目標に届く連鎖が撃てるかと、つながりだけを見る
          const fire = r.chain >= this.level.puyoTarget ? r.chain * 50 : 0;
          nextBest = Math.max(nextBest, fire + puyoConnectivity(r.board) * 3);
        }
        if (nextBest > -Infinity) score += nextBest * 0.5;
      }
      if (!best || score > best.score) best = { candidate, score };
    }
    if (!best) return ["drop"];
    return this.planFor(best.candidate.x, best.candidate.rotation);
  }

  update(dt) {
    const game = this.game;
    if (!game.canControl()) {
      this.plan = null;
      this.waitingFor = null;
      return;
    }
    // 組ぷよが出てからの時間。puyoPairDelay に届くまでは動かさない（考える時間）
    if (this.pairOf !== game.pair) {
      this.pairOf = game.pair;
      this.sincePair = 0;
    }
    this.sincePair += dt;
    if (!this.plan) {
      if (this.thinker) {
        if (this.waitingFor !== game.pair) this.requestPlan();
        if (!this.plan) return; // 考え中
      } else {
        this.plan = this.think();
        this.timer = 0;
      }
    }
    // ただし着地しそうなら待たない（考えている間に置かれてしまうのを防ぐ）
    const landingSoon = game.ghostY() - game.pair.y <= 1;
    if (this.sincePair < (this.level.puyoPairDelay ?? 0) && !landingSoon) return;
    this.timer += dt;
    for (;;) {
      if (!this.plan) return;
      const action = this.plan[0];
      // 回転・移動と、落とすときのソフトドロップは別の間隔
      // 着地しそうなときは、置かれてしまう前に残りの回転・移動を急いで行う
      const urgent = game.ghostY() - game.pair.y <= 1;
      const wait = action === "drop"
        ? this.level.puyoDropInterval
        : urgent ? AI_URGENT_INTERVAL : this.level.puyoInterval;
      if (this.timer < wait) return;
      this.timer -= wait;
      if (action === "drop") {
        // 置くまでソフトドロップを続ける（接地中のソフトドロップで即設置）
        game.softDrop();
        if (!game.canControl()) this.plan = null;
        continue;
      }
      if (action === "cw" || action === "ccw") {
        game.rotate(action === "cw");
        this.plan.shift();
      } else if (action.moveTo !== undefined) {
        const dx = Math.sign(action.moveTo - game.pair.x);
        if (dx === 0 || !game.move(dx, 0)) this.plan.shift();
      }
    }
  }
}
