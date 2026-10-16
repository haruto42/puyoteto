// 1人分のプレイヤー（ゲーム本体・描画・操作する人またはAI・おじゃまの状態）
class Player {
  // config: { type: "tetris" | "puyo", control: "human" | "ai", level, name }
  constructor(config, parent) {
    this.config = config;
    this.isTetris = config.type === "tetris";
    this.game = this.isTetris ? new Tetris() : new Puyo();
    this.view = this.isTetris ? new TetrisView(this.game, parent) : new PuyoView(this.game, parent);
    this.garbage = new GarbageState();
    this.dropTimer = 0;
    this.opponent = null; // 対戦相手（Match が設定する）
    this.ai = null;
    if (config.control === "ai") {
      const AI = this.isTetris ? TetrisAI : PuyoAI;
      this.ai = new AI(
        this.game,
        config.level,
        () => this.garbage.total,
        () => ({ danger: this.opponentDanger(), isTetris: !!this.opponent && this.opponent.isTetris }),
        config.mode
      );
    }
  }

  // 相手がどれだけ危ないか（0〜1）。AIの潰しの判断に使う
  opponentDanger() {
    const o = this.opponent;
    if (!o) return 0;
    if (o.isTetris) {
      const top = o.game.board.findIndex((row) => row.some((cell) => cell));
      return top < 0 ? 0 : Math.min(1, (ROWS - top) / VISIBLE_ROWS);
    }
    // ぷよは、出現位置の列の高さと、盤面の埋まり具合の大きい方
    const board = o.game.board;
    const spawnTop = board.findIndex((row) => row[PUYO_SPAWN_X]);
    const spawnHeight = spawnTop < 0 ? 0 : (PUYO_ROWS - spawnTop) / (PUYO_ROWS - PUYO_HIDDEN_ROWS);
    let filled = 0;
    for (let y = PUYO_HIDDEN_ROWS; y < PUYO_ROWS; y++) filled += board[y].filter(Boolean).length;
    return Math.min(1, Math.max(spawnHeight, filled / (PUYO_COLS * (PUYO_ROWS - PUYO_HIDDEN_ROWS))));
  }

  dispose() {
    if (this.ai && this.ai.dispose) this.ai.dispose();
  }

  reset() {
    this.game.reset();
    this.garbage = new GarbageState();
    this.view.effects = new EffectLayer();
    this.dropTimer = 0;
    if (this.ai) this.ai.plan = null;
  }

  // ---- 人が操作するときに Input / キー入力から呼ばれる ----
  move(dir) {
    return this.game.move(dir, 0);
  }

  softDrop(held) {
    this.game.softDrop(held);
  }

  onKey(code) {
    const game = this.game;
    switch (code) {
      case "KeyX":
        game.rotate(true);
        return true;
      case "KeyZ":
        game.rotate(false);
        return true;
      case "ArrowUp":
        // ぷよは PUYO_HARD_DROP_ENABLED が false の間は何もしない
        game.hardDrop();
        return true;
      case "KeyC":
      case "ShiftLeft":
      case "ShiftRight":
        if (this.isTetris) game.holdPiece();
        return this.isTetris;
    }
    return false;
  }

  // 1フレーム進め、ゲーム本体で起きたことを返す
  update(dt) {
    if (this.ai) this.ai.update(dt);
    if (this.isTetris) {
      // ぷよは自然落下を puyo.js 側で行っている
      this.dropTimer += dt;
      if (this.dropTimer > DROP_INTERVAL) {
        this.game.step();
        this.dropTimer = 0;
      }
    }
    this.game.update(dt);
    return this.game.events.splice(0);
  }
}

const COUNTDOWN_TIME = 3000;
const ROUND_OVER_TIME = 2500;

// 一人用・対戦の進行。players が1人なら一人用
class Match {
  // configs: Player の設定の配列（1つか2つ）、firstTo: 何本先取か
  constructor(configs, firstTo, ui) {
    this.ui = ui; // { container, center, showOverlay(text), hideOverlay(), showResult(text) }
    this.firstTo = firstTo;
    this.wins = configs.map(() => 0);
    this.players = [];
    configs.forEach((config, i) => {
      this.players.push(new Player(config, ui.container));
      // 対戦では2人の間に勝利数などの情報欄を挟む
      if (i === 0 && configs.length === 2) ui.container.appendChild(ui.center);
    });
    this.isVersus = this.players.length === 2;
    // 縦長の画面では、自分の盤面を大きく・相手を小さく表示する（style.css）
    if (this.isVersus && this.human) {
      this.players.forEach((p) => p.view.root.classList.add(p === this.human ? "me" : "opponent"));
    }
    if (this.isVersus) {
      this.players[0].opponent = this.players[1];
      this.players[1].opponent = this.players[0];
    }
    this.paused = false;
    this.startRound();
  }

  // 裏で動いているAIの計算を止める（メニューに戻るときなど）
  dispose() {
    this.players.forEach((p) => p.dispose());
  }

  get human() {
    return this.players.find((p) => p.config.control === "human") ?? null;
  }

  opponentOf(player) {
    return this.players.find((p) => p !== player) ?? null;
  }

  startRound() {
    this.players.forEach((p) => p.reset());
    this.players.forEach((p) => this.connect(p));
    this.elapsed = 0;
    this.state = "countdown";
    this.timer = COUNTDOWN_TIME;
    this.lastCount = null;
    this.updateNames();
  }

  restart() {
    this.wins = this.wins.map(() => 0);
    this.ui.hideOverlay();
    this.startRound();
  }

  updateNames() {
    this.players.forEach((p, i) => {
      // テトリスのAIはモードも表示する（バランス以外のとき）
      const mode = p.isTetris && p.config.mode && p.config.mode !== "balance" ? `・${TETRIS_AI_MODES[p.config.mode]}` : "";
      const who = p.config.control === "human" ? "あなた" : `AI（${AI_LEVELS[p.config.level].label}${mode}）`;
      const stars = this.isVersus ? " " + "★".repeat(this.wins[i]) + "☆".repeat(this.firstTo - this.wins[i]) : "";
      p.view.setName(`${who}${stars}`);
    });
  }

  // おじゃまを受け取るタイミングで呼ばれる処理をゲーム本体に登録する（reset で消えるので毎ラウンド）
  connect(player) {
    const opponent = this.opponentOf(player);
    if (!opponent) return;
    const garbage = () => player.garbage;
    if (player.isTetris) {
      player.game.onNoClearLock = () => {
        // 対ぷよ：溜めていた攻撃（ランプ）を、来ているおじゃま分を引いてから放つ
        if (!opponent.isTetris && garbage().gauge > 0) {
          const remaining = garbage().offset(garbage().gauge);
          garbage().gauge = 0;
          if (remaining > 0) {
            opponent.garbage.ready += Math.round(Garbage.lampsToNuisance(remaining) * Garbage.multiplier(true, false));
          }
        }
        // 確定しているおじゃまをせり上げる（対ぷよは一度に7段まで）
        const limit = opponent.isTetris ? Infinity : TETRIS_MAX_RISE_VS_PUYO;
        const count = Math.min(garbage().ready, limit);
        if (count > 0) {
          garbage().ready -= count;
          // 穴の列はときどき変える（同じ列が続く方がつなげやすい）
          if (Math.random() < 0.3) garbage().hole = Math.floor(Math.random() * COLS);
          player.game.queueGarbage(count, garbage().hole);
        }
      };
    } else {
      player.game.takeNuisance = () => {
        const count = Math.min(garbage().ready, PUYO_MAX_NUISANCE_DROP);
        garbage().ready -= count;
        return count;
      };
    }
  }

  // ゲーム本体で起きたことのうち、攻撃に関わるものを処理する
  processAttacks(player, events) {
    const opponent = this.opponentOf(player);
    if (!opponent) return;
    const mine = player.garbage;
    for (const event of events) {
      if (event.type === "lock" && event.attack > 0) {
        const amount = Math.floor(event.attack * Garbage.tetrisMultiplier(this.elapsed));
        const remaining = mine.offset(amount);
        if (opponent.isTetris) {
          opponent.garbage.ready += this.scaleSent(mine, remaining, true, true); // テト同士：消した瞬間に送る
        } else {
          mine.gauge = Math.min(mine.gauge + remaining, MAX_LAMPS); // 対ぷよ：RENが途切れるまで溜める
        }
      } else if (event.type === "pop") {
        this.puyoAttack(player, opponent, event.score + event.bonus);
      } else if (event.type === "chainEnd") {
        // 連鎖が終わったら、相手に送った分が確定して降る状態になる
        opponent.garbage.ready += opponent.garbage.pending;
        opponent.garbage.pending = 0;
        mine.resetChain();
      }
    }
  }

  // ぷよの連鎖1回分の攻撃
  puyoAttack(player, opponent, points) {
    const mine = player.garbage;
    const rate = Garbage.puyoRate(this.elapsed);
    if (!opponent.isTetris) {
      // ぷよ同士：ぷよぷよ通と同じく、レートごとにおじゃまぷよ1個。端数は持ち越し
      const total = points + mine.carry;
      const count = Math.floor(total / rate);
      mine.carry = total - count * rate;
      opponent.garbage.pending += this.scaleSent(mine, mine.offset(count), false, false);
      return;
    }
    // 対テトリス：来ているおじゃまがある間はぷよぷよ通の計算で相殺する（最低1個）
    if (!mine.counterStarted && mine.total > 0) {
      const total = points + mine.offsetCarry;
      const count = Math.floor(total / rate);
      mine.offsetCarry = total - count * rate;
      const offsetAmount = Math.max(1, count);
      if (offsetAmount <= mine.total) {
        mine.offset(offsetAmount);
        return;
      }
      // 相殺し切ったら、この連鎖から攻撃に移る
      mine.offset(mine.total);
    }
    mine.counterStarted = true;
    const { lines, carry } = Garbage.puyoScoreToLines(points + mine.carry, rate);
    mine.carry = carry;
    opponent.garbage.pending += this.scaleSent(mine, lines, false, true);
  }

  // 相殺に使う量はそのままで、相手に送る量だけ倍率をかける。端数は次の攻撃に持ち越す
  scaleSent(mine, amount, fromTetris, toTetris) {
    const scaled = amount * Garbage.multiplier(fromTetris, toTetris) + mine.fraction;
    const sent = Math.floor(scaled);
    mine.fraction = scaled - sent;
    return sent;
  }

  update(dt) {
    if (this.paused) return;
    if (this.state === "countdown") {
      this.timer -= dt;
      const count = Math.ceil(this.timer / 1000);
      if (count !== this.lastCount) {
        this.lastCount = count;
        if (count > 0) {
          this.ui.showOverlay(String(count));
          Sound.countdown(false);
        }
      }
      if (this.timer <= 0) {
        this.state = "playing";
        this.ui.showOverlay("GO!", 600);
        Sound.countdown(true);
      }
      return;
    }

    if (this.state === "playing") this.elapsed += dt;
    for (const player of this.players) {
      if (this.state === "playing") {
        const events = player.update(dt);
        this.processAttacks(player, events);
        player.view.handleEvents(events);
      }
      player.view.update(dt);
    }

    if (this.state === "playing") this.checkGameOver();
    else if (this.state === "roundOver") {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.ui.hideOverlay();
        this.startRound();
      }
    }
  }

  checkGameOver() {
    const losers = this.players.filter((p) => p.game.gameOver);
    if (losers.length === 0) return;
    if (!this.isVersus) {
      this.state = "matchOver";
      this.ui.showResult("ゲームオーバー");
      return;
    }
    if (losers.length === 2) {
      this.state = "roundOver";
      this.timer = ROUND_OVER_TIME;
      this.ui.showOverlay("引き分け");
      return;
    }
    const winnerIndex = this.players.findIndex((p) => !p.game.gameOver);
    this.wins[winnerIndex]++;
    this.updateNames();
    const winner = this.players[winnerIndex];
    const winnerName = winner.config.control === "human" ? "あなた" : `${winnerIndex + 1}P`;
    if (this.wins[winnerIndex] >= this.firstTo) {
      this.state = "matchOver";
      if (winner.config.control === "human") Sound.win();
      this.ui.showResult(`${winnerName}の勝ち！`);
    } else {
      this.state = "roundOver";
      this.timer = ROUND_OVER_TIME;
      this.ui.showOverlay(`${winnerName}がラウンド取得`);
    }
  }

  draw() {
    this.players.forEach((p) => p.view.draw(this.isVersus ? p.garbage : null));
    if (this.isVersus) {
      const rate = Garbage.puyoRate(this.elapsed);
      const seconds = Math.floor(this.elapsed / 1000);
      const margin = this.elapsed >= MARGIN_TIME ? `マージンタイム（ぷよレート ${rate}）` : `マージンタイムまで ${Math.ceil((MARGIN_TIME - this.elapsed) / 1000)}秒`;
      this.ui.center.innerHTML = `
        <p class="score-line">${this.wins[0]} - ${this.wins[1]}</p>
        <p>${this.firstTo}本先取</p>
        <p>${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}</p>
        <p class="margin">${margin}</p>`;
    }
  }
}
