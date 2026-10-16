// 盤面の上に重ねて描く短いエフェクト。各エフェクトは寿命（ミリ秒）が尽きたら消える
// 盤面ごとに1つ作る
// 位置の単位は「マス」（盤面の左上が 0, 0）
const PARTICLE_GRAVITY = 14; // 破片が落ちる強さ（マス/秒²）

class EffectLayer {
  constructor() {
    this.list = [];
    this.shake = 0; // 画面の揺れの残り時間（ミリ秒）
  }

  // delay を指定すると、その時間（ミリ秒）たってから出る
  add(effect) {
    this.list.push({ ...effect, age: -(effect.delay ?? 0) });
  }

  // 破片を放射状に飛ばす。count 個、中心 (x, y)、speed は初速（マス/秒）
  burst(x, y, colors, { count = 8, speed = 5, life = 600, size = 0.18, round = false, delay = 0 } = {}) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.add({
        kind: "particle",
        x,
        y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v - speed * 0.3,
        color: colors[i % colors.length],
        size: size * (0.6 + Math.random() * 0.8),
        round,
        life: life * (0.7 + Math.random() * 0.6),
        delay,
      });
    }
  }

  // 広がる輪（ぷよが消えるとき）
  ring(x, y, color, { life = 350, delay = 0 } = {}) {
    this.add({ kind: "ring", x, y, color, life, delay });
  }

  // 盤面全体を一瞬光らせる
  flash(color, life = 250, alpha = 0.35) {
    this.add({ kind: "screen", color, life, alpha });
  }

  // ライン消し：消えた行を光らせ、中央から左右に広がりながら消える。多く消すほど派手にする
  // cols は盤面の列数、lines は一度に消した段数、big は特別な消し方（テトリス・Tスピン・全消し）
  lineClear(rows, life, cols, { big = false, colors = ["#ffffff"] } = {}) {
    const lines = rows.length;
    rows.forEach((row) => {
      this.add({ kind: "line", row, life, color: colors[0] });
      this.burst(cols / 2, row + 0.5, colors, {
        count: 6 + lines * 4 + (big ? 10 : 0),
        speed: 5 + lines + (big ? 3 : 0),
        life: 700,
        size: 0.2,
      });
    });
    if (lines >= 3 || big) this.flash(colors[0], 300, 0.3);
    this.shake = Math.max(this.shake, 40 + lines * 30 + (big ? 60 : 0));
  }

  // ハードドロップ：落ちてきた軌跡を縦に残す
  hardDrop(cells, distance) {
    if (distance === 0) return;
    // 列ごとに一番上のブロックから着地位置の一番下まで
    const columns = {};
    cells.forEach(({ x, y }) => {
      const col = columns[x] ?? { top: y, bottom: y };
      col.top = Math.min(col.top, y);
      col.bottom = Math.max(col.bottom, y);
      columns[x] = col;
    });
    Object.entries(columns).forEach(([x, { top, bottom }]) => {
      this.add({ kind: "trail", x: Number(x), top, bottom: bottom + distance, life: 200 });
    });
    this.shake = 100;
  }

  // 固定したブロックを一瞬光らせる
  lockFlash(cells) {
    this.add({ kind: "flash", cells, life: 120 });
  }

  // 文字を出し、上に浮かびながら消える。lines は1行ずつの文字列の配列
  // options: x / y（マス単位の位置。省略すると盤面中央）、scale（文字の大きさの倍率）、color、life
  text(lines, options = {}) {
    this.add({ kind: "text", lines, life: 1000, scale: 1, color: "white", ...options });
  }

  update(dt) {
    this.list.forEach((e) => (e.age += dt));
    this.list = this.list.filter((e) => e.age < e.life);
    this.shake = Math.max(0, this.shake - dt);
  }

  // 揺れの量（ピクセル）。描画時に盤面全体をずらすのに使う
  shakeOffset() {
    return this.shake > 0 ? (Math.min(this.shake, 250) / 100) * 4 : 0;
  }

  // 文字は topRow 段目から rows 段分の範囲の中央に出す
  draw(ctx, cell, cols, rows, topRow = 0) {
    this.list.forEach((e) => {
      if (e.age < 0) return; // まだ出る時間になっていない
      const t = e.age / e.life; // 0 → 1
      ctx.save();
      if (e.kind === "line") {
        const width = cols * cell * Math.min(1, 0.3 + t * 1.5);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = e.color;
        ctx.fillRect((cols * cell - width) / 2, e.row * cell, width, cell);
      } else if (e.kind === "particle") {
        const sec = e.age / 1000;
        const px = (e.x + e.vx * sec) * cell;
        const py = (e.y + e.vy * sec + 0.5 * PARTICLE_GRAVITY * sec * sec) * cell;
        const size = e.size * cell * (1 - t * 0.5);
        ctx.globalAlpha = 1 - t * t;
        ctx.fillStyle = e.color;
        if (e.round) {
          ctx.beginPath();
          ctx.arc(px, py, size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(px - size / 2, py - size / 2, size, size);
        }
      } else if (e.kind === "ring") {
        ctx.globalAlpha = 0.9 * (1 - t);
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1, cell * 0.12 * (1 - t));
        ctx.beginPath();
        ctx.arc((e.x + 0.5) * cell, (e.y + 0.5) * cell, cell * (0.4 + t * 0.9), 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.kind === "screen") {
        ctx.globalAlpha = e.alpha * (1 - t);
        ctx.fillStyle = e.color;
        ctx.fillRect(0, topRow * cell, cols * cell, rows * cell);
      } else if (e.kind === "trail") {
        const top = e.top * cell;
        const bottom = (e.bottom + 1) * cell;
        const gradient = ctx.createLinearGradient(0, top, 0, bottom);
        gradient.addColorStop(0, "rgba(255,255,255,0)");
        gradient.addColorStop(1, "rgba(255,255,255,0.5)");
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = gradient;
        ctx.fillRect(e.x * cell, top, cell - 1, bottom - top);
      } else if (e.kind === "flash") {
        ctx.globalAlpha = 0.6 * (1 - t);
        ctx.fillStyle = "white";
        e.cells.forEach(({ x, y }) => ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1));
      } else if (e.kind === "text") {
        // 出るときに少し大きく弾んでから、元の大きさに戻る
        const pop = t < 0.12 ? 1 + (1 - t / 0.12) * 0.35 : 1;
        ctx.globalAlpha = t < 0.7 ? 1 : (1 - t) / 0.3;
        ctx.fillStyle = e.color;
        ctx.strokeStyle = "black";
        ctx.lineWidth = 4 * e.scale;
        ctx.font = `bold ${Math.round(cell * 0.7 * e.scale * pop)}px sans-serif`; // 盤面の大きさに合わせる
        ctx.textAlign = "center";
        const lineHeight = cell * 0.9 * e.scale;
        // 位置の指定がなければ盤面中央。指定があってもはみ出さないよう横位置を盤面内に収める
        const width = Math.max(...e.lines.map((line) => ctx.measureText(line).width));
        const centerX = e.x !== undefined ? (e.x + 0.5) * cell : (cols * cell) / 2;
        const x = Math.min(Math.max(centerX, width / 2 + 4), cols * cell - width / 2 - 4);
        const centerY = e.y !== undefined ? (e.y + 0.5) * cell : (topRow + rows / 2) * cell;
        const firstY = centerY - ((e.lines.length - 1) * lineHeight) / 2 - t * cell;
        e.lines.forEach((line, i) => {
          ctx.strokeText(line, x, firstY + i * lineHeight);
          ctx.fillText(line, x, firstY + i * lineHeight);
        });
      }
      ctx.restore();
    });
  }
}
