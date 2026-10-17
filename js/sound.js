// 効果音は音声ファイルを使わず Web Audio API でその場で合成する
// 全体にぷよテトのような明るくポップな音（サイン波・三角波を中心に、ベル・泡・キラキラ）にしている
const Sound = {
  ctx: null,
  volume: 0.3,
  muted: false,

  // ミュート設定はこのブラウザに保存し、次回も引き継ぐ（保存できない環境でも動くようにする）
  loadMuted() {
    try {
      this.muted = localStorage.getItem("muted") === "true";
    } catch {
      this.muted = false;
    }
  },

  toggleMute() {
    this.muted = !this.muted;
    try {
      localStorage.setItem("muted", String(this.muted));
    } catch {
      // 保存できなくても、今回のプレイ中はミュート状態が効く
    }
  },

  // ブラウザの制限で、ユーザーがキーを押すまで音を鳴らせないため、最初のキー入力で初期化する
  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
  },

  // 1音鳴らす。slideTo を指定すると音程を滑らかに変える
  // 音の頭にごく短い立ち上がりをつけて、プチッというノイズが出ないようにする
  tone({ freq, duration, type = "sine", volume = 1, delay = 0, slideTo = null }) {
    if (!this.ctx || this.muted) return;
    const start = this.ctx.currentTime + delay;
    const attack = Math.min(0.006, duration / 4);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(this.volume * volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(start);
    osc.stop(start + duration);
  },

  // ノイズ（風を切る音・ドスッという衝撃の「ざらつき」）。cutoff を上下に動かして「シュッ」と聞かせる
  noise({ duration, volume = 0.3, delay = 0, from = 2000, to = 2000 }) {
    if (!this.ctx || this.muted) return;
    const start = this.ctx.currentTime + delay;
    const length = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(this.volume * volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
    source.connect(filter).connect(gain).connect(this.ctx.destination);
    source.start(start);
  },

  // 鐘のような音：基本の音に、2倍の音（短い）と3倍の音（さらに短い）を重ねてキラッとさせる
  bell(freq, { delay = 0, duration = 0.35, volume = 0.5 } = {}) {
    this.tone({ freq, duration, type: "sine", volume, delay });
    this.tone({ freq: freq * 2, duration: duration * 0.6, type: "sine", volume: volume * 0.45, delay });
    this.tone({ freq: freq * 3, duration: duration * 0.3, type: "sine", volume: volume * 0.2, delay });
  },

  // 音を順番に鳴らす（notes は周波数の配列）。1音ごとに鐘の音
  arpeggio(notes, { interval = 0.06, duration = 0.2, volume = 0.5 } = {}) {
    notes.forEach((freq, i) => this.bell(freq, { delay: i * interval, duration, volume }));
  },

  // 同時に鳴らす和音
  chord(notes, { delay = 0, duration = 0.4, type = "triangle", volume = 0.3 } = {}) {
    notes.forEach((freq) => this.tone({ freq, duration, type, volume, delay }));
  },

  // 横移動：押しっぱなしだと連続で鳴るので、回転より小さく短くする
  move() {
    this.tone({ freq: 700, duration: 0.025, type: "sine", volume: 0.18 });
  },

  rotate() {
    this.tone({ freq: 900, duration: 0.05, type: "triangle", volume: 0.3, slideTo: 1300 });
  },

  hold() {
    this.tone({ freq: 500, duration: 0.1, type: "triangle", volume: 0.5, slideTo: 900 });
  },

  hardDrop() {
    this.tone({ freq: 200, duration: 0.14, type: "sine", volume: 1, slideTo: 55 });
    this.noise({ duration: 0.06, volume: 0.25, from: 3000, to: 400 });
  },

  lock() {
    this.tone({ freq: 260, duration: 0.05, type: "sine", volume: 0.5, slideTo: 180 });
  },

  // ライン消しの音。通常消し・テトリス・Tスピンで音の感じを変える
  // 返り値は鳴らし終わるまでの秒数（Back-to-Back の音をその後に重ねるため）
  clear(clear) {
    // ド・ミ・ソ・ド・ミ…（長調）
    const C5 = 523, E5 = 659, G5 = 784, C6 = 1047, E6 = 1319, G6 = 1568, C7 = 2093;
    let end;
    if (clear.perfectClear) {
      // 全消し：上までキラキラと駆け上がって、和音で締める
      this.arpeggio([C5, E5, G5, C6, E6, G6, C7, E6, C7], { interval: 0.065, duration: 0.3, volume: 0.45 });
      this.chord([C6, E6, G6, C7], { delay: 0.6, duration: 0.8, type: "sine", volume: 0.25 });
      end = 0.9;
    } else if (clear.tSpin) {
      end = this.tSpinClear(clear);
    } else if (clear.cleared === 4) {
      // テトリス：どんと低い音のあと、明るく駆け上がって和音を長く伸ばす
      this.tone({ freq: 140, duration: 0.3, type: "sine", volume: 0.9, slideTo: 60 });
      this.arpeggio([C5, E5, G5, C6, E6], { interval: 0.05, duration: 0.3, volume: 0.5 });
      this.chord([C6, E6, G6], { delay: 0.25, duration: 0.7, type: "sine", volume: 0.25 });
      this.chord([C7], { delay: 0.25, duration: 0.5, type: "sine", volume: 0.1 });
      end = 0.6;
    } else {
      // シングル〜トリプル：ぴこ・ぴこ・ぴこと、ライン数ぶん音が上がっていく
      const notes = [G5, C6, E6].slice(0, clear.cleared);
      this.arpeggio(notes, { interval: 0.07, duration: 0.25, volume: 0.45 });
      end = notes.length * 0.07;
    }
    if (clear.backToBack) this.bell(G6, { delay: end, duration: 0.4, volume: 0.35 });
  },

  // Tスピン：回転っぽく音程が上がる「シュイン」のあと、ライン数に応じて鐘の和音
  // 返り値は鳴らし終わるまでの秒数
  tSpinClear(clear) {
    // ミニやライン消しなしは「シュイン」を小さく・低めにして区別する
    const small = clear.tSpin === "mini" || clear.cleared === 0;
    this.tone({ freq: 300, duration: 0.18, type: "triangle", volume: small ? 0.25 : 0.45, slideTo: small ? 800 : 1500 });
    this.noise({ duration: 0.18, volume: small ? 0.08 : 0.16, from: 800, to: 6000 });
    if (clear.cleared === 0) return 0.18;
    const A5 = 880, D6 = 1175, Fs6 = 1480, A6 = 1760;
    const chords = [[A5], [A5, D6], [A5, D6, Fs6]].slice(0, clear.cleared);
    chords.forEach((notes, i) => {
      notes.forEach((freq) => this.bell(freq, { delay: 0.18 + i * 0.09, duration: 0.3, volume: 0.3 }));
    });
    const end = 0.18 + chords.length * 0.09;
    if (clear.cleared === 3) {
      // トリプルは最後を高く伸ばして特別感を出す
      this.chord([A5, D6, Fs6, A6], { delay: end, duration: 0.7, type: "sine", volume: 0.25 });
      return end + 0.35;
    }
    return end;
  },

  // ぷよの消える音：泡がはじけるような「ぽよん」
  pop(freq, volume = 0.5) {
    this.tone({ freq: freq * 0.6, duration: 0.09, type: "sine", volume, slideTo: freq * 1.5 });
  },

  // ぷよの連鎖：連鎖数が上がるほど高く、音数を増やし、大きく・長くする（12連鎖で頭打ち）
  // 音階は長調（ド・レ・ミ・ファ・ソ・ラ・シ・ド…）で1連鎖ごとに1段上がる
  chain(count) {
    const step = Math.min(count, 12) - 1;
    const scale = [0, 2, 4, 5, 7, 9, 11];
    const semitones = scale[step % 7] + 12 * Math.floor(step / 7);
    const base = 523 * Math.pow(2, semitones / 12);
    const volume = Math.min(0.5 + step * 0.04, 0.85);
    this.pop(base, volume * 0.8);
    this.bell(base, { delay: 0.02, duration: 0.3 + step * 0.03, volume });
    // 3連鎖以上：3度と5度を足して和音にする
    if (count >= 3) this.chord([base * 1.25, base * 1.5], { delay: 0.04, duration: 0.3 + step * 0.03, type: "triangle", volume: 0.14 });
    // 5連鎖以上：オクターブ上の鐘を足す
    if (count >= 5) this.bell(base * 2, { delay: 0.08, duration: 0.35, volume: 0.35 });
    // 6連鎖以上：低音を足して重みを出す
    if (count >= 6) this.tone({ freq: base / 4, duration: 0.5, type: "sine", volume: 0.5 });
    // 8連鎖以上：高い音でキラキラさせる
    if (count >= 8) {
      [2, 2.5, 3, 4].forEach((r, i) => this.bell(base * r, { delay: 0.12 + i * 0.05, duration: 0.25, volume: 0.25 }));
    }
    // 10連鎖以上：風を切る音を足す
    if (count >= 10) this.noise({ duration: 0.5, volume: 0.15, from: 500, to: 7000 });
  },

  // 全消し：キラキラした音
  allClear() {
    this.arpeggio([1047, 1319, 1568, 2093, 1568, 2093, 2637], { interval: 0.07, duration: 0.3, volume: 0.35 });
  },

  // おじゃまが降ってきた・せり上がった。count が多いほど低く重くする
  garbage(count = 1) {
    const heavy = Math.min(count, 12) / 12; // 0〜1
    this.tone({ freq: 160 - heavy * 50, duration: 0.2 + heavy * 0.2, type: "sine", volume: 0.7 + heavy * 0.3, slideTo: 45 });
    this.noise({ duration: 0.12 + heavy * 0.15, volume: 0.15 + heavy * 0.2, from: 1800, to: 200 });
    this.tone({ freq: 100, duration: 0.15, type: "triangle", volume: 0.25, delay: 0.05, slideTo: 60 });
  },

  // 大きな予告が来たときの警告：高低2つの音を速く交互に鳴らす
  alert() {
    [880, 1175, 880, 1175, 880, 1175].forEach((freq, i) => {
      this.tone({ freq, duration: 0.1, type: "square", volume: 0.22, delay: i * 0.12 });
      this.tone({ freq, duration: 0.1, type: "sine", volume: 0.3, delay: i * 0.12 });
    });
  },

  // カウントダウン（GO のときは高い音）
  countdown(isGo) {
    if (isGo) {
      this.bell(1047, { duration: 0.5, volume: 0.5 });
      this.bell(1568, { delay: 0.08, duration: 0.5, volume: 0.35 });
    } else {
      this.bell(523, { duration: 0.2, volume: 0.45 });
    }
  },

  win() {
    this.arpeggio([523, 659, 784, 1047, 1319], { interval: 0.1, duration: 0.4, volume: 0.45 });
  },

  gameOver() {
    this.arpeggio([392, 330, 262, 196], { interval: 0.15, duration: 0.35, volume: 0.45 });
  },
};
