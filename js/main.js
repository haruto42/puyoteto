// メニュー・全体のゲームループ・キー入力の振り分け・画面の拡大縮小
const stageEl = document.getElementById("stage");
const menuEl = document.getElementById("menu");
const gameEl = document.getElementById("game");
const overlayEl = document.getElementById("overlay");
const pauseMenuEl = document.getElementById("pause-menu");
const resultMenuEl = document.getElementById("result-menu");
const soundStateEls = document.querySelectorAll(".sound-state");
const touchControlsEl = document.getElementById("touch-controls");
const touchPauseEl = document.getElementById("touch-pause");

// 画面ボタンは、タッチ操作の端末（?touch=1 を付けると PC でも試せる）で出す
const touchMode = window.matchMedia("(pointer: coarse)").matches || location.search.includes("touch=1");

const MAX_FRAME_TIME = 50; // 1フレームで進める時間の上限。画面が裏に回って止まっていた分を一気に進めない

let match = null; // null のときはメニュー画面
let lastFrame = performance.now();
let overlayTimer = null;

Sound.loadMuted();

const ui = {
  container: gameEl,
  center: document.getElementById("center-info"),

  // duration を指定するとその時間後に消える
  showOverlay(text, duration) {
    clearTimeout(overlayTimer);
    overlayEl.textContent = text;
    overlayEl.hidden = false;
    if (duration) overlayTimer = setTimeout(() => (overlayEl.hidden = true), duration);
  },

  hideOverlay() {
    clearTimeout(overlayTimer);
    overlayEl.hidden = true;
  },

  showResult(text) {
    this.hideOverlay();
    document.getElementById("result-text").textContent = text;
    resultMenuEl.hidden = false;
  },
};

// ウィンドウに収まるように画面全体を拡大縮小する（盤面の解像度はそのまま）
// 大きくしすぎると盤面がぼやけるので拡大は MAX_SCALE 倍まで
const MAX_SCALE = 1.5;

// 縦長の画面では、盤面を縦に並べるレイアウトにする（style.css の body.portrait）
function isPortrait() {
  return window.innerHeight > window.innerWidth;
}

// 画面ボタンは、人が操作している間だけ出す。操作する種類（テトリス/ぷよ）に合わせて一部を隠す
function updateTouchControls() {
  const show = touchMode && match !== null && match.human !== null && !gameEl.hidden;
  touchControlsEl.hidden = !show;
  touchPauseEl.hidden = !show;
  if (show) touchControlsEl.dataset.type = match.human.config.type;
}

function fitStage() {
  document.body.classList.toggle("portrait", isPortrait());
  updateTouchControls();
  // 縦画面では画面ボタンが下に出るので、その分を除いた高さに収める
  const reserved = isPortrait() && !touchControlsEl.hidden ? touchControlsEl.offsetHeight : 0;
  const scale = Math.min(
    window.innerWidth / stageEl.offsetWidth,
    (window.innerHeight - reserved) / stageEl.offsetHeight,
    MAX_SCALE
  );
  stageEl.style.transform = `translateX(-50%) scale(${scale})`;
}

function startMatch(configs, firstTo) {
  if (match) match.dispose();
  gameEl.innerHTML = "";
  Input.clear();
  match = new Match(configs, firstTo, ui);
  Input.target = match.human;
  menuEl.hidden = true;
  gameEl.hidden = false;
  pauseMenuEl.hidden = true;
  resultMenuEl.hidden = true;
  fitStage();
}

function startSolo(type) {
  startMatch([{ type, control: "human" }], 1);
}

function startVersus() {
  const value = (id) => document.getElementById(id).value;
  startMatch(
    [
      { type: value("p1-type"), control: value("p1-control"), level: value("p1-level"), mode: value("p1-mode") },
      { type: value("p2-type"), control: "ai", level: value("p2-level"), mode: value("p2-mode") },
    ],
    Number(value("first-to"))
  );
}

function backToMenu() {
  if (match) match.dispose();
  match = null;
  Input.clear();
  ui.hideOverlay();
  pauseMenuEl.hidden = true;
  resultMenuEl.hidden = true;
  gameEl.hidden = true;
  menuEl.hidden = false;
  fitStage();
}

function setPaused(paused) {
  if (!match || match.state === "matchOver") return;
  match.paused = paused;
  pauseMenuEl.hidden = !paused;
  Input.clear();
}

function restart() {
  pauseMenuEl.hidden = true;
  resultMenuEl.hidden = true;
  match.paused = false;
  Input.clear();
  match.restart();
}

function isPlaying() {
  return match && !match.paused && match.state === "playing";
}

function loop(time) {
  const dt = Math.min(time - lastFrame, MAX_FRAME_TIME);
  lastFrame = time;
  if (match) {
    if (isPlaying() && match.human) Input.update(dt);
    match.update(dt);
    match.draw();
  }
  soundStateEls.forEach((el) => (el.textContent = Sound.muted ? "OFF" : "ON"));
  requestAnimationFrame(loop);
}

// ---- 対戦メニュー ----
// AIのモードはテトリスのAIにだけあるので、それ以外のときは選べないようにする
function updateModeSelects() {
  const value = (id) => document.getElementById(id).value;
  document.getElementById("p1-mode").disabled = value("p1-type") !== "tetris" || value("p1-control") !== "ai";
  document.getElementById("p2-mode").disabled = value("p2-type") !== "tetris";
}
["p1-type", "p1-control", "p2-type"].forEach((id) => {
  document.getElementById(id).addEventListener("change", updateModeSelects);
});
updateModeSelects();

// ---- ボタン ----
document.querySelectorAll("[data-solo]").forEach((button) => {
  button.addEventListener("click", () => startSolo(button.dataset.solo));
});
document.getElementById("start-versus").addEventListener("click", startVersus);
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.action === "resume") setPaused(false);
    if (button.dataset.action === "restart") restart();
    if (button.dataset.action === "menu") backToMenu();
  });
});

// ---- 画面の状態 ----
window.addEventListener("resize", fitStage);
// フォーカスが外れると keyup が届かず押しっぱなし扱いになるため、すべて離したことにする
window.addEventListener("blur", () => Input.clear());
// 画面が裏に回ったら自動でポーズする
document.addEventListener("visibilitychange", () => {
  if (document.hidden && match && match.state !== "matchOver") setPaused(true);
});

// ---- キー入力 ----
document.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "ArrowLeft":
      Input.releaseDir(-1);
      break;
    case "ArrowRight":
      Input.releaseDir(1);
      break;
    case "ArrowDown":
      Input.releaseSoftDrop();
      break;
  }
});

document.addEventListener("keydown", (e) => {
  Sound.unlock();
  // OSのキーリピートは使わない（連続移動は DAS / ARR で自前で行う）
  if (e.repeat) {
    e.preventDefault();
    return;
  }

  if (e.code === "KeyM") {
    Sound.toggleMute();
    return;
  }

  if (!match) {
    if (e.code === "Digit1") startSolo("tetris");
    if (e.code === "Digit2") startSolo("puyo");
    if (e.code === "Digit3") startVersus();
    return;
  }

  // ポーズ中・結果画面
  if (match.paused || match.state === "matchOver") {
    if ((e.code === "Escape" || e.code === "KeyP") && match.paused) setPaused(false);
    if (e.code === "KeyR") restart();
    if (e.code === "KeyQ") backToMenu();
    e.preventDefault();
    return;
  }

  if (e.code === "Escape" || e.code === "KeyP") {
    setPaused(true);
    e.preventDefault();
    return;
  }

  if (pressGameKey(e.code)) e.preventDefault();
});

// ゲーム操作のキーを押したときの処理（キーボードと画面ボタン共通）。操作として使えたら true
// 人が操作していない（観戦）か、カウントダウン中・ポーズ中は受け付けない
function pressGameKey(code) {
  const human = match && match.human;
  if (!human || match.state !== "playing" || match.paused) return false;
  switch (code) {
    case "ArrowLeft":
      Input.pressDir(-1);
      return true;
    case "ArrowRight":
      Input.pressDir(1);
      return true;
    case "ArrowDown":
      Input.pressSoftDrop();
      return true;
    default:
      return human.onKey(code);
  }
}

// ---- 画面ボタン（スマホ） ----
// 指を離す・画面の外に出る・他の操作に取られる、のどれでも「離した」扱いにする
function bindTouchButton(button, onDown, onUp) {
  button.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId); // 指が外にずれても、離すまでこのボタンの操作として扱う
    } catch {
      // 取れなくても操作はできる
    }
    button.classList.add("active");
    Sound.unlock();
    onDown();
  });
  const release = () => {
    button.classList.remove("active");
    if (onUp) onUp();
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("contextmenu", (e) => e.preventDefault());
}

touchControlsEl.querySelectorAll("[data-key]").forEach((button) => {
  bindTouchButton(button, () => pressGameKey(button.dataset.key));
});
touchControlsEl.querySelectorAll("[data-dir]").forEach((button) => {
  const dir = Number(button.dataset.dir);
  bindTouchButton(
    button,
    () => pressGameKey(dir < 0 ? "ArrowLeft" : "ArrowRight"),
    () => Input.releaseDir(dir)
  );
});
touchControlsEl.querySelectorAll("[data-softdrop]").forEach((button) => {
  bindTouchButton(button, () => pressGameKey("ArrowDown"), () => Input.releaseSoftDrop());
});
bindTouchButton(touchPauseEl, () => setPaused(true));

// スマホのブラウザは、画面をタッチしないと音を鳴らせない
["pointerdown", "touchend", "click"].forEach((type) => document.addEventListener(type, () => Sound.unlock()));

fitStage();
requestAnimationFrame(loop);
