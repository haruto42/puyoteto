// ぷよぷよの盤面1人分の描画・効果音（ゲームのルールは puyo.js）
const PUYO_CELL = 54;
const PUYO_NEXT_SIZE = 40; // NEXT 表示のぷよ1個の大きさ
const PREVIEW_BLINK = 150; // ゴーストで消えるぷよを点滅させる間隔（ミリ秒）

// 連鎖数の文字の色（添字は 連鎖数 ÷ 2 の切り捨て）
const CHAIN_COLORS = ["#ffffff", "#ffffff", "#ffe066", "#ffa94d", "#ff6b6b", "#f783ff"];

const PUYO_DRAW_COLORS = {
  red: "#e53935",
  green: "#43a047",
  blue: "#1e88e5",
  yellow: "#fdd835",
  nuisance: "#b0b0b0",
};

class PuyoView {
  constructor(game, parent) {
    this.game = game;
    this.effects = new EffectLayer();
    this.time = 0; // 消える前の点滅に使う経過時間

    this.root = createElement("div", "player", parent);
    this.nameEl = createElement("div", "player-name", this.root);
    const field = createElement("div", "field", this.root);

    this.garbageBar = createCanvas(GARBAGE_BAR_WIDTH, PUYO_ROWS * PUYO_CELL, "garbage-bar", field);
    this.canvas = createCanvas(PUYO_COLS * PUYO_CELL, PUYO_ROWS * PUYO_CELL, "box", field);
    this.ctx = this.canvas.getContext("2d");

    const nextSide = createElement("div", "side", field);
    createElement("p", "", nextSide).textContent = "NEXT";
    this.nextCanvas = createCanvas(140, 140, "box", nextSide);
    this.nextCtx = this.nextCanvas.getContext("2d");
    this.incomingEl = createElement("p", "incoming", nextSide);

    const stats = createElement("div", "stats", this.root);
    this.scoreEl = createElement("p", "", stats);
    this.chainEl = createElement("p", "", stats);
  }

  setName(text) {
    this.nameEl.textContent = text;
  }

  update(dt) {
    this.time += dt;
    this.effects.update(dt);
  }

  handleEvents(events) {
    for (const event of events) {
      switch (event.type) {
        case "move":
          Sound.move();
          break;
        case "rotate":
          Sound.rotate();
          break;
        case "lock":
          Sound.lock();
          break;
        case "pop":
          Sound.chain(event.chain);
          this.showChain(event.chain, event.cells);
          this.popEffects(event.chain, event.cells);
          break;
        case "allClear":
          Sound.allClear();
          this.effects.text(["全消し"], { scale: 1.6, color: "#ffe066", life: 1600 });
          this.effects.flash("#ffe066", 400, 0.3);
          this.effects.burst(PUYO_COLS / 2, PUYO_ROWS / 2, Object.values(PUYO_DRAW_COLORS).concat("#ffffff"), {
            count: 50,
            speed: 9,
            life: 1200,
            size: 0.25,
            round: true,
          });
          break;
        case "nuisance":
          // おじゃまが降る：数が多いほど低く重い音と大きな揺れ
          Sound.garbage(Math.ceil(event.count / PUYO_COLS));
          this.effects.shake = Math.max(this.effects.shake, 50 + Math.min(event.count, 30) * 4);
          break;
        case "gameOver":
          Sound.gameOver();
          break;
      }
    }
  }

  // 消えたぷよのあたりに連鎖数を出す。連鎖が進むほど大きく、色も白→黄→橙→赤→紫と派手にする
  showChain(chain, cells) {
    const x = cells.reduce((sum, c) => sum + c.x, 0) / cells.length;
    const y = cells.reduce((sum, c) => sum + c.y, 0) / cells.length;
    const step = Math.min(chain, 10) - 1;
    const color = CHAIN_COLORS[Math.min(Math.floor(chain / 2), CHAIN_COLORS.length - 1)];
    this.effects.text([`${chain}連鎖`], { x, y: Math.max(y, 1.5), scale: 1 + step * 0.12, color });
    // 大きな連鎖では盤面を揺らす
    if (chain >= 4) this.effects.shake = 40 + step * 20;
  }

  // ぷよが消える瞬間に、ぷよの色の破片と輪を出す。連鎖が進むほど破片が多く、大きな連鎖では画面も光る
  popEffects(chain, cells) {
    const delay = PUYO_POP_DELAY - 30;
    cells.forEach(({ x, y }) => {
      const color = PUYO_DRAW_COLORS[this.game.board[y][x]] ?? "#ffffff";
      this.effects.burst(x + 0.5, y + 0.5, [color, "#ffffff"], {
        count: 4 + Math.min(chain, 8),
        speed: 3.5 + chain * 0.3,
        life: 600,
        size: 0.2,
        round: true,
        delay,
      });
      this.effects.ring(x, y, color, { delay });
    });
    if (chain >= 3) this.effects.flash("#ffffff", 220, 0.1 + Math.min(chain, 8) * 0.02);
  }

  // ゴースト：中はうっすら、枠線をぷよの色で描く。highlight のときは太い白線
  drawGhost(context, px, py, size, color, highlight) {
    const cx = px + size / 2;
    const cy = py + size / 2;
    const lineWidth = highlight ? 6 : 3;
    context.save();
    context.globalAlpha = 0.15;
    context.fillStyle = PUYO_DRAW_COLORS[color];
    context.beginPath();
    context.arc(cx, cy, size / 2 - 1, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = lineWidth;
    context.strokeStyle = highlight ? "#ffffff" : PUYO_DRAW_COLORS[color];
    context.beginPath();
    context.arc(cx, cy, size / 2 - lineWidth / 2 - 1, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  drawPuyo(context, px, py, size, color) {
    context.fillStyle = PUYO_DRAW_COLORS[color];
    context.beginPath();
    context.arc(px + size / 2, py + size / 2, size / 2 - 1, 0, Math.PI * 2);
    context.fill();
  }

  draw(garbage) {
    const { ctx, game } = this;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.translate(0, this.effects.shakeOffset());

    // 13段目（見えない段）は暗く塗り分ける
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, PUYO_COLS * PUYO_CELL, PUYO_HIDDEN_ROWS * PUYO_CELL);

    // 出現位置（ここが埋まるとゲームオーバー）に × 印
    ctx.strokeStyle = "#a33";
    ctx.lineWidth = 3;
    const sx = PUYO_SPAWN_X * PUYO_CELL;
    const sy = PUYO_SPAWN_Y * PUYO_CELL;
    const m = PUYO_CELL * 0.25; // × 印の余白
    ctx.beginPath();
    ctx.moveTo(sx + m, sy + m);
    ctx.lineTo(sx + PUYO_CELL - m, sy + PUYO_CELL - m);
    ctx.moveTo(sx + PUYO_CELL - m, sy + m);
    ctx.lineTo(sx + m, sy + PUYO_CELL - m);
    ctx.stroke();

    // 消える直前のぷよは点滅させる
    const popping = new Set((game.popping ?? []).map(({ x, y }) => `${x},${y}`));
    const blinkOff = Math.floor(this.time / 80) % 2 === 0;
    // 操作中は、今置いたら消えるぷよ（盤面とゴーストの両方）をゆっくり点滅させる
    const controlling = game.canControl();
    const willPop = new Set(controlling ? game.predictPops().map(({ x, y }) => `${x},${y}`) : []);
    const previewDim = Math.floor(this.time / PREVIEW_BLINK) % 2 === 0;

    game.board.forEach((row, y) => {
      row.forEach((color, x) => {
        if (!color) return;
        if (popping.has(`${x},${y}`) && blinkOff) return;
        ctx.globalAlpha = willPop.has(`${x},${y}`) && previewDim ? 0.35 : 1;
        this.drawPuyo(ctx, x * PUYO_CELL, y * PUYO_CELL, PUYO_CELL, color);
      });
    });
    ctx.globalAlpha = 1;

    if (controlling) {
      // 着地位置の目安（ちぎれた後の位置）。実体と見分けやすいよう輪っかで描き、
      // 消えるものは輪っかを太い白と元の色で点滅させる
      game.landingCells().forEach(({ x, y, color }) => {
        if (y < 0) return;
        const highlight = willPop.has(`${x},${y}`) && previewDim;
        this.drawGhost(ctx, x * PUYO_CELL, y * PUYO_CELL, PUYO_CELL, color, highlight);
      });
      game.pairCells().forEach(({ x, y, color }) => {
        this.drawPuyo(ctx, x * PUYO_CELL, y * PUYO_CELL, PUYO_CELL, color);
      });
    }

    this.effects.draw(ctx, PUYO_CELL, PUYO_COLS, PUYO_ROWS);
    ctx.restore();

    // NEXT：組ぷよを縦に並べて表示（上が子ぷよ、下が軸ぷよ）
    this.nextCtx.clearRect(0, 0, this.nextCanvas.width, this.nextCanvas.height);
    game.queue.slice(0, PUYO_NEXT_COUNT).forEach(({ axis, child }, i) => {
      const left = 15 + i * 60;
      const top = 10 + i * 40;
      this.drawPuyo(this.nextCtx, left, top, PUYO_NEXT_SIZE, child);
      this.drawPuyo(this.nextCtx, left, top + PUYO_NEXT_SIZE, PUYO_NEXT_SIZE, axis);
    });

    // 予告バーは6個で1段（1マスの高さ）
    if (garbage) {
      drawGarbageBar(this.garbageBar, garbage.ready / PUYO_COLS, garbage.pending / PUYO_COLS, 0, PUYO_CELL);
      this.incomingEl.textContent = garbage.total > 0 ? `予告 ${garbage.total}個` : "";
    }

    this.scoreEl.textContent = `SCORE ${game.score}`;
    const chain = game.chain > 0 ? game.chain : game.lastChain;
    this.chainEl.textContent = `${chain}連鎖（最大 ${game.maxChain}）`;
  }
}
