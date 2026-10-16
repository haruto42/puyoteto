// テトリスの盤面1人分の描画・効果音（ゲームのルールは tetris.js）
const CELL = 36;
const DROP_INTERVAL = 800; // ミリ秒ごとに1段落下
const PREVIEW_CELL = 24;
const PREVIEW_WIDTH = 120; // HOLD・NEXT の1枠の大きさ
const PREVIEW_HEIGHT = 72;
const GARBAGE_BAR_WIDTH = 16; // 盤面横のおじゃま予告バーの幅
// 見えない段のうち、出現位置の2段だけは暗くして表示する（どこからミノが出るか分かるように）
const SHOWN_BUFFER_ROWS = 2;
const FIRST_SHOWN_ROW = BUFFER_ROWS - SHOWN_BUFFER_ROWS; // 画面の一番上に描く盤面の段

const LINE_NAMES = ["", "Single", "Double", "Triple", "Tetris"];

// 直前の消し方を「Back-to-Back T-Spin Double 2 REN」のような文字列にする
function describeClear(clear) {
  if (!clear) return "";
  const parts = [];
  if (clear.backToBack) parts.push("Back-to-Back");
  if (clear.tSpin === "full") parts.push("T-Spin");
  if (clear.tSpin === "mini") parts.push("T-Spin Mini");
  if (clear.cleared > 0) parts.push(LINE_NAMES[clear.cleared]);
  if (clear.combo > 0) parts.push(`${clear.combo} REN`);
  if (clear.perfectClear) parts.push("Perfect Clear");
  return parts.join(" ");
}

// 盤面中央に出す文字（1行ずつ）。普通のシングル〜トリプルでは出さない
function clearPopupLines(clear) {
  const lines = [];
  if (clear.backToBack) lines.push("BACK-TO-BACK");
  const name = clear.cleared > 0 ? LINE_NAMES[clear.cleared].toUpperCase() : "";
  if (clear.tSpin === "full") lines.push(`T-SPIN ${name}`.trim());
  else if (clear.tSpin === "mini") lines.push(`T-SPIN MINI ${name}`.trim());
  else if (clear.cleared === 4) lines.push("TETRIS");
  if (clear.combo > 0) lines.push(`${clear.combo} REN`);
  if (clear.perfectClear) lines.push("PERFECT CLEAR");
  return lines;
}

// ライン消しの演出の色と派手さ（テトリス・Tスピン・全消しは特別）
function clearStyle(clear) {
  if (clear.perfectClear) return { big: true, colors: ["#ffe066", "#ffffff", "#ff9ff3", "#74f0ff"] };
  if (clear.tSpin) return { big: clear.tSpin === "full", colors: ["#d0a0ff", "#ffffff", "#b388ff"] };
  if (clear.cleared === 4) return { big: true, colors: ["#74f0ff", "#ffffff", "#a0f0ff"] };
  return { big: false, colors: ["#ffffff"] };
}

// ライン消しの文字の大きさ・色
function clearPopupOptions(clear) {
  if (clear.perfectClear) return { scale: 1.4, color: "#ffe066", life: 1500 };
  if (clear.tSpin === "full") return { scale: 1 + clear.cleared * 0.1, color: "#d0a0ff", life: 1200 };
  if (clear.cleared === 4) return { scale: 1.3, color: "#74f0ff", life: 1200 };
  return {};
}

// 要素を作るための小さな関数
function createElement(tag, className, parent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (parent) parent.appendChild(el);
  return el;
}

function createCanvas(width, height, className, parent) {
  const canvas = createElement("canvas", className, parent);
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// おじゃま予告バー：受ける予定のおじゃまを盤面の横に縦棒で表示する
// ready（確定）は赤、pending（相手の連鎖中で未確定）は橙、gauge（テトリスの溜め攻撃）は黄
function drawGarbageBar(canvas, rowsReady, rowsPending, rowsGauge, unitHeight) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const half = width / 2;
  let bottom = height;
  [
    [rowsReady, "#e33"],
    [rowsPending, "#f93"],
  ].forEach(([rows, color]) => {
    const h = Math.min(bottom, rows * unitHeight);
    ctx.fillStyle = color;
    ctx.fillRect(0, bottom - h, half, h);
    bottom -= h;
  });
  if (rowsGauge > 0) {
    const h = Math.min(height, rowsGauge * unitHeight);
    ctx.fillStyle = "#ee3";
    ctx.fillRect(half, height - h, half, h);
  }
}

class TetrisView {
  constructor(game, parent) {
    this.game = game;
    this.effects = new EffectLayer();

    this.root = createElement("div", "player", parent);
    this.nameEl = createElement("div", "player-name", this.root);
    const field = createElement("div", "field", this.root);

    const holdSide = createElement("div", "side", field);
    createElement("p", "", holdSide).textContent = "HOLD";
    this.holdCtx = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT, "box", holdSide).getContext("2d");

    const height = (SHOWN_BUFFER_ROWS + VISIBLE_ROWS) * CELL;
    this.garbageBar = createCanvas(GARBAGE_BAR_WIDTH, height, "garbage-bar", field);
    this.canvas = createCanvas(COLS * CELL, height, "box", field);
    this.ctx = this.canvas.getContext("2d");

    const nextSide = createElement("div", "side", field);
    createElement("p", "", nextSide).textContent = "NEXT";
    this.nextCanvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT * NEXT_COUNT, "box", nextSide);
    this.nextCtx = this.nextCanvas.getContext("2d");

    const stats = createElement("div", "stats", this.root);
    this.scoreEl = createElement("p", "", stats);
    this.linesEl = createElement("p", "", stats);
    this.lastClearEl = createElement("p", "", stats);
  }

  setName(text) {
    this.nameEl.textContent = text;
  }

  update(dt) {
    this.effects.update(dt);
  }

  // ゲーム本体で起きたことに応じて効果音とエフェクトを出す
  handleEvents(events) {
    let hardDropped = false;
    for (const event of events) {
      switch (event.type) {
        case "move":
          Sound.move();
          break;
        case "rotate":
          Sound.rotate();
          break;
        case "hold":
          Sound.hold();
          break;
        case "hardDrop":
          hardDropped = true;
          Sound.hardDrop();
          this.effects.hardDrop(event.cells, event.distance);
          break;
        case "lock":
          this.effects.lockFlash(event.cells);
          if (event.clearedRows.length > 0) {
            this.effects.lineClear(event.clearedRows, Math.max(event.delay, 100), COLS, clearStyle(event.clear));
          }
          if (event.clear) {
            Sound.clear(event.clear);
            const lines = clearPopupLines(event.clear);
            if (lines.length > 0) this.effects.text(lines, clearPopupOptions(event.clear));
          } else if (!hardDropped) {
            // ハードドロップ時は落下音と重なるので固定音は鳴らさない
            Sound.lock();
          }
          break;
        case "garbage":
          // おじゃまのせり上がり：赤く光らせ、数が多いほど強く揺らす
          Sound.garbage(event.count);
          this.effects.flash("#ff5252", 250, 0.25);
          this.effects.shake = Math.max(this.effects.shake, 60 + Math.min(event.count, 10) * 12);
          break;
        case "gameOver":
          Sound.gameOver();
          break;
      }
    }
  }

  drawCell(x, y, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x * CELL, y * CELL, CELL - 1, CELL - 1);
  }

  // 出現位置の2段（見えない段）を暗く塗り、見える盤面にだけマス目の区切り線を引く
  // （ブロックより先に描いて、ブロックの下に隠れるようにする）
  drawBackground() {
    const { ctx } = this;
    ctx.fillStyle = "#333";
    ctx.fillRect(0, FIRST_SHOWN_ROW * CELL, COLS * CELL, SHOWN_BUFFER_ROWS * CELL);

    const top = BUFFER_ROWS * CELL;
    const bottom = ROWS * CELL;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    // 0.5 ずらすと 1px の線がにじまずに描ける
    for (let x = 1; x < COLS; x++) {
      ctx.moveTo(x * CELL - 0.5, top);
      ctx.lineTo(x * CELL - 0.5, bottom);
    }
    for (let y = BUFFER_ROWS + 1; y < ROWS; y++) {
      ctx.moveTo(0, y * CELL - 0.5);
      ctx.lineTo(COLS * CELL, y * CELL - 0.5);
    }
    ctx.stroke();
  }

  // HOLD・NEXT の1枠の中央にミノを描く（空行を除いて中央寄せ）
  drawPreview(context, type, top, color) {
    const shape = SHAPES[type].filter((row) => row.some((cell) => cell));
    const width = shape[0].length * PREVIEW_CELL;
    const height = shape.length * PREVIEW_CELL;
    const left = (PREVIEW_WIDTH - width) / 2;
    const offsetTop = top + (PREVIEW_HEIGHT - height) / 2;
    context.fillStyle = color;
    shape.forEach((row, y) => {
      row.forEach((cell, x) => {
        if (cell) {
          context.fillRect(left + x * PREVIEW_CELL, offsetTop + y * PREVIEW_CELL, PREVIEW_CELL - 1, PREVIEW_CELL - 1);
        }
      });
    });
  }

  // garbage は対戦時の GarbageState（一人用では null）
  draw(garbage) {
    const { ctx, game } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    // 盤面の座標のまま描けるよう、表示しない見えない段の分だけ上にずらす
    ctx.translate(0, this.effects.shakeOffset() - FIRST_SHOWN_ROW * CELL);
    this.drawBackground();

    // ライン消しの待ち時間中は、消える行が残った状態の盤面を表示する
    const board = game.clearingBoard ?? game.board;
    board.forEach((row, y) => {
      row.forEach((type, x) => {
        if (type) this.drawCell(x, y, COLORS[type]);
      });
    });

    // 待ち時間中は操作中のミノがない
    if (game.piece && !game.gameOver) {
      const { shape, x, y, type } = game.piece;
      const ghostY = game.ghostY();
      shape.forEach((row, dy) => {
        row.forEach((cell, dx) => {
          if (!cell) return;
          // ゴーストは半透明で先に描き、操作中のミノと重なったら操作中のミノを優先
          ctx.globalAlpha = 0.3;
          this.drawCell(x + dx, ghostY + dy, COLORS[type]);
          ctx.globalAlpha = 1;
        });
      });
      shape.forEach((row, dy) => {
        row.forEach((cell, dx) => {
          if (cell) this.drawCell(x + dx, y + dy, COLORS[type]);
        });
      });
    }

    // 文字のエフェクトは見える盤面の中央に出す
    this.effects.draw(ctx, CELL, COLS, VISIBLE_ROWS, BUFFER_ROWS);
    ctx.restore();

    this.holdCtx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    if (game.hold) {
      // ホールド不可の間は灰色で表示
      this.drawPreview(this.holdCtx, game.hold, 0, game.canHold ? COLORS[game.hold] : "gray");
    }

    this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
    game.queue.slice(0, NEXT_COUNT).forEach((type, i) => {
      this.drawPreview(this.nextCtx, type, i * PREVIEW_HEIGHT, COLORS[type]);
    });

    // 予告バーはライン数そのまま（1ライン = 1マスの高さ）
    if (garbage) {
      drawGarbageBar(this.garbageBar, garbage.ready, garbage.pending, garbage.gauge, CELL);
    }

    this.scoreEl.textContent = `SCORE ${game.score}`;
    this.linesEl.textContent = `LINES ${game.lines}`;
    this.lastClearEl.textContent = describeClear(game.lastClear);
  }
}
