// テトリスの最強AIの思考部分（Web Worker の中でも、画面側でもそのまま動く）
// 外のコードに頼らないよう、ルールの数値は rules として受け取る。
// 速さのため盤面は「1行 = 1つの数値」で持つ（x 列目が埋まっていれば (1 << x) のビットが立つ）
//
// 考え方（人間の理論をまねる）
// 1. 今のミノと NEXT を、ホールドの使い方も含めてビームサーチで数手先まで展開する
// 2. 置き方は、回転・左右移動・一番下まで落とす、でたどり着ける所をすべて探す（Tスピンの差し込みも含む）
// 3. 攻撃量（テトリス・Tスピン・B2B・REN）を稼ぎ、Tスピンの穴とテトリス用の井戸を作る形を高く評価する
// 4. モード（バランス・REN・パフェ・掘り）ごとに、評価の重みと狙いを切り替える
function createTetrisAICore(rules) {
  const { cols, rows, buffer, shapes, kicksJLSTZ, kicksI, attackLines, attackTSpin, attackTSpinMini, attackB2B, attackPerfect } = rules;
  const FULL = (1 << cols) - 1;

  const BEAM_WIDTH = 30; // 各手で残す候補の数（強さで変えられる）
  const MAX_DEPTH = 4; // 何手先まで読むか（強さで変えられる）
  const PC_NODE_LIMIT = 30000; // パフェの並べ方を探すときに試す置き方の上限（時間がかかりすぎないように）
  const REN_WELL = [3, 4, 5, 6]; // REN特化で空けておく4列（真ん中）
  const FUTURE_DISCOUNT = 0.95; // 先の手で得る攻撃ほど不確かなので少し割り引く

  // 評価の重み（自動調整で後から変えられるよう、まとめておく）
  const W = {
    attack: 40, // 攻撃1ライン分
    waste: 25, // 盤面が低いのに、火力の低い消し方（シングル〜トリプル）をした1ラインあたりの減点
    hole: 60, // 穴1つあたりの減点
    covered: 5, // 穴の上に乗っているブロック1つあたりの減点（掘りにくさ）
    bumpiness: 4, // 隣の列との高さの差1段あたり（井戸の列は除く）
    height: 3, // 平均の高さ1段あたり
    danger: 30, // 実質の高さ（来ているおじゃまを含む）が10段を超えた1段あたり
    well: 10, // 井戸の深さ1段あたりの加点（4段まで。テトリス狙い）
    tSlot: 150, // TSD の穴1つあたりの加点（2つまで）。テトリスと同じ火力なので、高めにしないと作りに行かない
    b2b: 60, // B2B が続いている状態の加点
    dangerLine: 10, // この高さを超えたら danger で減点
    // 以下はモード専用（バランスでは 0）
    renSide: 0, // REN：4列の外側の低い方の高さ1段あたりの加点（14段まで）
    renWellFill: 0, // REN：4列の中に残っているブロックが3つを超えた1つあたりの減点
    renEarlyClear: 0, // REN：外側が積み上がる前にラインを消したときの減点
    comboStep: 0, // REN：RENを続けたときの加点（REN数あたり）
    comboBreak: 0, // REN：RENを途切れさせたときの減点（途切れたREN数あたり）
    pcHigh: 0, // パフェ：4段を超えて積んだ1段あたりの減点
  };

  // モードごとに上書きする重み
  const MODE_WEIGHTS = {
    balance: {},
    // 真ん中4列を空けて外側を高く積み、RENを長く続ける（4列REN）
    ren: { well: 0, tSlot: 0, b2b: 0, waste: 0, height: 0, dangerLine: 15, renSide: 25, renWellFill: 80, renEarlyClear: 150, comboStep: 60, comboBreak: 120 },
    // 盤面を低く平らに保ち、全消しできる並べ方があれば狙う
    pc: { well: 0, tSlot: 0, b2b: 0, waste: 0, hole: 150, covered: 15, bumpiness: 10, height: 30, pcHigh: 120 },
    // 穴（おじゃま）を掘ることを最優先にし、攻撃より生き残りを重視する
    dig: { attack: 15, waste: 0, well: 0, tSlot: 0, b2b: 0, hole: 150, covered: 25, height: 6, danger: 50 },
  };
  let w = W; // 今考えているモードの重み

  // ---------- ミノ ----------

  function rotateMatrix(m) {
    const n = m.length;
    return m.map((row, y) => row.map((_, x) => m[n - 1 - x][y]));
  }

  // CELLS[type][rotation] = [[dx, dy], ...]
  const CELLS = {};
  for (const [type, shape] of Object.entries(shapes)) {
    CELLS[type] = [];
    let m = shape;
    for (let r = 0; r < 4; r++) {
      const cells = [];
      m.forEach((row, y) => row.forEach((v, x) => v && cells.push([x, y])));
      CELLS[type].push(cells);
      m = rotateMatrix(m);
    }
  }

  function spawnPiece(type) {
    return { type, x: Math.floor((cols - shapes[type].length) / 2), y: buffer - 2, rot: 0 };
  }

  function collides(board, type, x, y, rot) {
    for (const [dx, dy] of CELLS[type][rot]) {
      const bx = x + dx;
      const by = y + dy;
      if (bx < 0 || bx >= cols || by >= rows) return true;
      if (by >= 0 && (board[by] >> bx) & 1) return true;
    }
    return false;
  }

  // SRS の回転。成功したら { piece, kick }、失敗したら null
  function tryRotate(board, p, clockwise) {
    if (p.type === "O") return null;
    const to = (p.rot + (clockwise ? 1 : 3)) % 4;
    const kicks = (p.type === "I" ? kicksI : kicksJLSTZ)[`${p.rot}>${to}`];
    for (let i = 0; i < kicks.length; i++) {
      const x = p.x + kicks[i][0];
      const y = p.y - kicks[i][1];
      if (!collides(board, p.type, x, y, to)) return { piece: { ...p, x, y, rot: to }, kick: i };
    }
    return null;
  }

  function dropY(board, p) {
    let y = p.y;
    while (!collides(board, p.type, p.x, y + 1, p.rot)) y++;
    return y;
  }

  // ガイドラインの3コーナールール（本体の detectTSpin と同じ判定）
  function tSpinType(board, p, rotated, kick) {
    if (p.type !== "T" || !rotated) return null;
    const filled = (bx, by) => bx < 0 || bx >= cols || by >= rows || (by >= 0 && ((board[by] >> bx) & 1) === 1);
    const cx = p.x + 1;
    const cy = p.y + 1;
    const corners = [filled(cx - 1, cy - 1), filled(cx + 1, cy - 1), filled(cx + 1, cy + 1), filled(cx - 1, cy + 1)];
    if (corners.filter(Boolean).length < 3) return null;
    const front = [corners[p.rot], corners[(p.rot + 1) % 4]];
    return (front[0] && front[1]) || kick === 4 ? "full" : "mini";
  }

  // ---------- 置き方の列挙 ----------

  // start から操作でたどり着ける置き方をすべて返す（幅優先なので手数が最短の経路）
  // 手数が同じなら回転を先に試すので、「回転 → 移動 → ハードドロップ」の経路になる
  function placements(board, start) {
    const results = new Map();
    const keyOf = (p, rotated) => `${p.x},${p.y},${p.rot},${p.type === "T" && rotated ? 1 : 0}`;
    const seen = new Set([keyOf(start, false)]);
    const queue = [{ piece: start, rotated: false, kick: 0, path: [] }];
    for (let head = 0; head < queue.length; head++) {
      const s = queue[head];
      const y = dropY(board, s.piece);
      const fell = y !== s.piece.y;
      const placed = { ...s.piece, y };
      const tspin = tSpinType(board, placed, fell ? false : s.rotated, fell ? 0 : s.kick);
      const placementKey = `${placed.x},${placed.y},${placed.rot},${tspin}`;
      if (!results.has(placementKey)) results.set(placementKey, { piece: placed, tspin, path: s.path });

      const next = [];
      for (const cw of [true, false]) {
        const r = tryRotate(board, s.piece, cw);
        if (r) next.push({ piece: r.piece, rotated: true, kick: r.kick, name: cw ? "cw" : "ccw" });
      }
      for (const dx of [-1, 1]) {
        const p = s.piece;
        if (!collides(board, p.type, p.x + dx, p.y, p.rot)) {
          next.push({ piece: { ...p, x: p.x + dx }, rotated: false, kick: 0, name: dx < 0 ? "left" : "right" });
        }
      }
      if (fell) next.push({ piece: placed, rotated: false, kick: 0, name: "sonic" });
      for (const n of next) {
        const key = keyOf(n.piece, n.rotated);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ piece: n.piece, rotated: n.rotated, kick: n.kick, path: [...s.path, n.name] });
      }
    }
    return [...results.values()];
  }

  // ---------- 置いた結果 ----------

  // 盤面に置いてラインを消す。ロックアウト（全部見える盤面より上）なら null
  function lock(board, p) {
    const b = board.slice();
    let lockOut = true;
    for (const [dx, dy] of CELLS[p.type][p.rot]) {
      const by = p.y + dy;
      b[by] |= 1 << (p.x + dx);
      if (by >= buffer) lockOut = false;
    }
    if (lockOut) return null;
    let write = rows - 1;
    let cleared = 0;
    for (let y = rows - 1; y >= 0; y--) {
      if (b[y] === FULL) {
        cleared++;
        continue;
      }
      b[write--] = b[y];
    }
    while (write >= 0) b[write--] = 0;
    const perfect = cleared > 0 && b.every((row) => row === 0);
    return { board: b, cleared, perfect };
  }

  function renAttack(combo) {
    if (combo <= 0) return 0;
    if (combo <= 3) return 1;
    if (combo <= 5) return 2;
    if (combo <= 7) return 3;
    if (combo <= 10) return 4;
    return 5;
  }

  // 本体の attackOf と同じ計算。B2B と REN の状態も更新して返す
  function attackFor(cleared, tspin, b2b, combo, perfect) {
    if (cleared === 0) return { attack: 0, b2b, combo: -1, difficult: false };
    const table = tspin === "full" ? attackTSpin : tspin === "mini" ? attackTSpinMini : attackLines;
    const difficult = cleared === 4 || tspin !== null;
    const nextCombo = combo + 1;
    let attack = table[cleared] ?? 0;
    if (difficult && b2b) attack += attackB2B;
    attack += renAttack(nextCombo);
    if (perfect) attack += attackPerfect;
    return { attack, b2b: difficult, combo: nextCombo, difficult };
  }

  // ---------- 盤面の評価 ----------

  // TSD の穴：T を下向きに差し込むと2ライン消える形
  //   y-1段目：片側だけ屋根がある / y段目：3マス空きで他は埋まり / y+1段目：真ん中だけ空きで他は埋まり
  function countTSlots(b) {
    let count = 0;
    for (let y = buffer; y < rows - 1; y++) {
      for (let c = 1; c < cols - 1; c++) {
        const three = 7 << (c - 1);
        if ((b[y] & three) !== 0 || (b[y] | three) !== FULL) continue;
        if ((b[y + 1] >> c) & 1 || (b[y + 1] | (1 << c)) !== FULL) continue;
        const above = b[y - 1];
        const left = (above >> (c - 1)) & 1;
        const right = (above >> (c + 1)) & 1;
        if (left === right || (above >> c) & 1) continue;
        // 上から入れられるよう、真ん中の列の上がふさがっていないこと
        if ((b[y - 2] >> c) & 1) continue;
        count++;
      }
    }
    return count;
  }

  // REN特化で空ける4列の外側のうち、一番低い列の高さ
  function renSideMin(b) {
    let min = rows;
    for (let x = 0; x < cols; x++) {
      if (REN_WELL.includes(x)) continue;
      let top = rows;
      for (let y = 0; y < rows; y++) {
        if ((b[y] >> x) & 1) {
          top = y;
          break;
        }
      }
      min = Math.min(min, rows - top);
    }
    return min;
  }

  function evaluate(b, state, incoming) {
    const heights = [];
    let holes = 0;
    let covered = 0;
    for (let x = 0; x < cols; x++) {
      let top = rows;
      for (let y = 0; y < rows; y++) {
        if ((b[y] >> x) & 1) {
          top = y;
          break;
        }
      }
      heights.push(rows - top);
      let blocks = 0;
      for (let y = top; y < rows; y++) {
        if ((b[y] >> x) & 1) blocks++;
        else {
          holes++;
          covered += blocks;
        }
      }
    }

    const average = heights.reduce((a, h) => a + h, 0) / cols;
    const rawMax = Math.max(...heights);
    const maxHeight = rawMax + incoming;
    let value = 0;
    let bump = 0;

    if (w.renSide > 0) {
      // REN：真ん中4列の外側を高く平らに、4列の中はブロックを3つまでに
      for (let x = 0; x < cols - 1; x++) {
        if (REN_WELL.includes(x) || REN_WELL.includes(x + 1)) continue;
        bump += Math.abs(heights[x] - heights[x + 1]);
      }
      let wellFill = 0;
      for (let y = 0; y < rows; y++) for (const x of REN_WELL) if ((b[y] >> x) & 1) wellFill++;
      value += Math.min(renSideMin(b), 14) * w.renSide;
      value -= Math.max(0, wellFill - 3) * w.renWellFill;
    } else {
      // 一番低い列を井戸とみなす
      let wellX = 0;
      for (let x = 1; x < cols; x++) if (heights[x] < heights[wellX]) wellX = x;
      const neighbors = [heights[wellX - 1], heights[wellX + 1]].filter((h) => h !== undefined);
      const wellDepth = Math.max(0, Math.min(...neighbors) - heights[wellX]);
      for (let x = 0; x < cols - 1; x++) {
        if (x === wellX || x + 1 === wellX) continue;
        bump += Math.abs(heights[x] - heights[x + 1]);
      }
      value += Math.min(wellDepth, 4) * w.well;
    }

    value -= holes * w.hole + Math.min(covered, 30) * w.covered;
    value -= bump * w.bumpiness + average * w.height;
    value -= Math.max(0, maxHeight - w.dangerLine) * w.danger;
    value -= Math.max(0, rawMax - 4) * w.pcHigh;
    if (w.tSlot) value += Math.min(countTSlots(b), 2) * w.tSlot;
    if (state.b2b) value += w.b2b;
    return value;
  }

  // ---------- パフェの並べ方を探す ----------

  // 下から lines 段の中の空きマスのまとまりが、すべて4の倍数の大きさか（ミノは4マスなので、そうでないと埋まらない）
  function emptyRegionsFillable(b, lines) {
    const top = rows - lines;
    const seen = new Uint8Array(lines * cols);
    for (let y = top; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = (y - top) * cols + x;
        if (seen[i] || (b[y] >> x) & 1) continue;
        let size = 0;
        const stack = [[x, y]];
        seen[i] = 1;
        while (stack.length > 0) {
          const [cx, cy] = stack.pop();
          size++;
          for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
            if (nx < 0 || nx >= cols || ny < top || ny >= rows) continue;
            const j = (ny - top) * cols + nx;
            if (seen[j] || (b[ny] >> nx) & 1) continue;
            seen[j] = 1;
            stack.push([nx, ny]);
          }
        }
        if (size % 4 !== 0) return false;
      }
    }
    return true;
  }

  function filledCount(b) {
    let n = 0;
    for (let y = 0; y < rows; y++) for (let v = b[y]; v; v &= v - 1) n++;
    return n;
  }

  function stackHeight(b) {
    for (let y = 0; y < rows; y++) if (b[y]) return rows - y;
    return 0;
  }

  // そのまま置く / ホールドして置く、の候補（同じ種類と入れ替えても意味がないので除く）
  function pieceOptions(node, queue) {
    const options = [];
    if (node.ptr < queue.length) {
      options.push({ type: queue[node.ptr], useHold: false, hold: node.hold, nextPtr: node.ptr + 1 });
    }
    if (node.canHold && node.ptr < queue.length) {
      if (node.hold) {
        if (node.hold !== queue[node.ptr]) {
          options.push({ type: node.hold, useHold: true, hold: queue[node.ptr], nextPtr: node.ptr + 1 });
        }
      } else if (node.ptr + 1 < queue.length && queue[node.ptr + 1] !== queue[node.ptr]) {
        options.push({ type: queue[node.ptr + 1], useHold: true, hold: queue[node.ptr], nextPtr: node.ptr + 2 });
      }
    }
    return options;
  }

  // 今の NEXT とホールドだけで全消しできる並べ方を探す。見つかれば最初の1手、なければ null
  function findPerfectClear(request, queue) {
    const board = Uint32Array.from(request.board);
    const filled = filledCount(board);
    const height = stackHeight(board);
    const available = queue.length + (request.hold ? 1 : 0);
    let nodes = 0;
    const memo = new Set();

    function search(b, ptr, hold, canHold, lines, depth, first) {
      if (b.every((row) => row === 0)) return first;
      if (++nodes > PC_NODE_LIMIT) return null;
      const key = `${b.slice(rows - lines).join(",")}|${ptr}|${hold}|${canHold}`;
      if (memo.has(key)) return null;
      memo.add(key);
      for (const option of pieceOptions({ ptr, hold, canHold }, queue)) {
        const start = depth === 0 && !option.useHold ? { ...request.piece } : spawnPiece(option.type);
        for (const pl of placements(b, start)) {
          // 全消しする段（下から lines 段）の中にだけ置く
          if (CELLS[pl.piece.type][pl.piece.rot].some(([, dy]) => pl.piece.y + dy < rows - lines)) continue;
          const result = lock(b, pl.piece);
          if (!result) continue;
          const rest = lines - result.cleared;
          if (stackHeight(result.board) > rest || !emptyRegionsFillable(result.board, rest)) continue;
          const move = first ?? {
            hold: option.useHold,
            type: option.type,
            piece: pl.piece,
            path: pl.path,
            tspin: pl.tspin,
            cleared: result.cleared,
            perfectClear: true,
          };
          const found = search(result.board, option.nextPtr, option.hold, true, rest, depth + 1, move);
          if (found) return found;
        }
      }
      return null;
    }

    // 全消しする段数：今の高さ以上で、必要なミノの数が手持ちで足りるもの（少ない段から試す）
    for (let lines = Math.max(height, 1); lines <= 4; lines++) {
      const need = lines * cols - filled;
      if (need <= 0 || need % 4 !== 0 || need / 4 > available) continue;
      memo.clear();
      const found = search(board, 0, request.hold, request.canHold, lines, 0, null);
      if (found) return found;
      if (nodes > PC_NODE_LIMIT) break;
    }
    return null;
  }

  // ---------- 探索 ----------

  // request: { board（行ごとの数値の配列）, piece（今のミノの位置）, queue（NEXT の種類）, hold, canHold, b2b, combo, incoming,
  //            mode（"balance" / "ren" / "pc" / "dig"）, depth（何手先まで）, beamWidth（残す候補数）, noise（ぶれ） }
  function think(request) {
    const queue = [request.piece.type, ...request.queue];
    const incoming = request.incoming;
    // パフェ特化でも、ブロックの数が奇数のときは全消しできないのでバランスで積む。
    // ミノを置くと +4、ライン消去で -10 と偶奇は変わらないため、奇数段のおじゃまを受けるまでこのまま
    const mode = request.mode === "pc" && filledCount(request.board) % 2 === 1 ? "balance" : request.mode;
    w = { ...W, ...(MODE_WEIGHTS[mode] ?? {}) };
    const beamWidth = request.beamWidth ?? BEAM_WIDTH;
    const noise = request.noise ?? 0;

    // パフェ特化：全消しできる並べ方が見つかれば、その通りに置く
    if (mode === "pc") {
      const pc = findPerfectClear(request, queue);
      if (pc) return { found: true, ...pc };
    }
    const root = {
      board: Uint32Array.from(request.board),
      ptr: 0, // 次に使う queue の位置
      hold: request.hold,
      canHold: request.canHold,
      b2b: request.b2b,
      combo: request.combo,
      acc: 0,
      first: null,
    };
    const depthLimit = Math.max(1, Math.min(request.depth ?? MAX_DEPTH, queue.length - 1));

    let beam = [root];
    let best = null;
    for (let depth = 0; depth < depthLimit; depth++) {
      const children = [];
      for (const node of beam) {
        const renBuilt = w.renEarlyClear ? renSideMin(node.board) >= 8 : true;
        for (const option of pieceOptions(node, queue)) {
          // 最初の手だけは、今まさに落ちているミノの位置から探す
          const start = depth === 0 && !option.useHold ? { ...request.piece } : spawnPiece(option.type);
          for (const pl of placements(node.board, start)) {
            const result = lock(node.board, pl.piece);
            if (!result) continue;
            const nextType = queue[option.nextPtr];
            if (nextType && collides(result.board, nextType, spawnPiece(nextType).x, spawnPiece(nextType).y, 0)) continue; // ブロックアウト
            const atk = attackFor(result.cleared, pl.tspin, node.b2b, node.combo, result.perfect);
            let gained = atk.attack * w.attack;
            if (result.cleared > 0 && !atk.difficult && !result.perfect && atk.combo < 2) {
              gained -= result.cleared * w.waste;
            }
            if (w.comboStep) {
              // REN：続けるほど加点、途切れさせると減点、外側を積む前に消し始めるのも減点
              if (result.cleared > 0 && atk.combo >= 1) gained += w.comboStep * atk.combo;
              if (result.cleared === 0 && node.combo >= 1) gained -= w.comboBreak * node.combo;
              if (result.cleared > 0 && node.combo < 0 && !renBuilt) gained -= w.renEarlyClear;
            }
            children.push({
              board: result.board,
              ptr: option.nextPtr,
              hold: option.hold,
              canHold: true,
              b2b: atk.b2b,
              combo: atk.combo,
              acc: node.acc + gained * Math.pow(FUTURE_DISCOUNT, depth),
              first: node.first ?? {
                hold: option.useHold,
                type: option.type,
                piece: pl.piece,
                path: pl.path,
                tspin: pl.tspin,
                cleared: result.cleared,
                attack: atk.attack,
              },
            });
          }
        }
      }
      if (children.length === 0) break;
      children.forEach((c) => {
        c.total = c.acc + evaluate(c.board, c, depth === 0 ? incoming : 0);
        if (noise) c.total += (Math.random() - 0.5) * noise; // 弱いAIはわざとぶれさせる
      });
      children.sort((a, c) => c.total - a.total);
      beam = children.slice(0, beamWidth);
      best = beam[0];
    }
    if (!best) return { found: false };
    return { found: true, ...best.first };
  }

  // weights は調整用（テストから重みを書き換えられるように）
  return { think, placements, lock, attackFor, tSpinType, countTSlots, evaluate, findPerfectClear, weights: W };
}
