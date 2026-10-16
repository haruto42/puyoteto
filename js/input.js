const FRAME = 1000 / 60;
const DAS = 8 * FRAME; // 横キーを押しっぱなしにしてから連続移動が始まるまで
const ARR = 2 * FRAME; // 連続移動の間隔（0 にすると即座に壁まで）
const SOFT_DROP_INTERVAL = 2 * FRAME; // ソフトドロップ中の落下間隔

// 横移動とソフトドロップの押しっぱなし処理（テトリス・ぷよぷよ共通）
// target には move(dir) と softDrop(held) を持つモードを設定する。held は押しっぱなしによる連続入力か
const Input = {
  target: null,
  heldDirs: [], // 押されている方向（-1 / 1）。末尾が最新で、後から押した方向を優先する
  dasTimer: 0,
  arrTimer: 0,
  softDropHeld: false,
  softDropTimer: 0,

  clear() {
    this.heldDirs.length = 0;
    this.softDropHeld = false;
  },

  currentDir() {
    return this.heldDirs.length ? this.heldDirs[this.heldDirs.length - 1] : 0;
  },

  startDir(dir) {
    this.target.move(dir);
    this.dasTimer = 0;
    this.arrTimer = 0;
  },

  pressDir(dir) {
    if (this.heldDirs.includes(dir)) return;
    this.heldDirs.push(dir);
    this.startDir(dir);
  },

  releaseDir(dir) {
    if (!this.heldDirs.includes(dir)) return;
    const wasCurrent = this.currentDir() === dir;
    this.heldDirs.splice(this.heldDirs.indexOf(dir), 1);
    // 逆方向をまだ押していれば、そちらの移動をやり直す
    if (wasCurrent && this.currentDir()) this.startDir(this.currentDir());
  },

  pressSoftDrop() {
    this.softDropHeld = true;
    this.softDropTimer = 0;
    this.target.softDrop(false);
  },

  releaseSoftDrop() {
    this.softDropHeld = false;
  },

  update(dt) {
    const dir = this.currentDir();
    if (dir) {
      this.dasTimer += dt;
      if (this.dasTimer >= DAS) {
        if (ARR === 0) {
          while (this.target.move(dir)) {}
        } else {
          this.arrTimer += dt;
          while (this.arrTimer >= ARR) {
            this.arrTimer -= ARR;
            this.target.move(dir);
          }
        }
      }
    }

    if (this.softDropHeld) {
      this.softDropTimer += dt;
      while (this.softDropTimer >= SOFT_DROP_INTERVAL) {
        this.softDropTimer -= SOFT_DROP_INTERVAL;
        this.target.softDrop(true);
      }
    }
  },
};
