// ぷよぷよの最強AIの思考部分（Web Worker の中でも、画面側でもそのまま動く）
// 外のコードに頼らないよう、ルールの数値は rules として受け取る。
// 速さのため盤面は Uint8Array（添字 = y * 列数 + x）で持つ。0:空 1〜4:色 5:おじゃま
//
// 考え方（人間の理論をまねる）
// 1. 今の組ぷよ＋NEXTの全置き方をビームサーチで3手先まで展開する
// 2. 盤面は「連鎖のタネ（あと何個足せば何連鎖撃てるか）」を中心に評価する
// 3. 撃つかどうかは、本線・対応（相殺）・潰し・負けそうなとき、の状況で判断する
function createPuyoAICore(rules) {
  const { cols, rows, hidden, spawnX, spawnY, popCount, chainBonus, connectBonus, colorBonus, targetPoints, maxNuisanceDrop, childOffsets } = rules;
  const SIZE = cols * rows;
  const NUISANCE = 5;
  const COLOR_COUNT = 4;
  const VISIBLE_CELLS = cols * (rows - hidden);

  const BEAM_WIDTH = 40; // 各手で残す候補の数
  const FUTURE_DISCOUNT = 0.9; // 先の手で撃つ連鎖ほど不確かなので少し割り引く

  // 評価の重み（自動調整で後から変えられるよう、まとめておく）
  const W = {
    potentialScore: 1, // 連鎖のタネの点数
    potentialNeed: 300, // タネを撃つのに足りない個数1個あたりの減点（盤面が埋まるほど大きくする）
    triggerColor: 800, // タネを撃てる色の種類1つあたり（どの色が来ても撃てる形ほど良い）
    garbageRobust: 0.6, // おじゃまが降った後のタネをどれだけ重視するか（0〜1）
    connection: 40, // 同じ色が隣り合っている組1つあたり
    bumpiness: 25, // 隣の列との高さの差1段あたり
    spawnColumn: 2000, // 3列目が9段を超えた1段あたり
    spawnNeighbor: 600, // 2・4列目が10段を超えた1段あたり
    blockedColumn: 5000, // 出現位置から行けなくなった列1つあたり
    nuisance: 60, // 盤面に残るおじゃまぷよ1個あたり
    fireBonus: 1000, // 撃ってよい連鎖を撃ったときの加点（＋点数×fireScore）
    fireScore: 1.2,
    badFire: 2000, // 撃つべきでない連鎖を撃ったときの、連鎖数1あたりの減点
    // 以下は相手がテトリスのとき専用。細かいおじゃまが続いて真ん中が埋まりやすいので、真ん中を低く保つ
    vsTetrisMiddle: 3, // 出現位置まわりの減点（spawnColumn・spawnNeighbor）に掛ける倍率
    vsTetrisMargin: 3, // 出現位置まわりの減点が始まる高さを、この段数だけ下げる
    vsTetrisFireFull: 0.3, // 盤面がこれだけ埋まったら、vsTetrisFireChain 連鎖以上を撃つ
    vsTetrisFireChain: 4,
  };
  let vsTetris = false; // 今考えている相手がテトリスか

  // ---------- 盤面の基本操作 ----------

  // 列の一番上のぷよの段（空なら rows）
  function columnTop(b, x) {
    for (let y = 0; y < rows; y++) if (b[y * cols + x]) return y;
    return rows;
  }

  // 列の一番上に1個積む。入らなければ false（盤面の上にはみ出した分は消える）
  function dropInto(b, x, color) {
    const y = columnTop(b, x) - 1;
    if (y < 0) return false;
    b[y * cols + x] = color;
    return true;
  }

  // 浮いているぷよを下まで落とす
  function settle(b) {
    for (let x = 0; x < cols; x++) {
      let write = rows - 1;
      for (let y = rows - 1; y >= 0; y--) {
        const c = b[y * cols + x];
        if (!c) continue;
        if (write !== y) {
          b[write * cols + x] = c;
          b[y * cols + x] = 0;
        }
        write--;
      }
    }
  }

  const visited = new Uint8Array(SIZE);
  const stack = new Int16Array(SIZE);
  const groupCells = new Int16Array(SIZE);

  // 連鎖を最後まで進める（b を書き換える）。連鎖数と点数を返す
  function resolve(b) {
    let chain = 0;
    let score = 0;
    for (;;) {
      settle(b);
      visited.fill(0);
      let popTotal = 0;
      let connectSum = 0;
      let colorMask = 0;
      const toClear = [];
      for (let i = hidden * cols; i < SIZE; i++) {
        const c = b[i];
        if (!c || c === NUISANCE || visited[i]) continue;
        // 同じ色のつながりを数える（13段目は除く）
        let top = 0;
        let size = 0;
        stack[top++] = i;
        visited[i] = 1;
        while (top > 0) {
          const j = stack[--top];
          groupCells[size++] = j;
          const x = j % cols;
          const y = (j - x) / cols;
          if (x > 0 && !visited[j - 1] && b[j - 1] === c) { visited[j - 1] = 1; stack[top++] = j - 1; }
          if (x < cols - 1 && !visited[j + 1] && b[j + 1] === c) { visited[j + 1] = 1; stack[top++] = j + 1; }
          if (y > hidden && !visited[j - cols] && b[j - cols] === c) { visited[j - cols] = 1; stack[top++] = j - cols; }
          if (y < rows - 1 && !visited[j + cols] && b[j + cols] === c) { visited[j + cols] = 1; stack[top++] = j + cols; }
        }
        if (size >= popCount) {
          popTotal += size;
          connectSum += connectBonus[Math.min(size, 11)];
          colorMask |= 1 << c;
          for (let k = 0; k < size; k++) toClear.push(groupCells[k]);
        }
      }
      if (popTotal === 0) break;
      chain++;
      let colors = 0;
      for (let c = 1; c <= COLOR_COUNT; c++) if (colorMask & (1 << c)) colors++;
      const bonus = chainBonus[Math.min(chain, chainBonus.length) - 1] + connectSum + colorBonus[colors - 1];
      score += 10 * popTotal * Math.min(999, Math.max(1, bonus));
      // 消えるぷよと、その隣のおじゃまぷよ（13段目は除く）を消す
      for (const j of toClear) {
        const x = j % cols;
        const y = (j - x) / cols;
        if (x > 0 && b[j - 1] === NUISANCE && y >= hidden) b[j - 1] = 0;
        if (x < cols - 1 && b[j + 1] === NUISANCE && y >= hidden) b[j + 1] = 0;
        if (y > hidden && b[j - cols] === NUISANCE) b[j - cols] = 0;
        if (y < rows - 1 && b[j + cols] === NUISANCE) b[j + cols] = 0;
      }
      for (const j of toClear) b[j] = 0;
    }
    return { chain, score };
  }

  // 組ぷよを置いた盤面（連鎖はまだ進めない）。置けない（通り道がない・列が外）なら null
  function placePair(board, x, rotation, axis, child) {
    const [dx, dy] = childOffsets[rotation];
    const childX = x + dx;
    if (childX < 0 || childX >= cols) return null;
    const from = Math.min(spawnX, x, childX);
    const to = Math.max(spawnX, x, childX);
    for (let c = from; c <= to; c++) if (board[spawnY * cols + c]) return null;
    const b = board.slice();
    if (dy === 1) {
      dropInto(b, childX, child);
      dropInto(b, x, axis);
    } else {
      dropInto(b, x, axis);
      dropInto(b, childX, child);
    }
    return b;
  }

  function isDead(b) {
    return b[spawnY * cols + spawnX] !== 0;
  }

  function fullness(b) {
    let filled = 0;
    for (let i = hidden * cols; i < SIZE; i++) if (b[i]) filled++;
    return filled / VISIBLE_CELLS;
  }

  // おじゃまぷよを降らせた盤面（見積もり用）。6個ごとに横1段、余りは低い列から
  function withNuisance(board, count) {
    const b = board.slice();
    const rowsToDrop = Math.floor(count / cols);
    const order = [...Array(cols).keys()].sort((a, c) => columnTop(b, c) - columnTop(b, a));
    const extra = new Set(order.slice(0, count % cols));
    for (let x = 0; x < cols; x++) {
      const n = rowsToDrop + (extra.has(x) ? 1 : 0);
      for (let i = 0; i < n; i++) dropInto(b, x, NUISANCE);
    }
    return b;
  }

  // ---------- 盤面の評価 ----------

  // 連鎖のタネ：どこかの列に同じ色を1〜3個足したときに撃てる一番大きい連鎖
  // 足す場所の隣（左右・下）にその色がないなら、3個以下では消えないので調べない
  // colorChains[c] は、色 c を2個以内足して撃てる一番大きい連鎖（撃てる色の種類を数えるため）
  function detectPotential(b) {
    let best = { chain: 0, score: 0, need: 0 };
    const colorChains = new Array(COLOR_COUNT + 1).fill(0);
    for (let x = 0; x < cols; x++) {
      const top = columnTop(b, x);
      const y = top - 1;
      if (y < hidden) continue;
      for (let c = 1; c <= COLOR_COUNT; c++) {
        const i = y * cols + x;
        const touches =
          (x > 0 && b[i - 1] === c) || (x < cols - 1 && b[i + 1] === c) || (y < rows - 1 && b[i + cols] === c);
        if (!touches) continue;
        for (let n = 1; n <= 3 && y - n + 1 >= hidden; n++) {
          const t = b.slice();
          for (let k = 0; k < n; k++) t[(y - k) * cols + x] = c;
          const r = resolve(t);
          if (r.chain > 0) {
            if (r.score - n * W.potentialNeed > best.score - best.need * W.potentialNeed) {
              best = { chain: r.chain, score: r.score, need: n };
            }
            if (n <= 2) colorChains[c] = Math.max(colorChains[c], r.chain);
            break; // それ以上足しても同じ連鎖が早く始まるだけ
          }
        }
      }
    }
    // 一番大きいタネに近い連鎖（2連鎖以上・最大より2連鎖少ないまで）を撃てる色の種類
    const enough = Math.max(2, best.chain - 2);
    best.triggerColors = colorChains.filter((chain) => chain >= enough).length;
    return best;
  }

  // assumeGarbage：これだけおじゃまが降っても撃てるタネかを見る（0 なら見ない）
  function evaluate(b, assumeGarbage = 0) {
    const heights = [];
    for (let x = 0; x < cols; x++) heights.push(rows - columnTop(b, x));

    let pot = detectPotential(b);
    if (assumeGarbage > 0) {
      // おじゃまで発火点が埋もれる形は、タネの価値を下げる（発火点を高く持つ形を好む）
      const after = detectPotential(withNuisance(b, assumeGarbage));
      const r = W.garbageRobust;
      pot = {
        chain: pot.chain,
        score: pot.score * (1 - r) + after.score * r,
        need: pot.need,
        triggerColors: pot.triggerColors,
      };
    }
    // 盤面が埋まってくるほど、少ない個数で撃てる（すぐ撃てる）タネを重視する
    const full = fullness(b);
    const needWeight = W.potentialNeed * (1 + 6 * Math.max(0, full - 0.45));
    let value = pot.score * W.potentialScore - pot.need * needWeight + pot.triggerColors * W.triggerColor;

    // 同じ色が隣り合っている組の数（連鎖の材料がまとまっているほど良い）
    let connections = 0;
    let nuisance = 0;
    for (let i = hidden * cols; i < SIZE; i++) {
      const c = b[i];
      if (!c) continue;
      if (c === NUISANCE) {
        nuisance++;
        continue;
      }
      const x = i % cols;
      if (x < cols - 1 && b[i + 1] === c) connections++;
      if (i + cols < SIZE && b[i + cols] === c) connections++;
    }
    value += connections * W.connection - nuisance * W.nuisance;

    let bump = 0;
    for (let x = 0; x < cols - 1; x++) bump += Math.abs(heights[x] - heights[x + 1]);
    value -= bump * W.bumpiness;

    // 出現位置まわりの高さと、通り道がふさがれた列
    const midScale = vsTetris ? W.vsTetrisMiddle : 1;
    const margin = vsTetris ? W.vsTetrisMargin : 0;
    value -= Math.max(0, heights[spawnX] - (9 - margin)) * W.spawnColumn * midScale;
    value -= Math.max(0, heights[spawnX - 1] - (10 - margin)) * W.spawnNeighbor * midScale;
    value -= Math.max(0, heights[spawnX + 1] - (10 - margin)) * W.spawnNeighbor * midScale;
    for (const dir of [-1, 1]) {
      let wall = false;
      for (let x = spawnX + dir; x >= 0 && x < cols; x += dir) {
        if (b[spawnY * cols + x]) wall = true;
        else if (wall) value -= W.blockedColumn;
      }
    }
    return { value, potential: pot };
  }

  // ---------- 撃つかどうか ----------

  // ctx: { incoming, lethal, opponentDanger, peak }、before: 置く前の盤面の埋まり具合
  // peak は今の盤面のタネの最大連鎖数
  function shouldFire(result, ctx, before) {
    if (ctx.lethal) return true; // 負けそうなら何でも撃つ
    const sent = result.score / targetPoints; // おじゃまぷよ換算
    if (result.chain >= 2 && ctx.incoming >= cols && sent >= ctx.incoming * 0.8) return true; // 対応（相殺）
    if (result.chain >= 2 && ctx.opponentDanger >= 0.75) return true; // 潰し
    if (result.chain >= 10) return true; // 十分大きい本線
    if (before >= 0.75 && result.chain >= 2) return true; // 盤面がいっぱいで余裕がない
    if (before >= 0.6 && result.chain >= 3) return true;
    if (before >= 0.5 && result.chain >= 6 && result.chain >= ctx.peak - 1) return true; // 本線が育ちきった
    // 相手がテトリスなら、細かい攻撃で崩される前に早めに撃つ
    if (ctx.vsTetris && before >= W.vsTetrisFireFull && result.chain >= W.vsTetrisFireChain) return true;
    return false;
  }

  function fireValue(result, ctx, before) {
    if (result.chain === 0) return 0;
    if (shouldFire(result, ctx, before)) return W.fireBonus + result.score * W.fireScore;
    return -W.badFire * result.chain;
  }

  // ---------- 探索 ----------

  // 1手分の置き方をすべて展開する
  function expand(node, pair, ctx, depth) {
    const children = [];
    const before = fullness(node.board);
    for (let rotation = 0; rotation < 4; rotation++) {
      for (let x = 0; x < cols; x++) {
        const b = placePair(node.board, x, rotation, pair[0], pair[1]);
        if (!b) continue;
        const result = resolve(b);
        if (isDead(b)) continue;
        const gained = fireValue(result, ctx, before) * Math.pow(FUTURE_DISCOUNT, depth);
        children.push({
          board: b,
          first: node.first ?? { x, rotation, chain: result.chain, score: result.score },
          acc: node.acc + gained,
          fired: node.fired || result.chain > 0,
        });
      }
    }
    return children;
  }

  // request: { board（Uint8Array）, pairs（[[軸, 子], ...] 今の組とNEXT）, incoming, opponentDanger }
  function think(request) {
    const board = Uint8Array.from(request.board);
    vsTetris = !!request.opponentIsTetris;
    const incoming = Math.min(request.incoming, maxNuisanceDrop);
    const lethal = isDead(withNuisance(board, incoming)) || rows - columnTop(board, spawnX) >= 11;
    const ctx = {
      incoming,
      lethal,
      opponentDanger: request.opponentDanger,
      vsTetris: request.opponentIsTetris,
      peak: detectPotential(board).chain,
    };
    // 相手がテトリスなら、来ていなくても1段分（6個）は降るものとして形を評価する
    const assumeGarbage = Math.max(incoming, request.opponentIsTetris ? cols : 0);

    let beam = [{ board, first: null, acc: 0, fired: false }];
    let best = null;
    request.pairs.forEach((pair, depth) => {
      // 撃った後の盤面は、来ているおじゃまの心配がなくなったものとして扱う
      const children = beam.flatMap((node) => expand(node, pair, depth === 0 ? ctx : { ...ctx, lethal: false }, depth));
      children.forEach((child) => {
        child.eval = evaluate(child.board, assumeGarbage);
        child.total = child.acc + child.eval.value;
      });
      children.sort((a, c) => c.total - a.total);
      beam = children.slice(0, BEAM_WIDTH);
      if (beam.length > 0) best = beam[0];
    });
    if (!best) return { x: spawnX, rotation: 0, found: false };
    return {
      x: best.first.x,
      rotation: best.first.rotation,
      found: true,
      fires: best.first.chain,
      potential: best.eval.potential.chain,
    };
  }

  // weights は調整用（テストから重みを書き換えられるように）
  return { think, resolve, placePair, evaluate, detectPotential, weights: W };
}
