// Word Ladder — single-page app. Screens: name, home, setup, invite/join, game, result.

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const state = {
  me: null,
  game: null,        // view of the open game, from the server
  entry: "",         // letters typed for the next rung
  hintPos: null,
  feedback: null,    // { text, kind: ok | bad | meh }
  again: null,       // { code, by } when the friend started a new ladder
  setup: null,
  installPrompt: null,
};

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const up = (s) => esc(s).toUpperCase();

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(typeof data.detail === "string" ? data.detail : "Something went wrong. Try again.");
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MODES = {
  solo: { title: "Solo game", button: "Start game", cls: " solo", block: "solo", letter: "S",
    label: "Solo", blurb: "Your own pace. No clock, no pressure." },
  team: { title: "Team up with a friend", button: "Create invite", cls: " blue", block: "team", letter: "T",
    label: "Team", blurb: "Take turns adding words and win together." },
  race: { title: "Challenge a friend", button: "Create challenge", cls: " race", block: "compete", letter: "C",
    label: "Compete", blurb: "Same puzzle on both phones. Fewest steps wins." },
};

// The mode's colour block at the top of a screen.
function hero(mode, inner) {
  const m = MODES[mode];
  return `<section class="hero ${m.block}" data-l="${m.letter}">${inner}</section>`;
}
const starText = (n) => "★".repeat(n || 0) + "☆".repeat(3 - (n || 0));
const inviteUrl = (code) => `${location.origin}/j/${code}`;

// prev: the rung above, so the changed letter gets the player's colour.
// target: the end word, so letters already in the right place turn green.
function tiles(word, { prev = null, seat = null, target = null, cls = "" } = {}) {
  const letters = [...word].map((ch, i) => {
    const changed = prev && prev[i] !== ch && seat;
    const hit = target && target[i] === ch;
    return `<span class="t${changed ? ` s${seat}` : ""}${hit ? " hit" : ""}">${esc(ch)}</span>`;
  });
  return `<div class="tiles ${cls}">${letters.join("")}</div>`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Link copied");
  } catch {
    toast(text);
  }
}

// ---------- notifications ----------

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

// unsupported | install-first (iPhone outside the home-screen app) | default | granted | denied
function pushStatus() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS && !isStandalone() ? "install-first" : "unsupported";
  }
  return Notification.permission;
}

function keyBytes(b64) {
  const raw = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Once permission is granted, makes sure this device is subscribed and linked to the current player.
async function syncPush() {
  const status = pushStatus();
  if (status !== "granted") return status;
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api("/api/push/key");
  let sub = await reg.pushManager.getSubscription();
  const subKey = sub?.options?.applicationServerKey;
  if (sub && subKey && btoa(String.fromCharCode(...new Uint8Array(subKey))) !== btoa(String.fromCharCode(...keyBytes(key)))) {
    await sub.unsubscribe();  // the server's key changed
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
  return "granted";
}

// Notifications are always on. Browsers only allow the permission popup from a tap,
// so the first tap anywhere in the app asks; after that the device stays subscribed.
let askedForPush = false;
function askForPushOnce() {
  if (askedForPush || pushStatus() !== "default") return;
  askedForPush = true;
  // Called synchronously inside the tap; Safari ignores the request after an await.
  Notification.requestPermission()
    .then((result) => result === "granted" && state.me && syncPush())
    .catch(() => {});
}

// iPhone only allows notifications for apps added to the Home Screen.
function installHint() {
  if (pushStatus() !== "install-first") return "";
  return `<div class="banner"><span class="small"><b>Add Word Ladder to your Home Screen</b> to get turn notifications: tap the Share button, then <b>Add to Home Screen</b>, and play from there.</span></div>`;
}

// ---------- routing ----------

function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route();
}
window.addEventListener("popstate", route);

async function route() {
  closeSocket();
  stopClock();
  if (location.pathname !== "/tutorial") state.tutorial = null;
  const path = location.pathname;
  const gameMatch = path.match(/^\/(g|j)\/([A-Za-z0-9]+)/);

  if (path === "/leaderboard") {  // also readable before entering a name
    if (!state.me) state.me = await api("/api/me").catch(() => null);
    return renderLeaderboard();
  }
  if (path === "/tutorial") return renderTutorial();
  if (path === "/help") {  // readable before entering a name
    if (!state.me) state.me = await api("/api/me").catch(() => null);
    return renderHelp();
  }

  if (!state.me) {
    try {
      state.me = await api("/api/me");
      if (!state.me.needs_username) syncPush().catch(() => {});
    } catch (e) {
      if (e.status !== 401) return renderError(e.message);
      let invite = null;
      if (gameMatch) invite = await api(`/api/invites/${gameMatch[2]}`).catch(() => null);
      return renderAuth({ invite });
    }
  }
  window.scrollTo(0, 0);
  if (state.me.needs_username) return renderUsername();
  if (location.search.includes("signin=")) history.replaceState(null, "", path);
  if (path === "/account") return renderAccount();
  if (path === "/new") {
    const mode = new URLSearchParams(location.search).get("mode");
    return renderSetup(MODES[mode] ? mode : "solo");
  }
  if (gameMatch) return openGame(gameMatch[2].toUpperCase());
  return renderHome();
}

function renderError(message) {
  app.innerHTML = `
    <main class="screen center">
      <h2>${esc(message)}</h2>
      <a class="btn ghost" href="/" data-link>Go to my games</a>
    </main>`;
}

// ---------- name ----------

// ---------- sign in / username / account ----------

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-10l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

const SIGNIN_ERRORS = {
  cancelled: "Sign-in was cancelled. Tap the button to try again.",
  expired: "That sign-in took too long. Please try again.",
  failed: "Google sign-in didn't work. Please try again.",
};

function renderAuth({ invite = null } = {}) {
  const problem = SIGNIN_ERRORS[new URLSearchParams(location.search).get("signin")];
  const intro = invite?.open
    ? invite.mode === "race"
      ? `<p><b>${esc(invite.host)}</b> challenged you to a ${invite.length}-letter word ladder. Fewest steps wins.</p>`
      : `<p><b>${esc(invite.host)}</b> invited you to climb a ${invite.length}-letter word ladder together.</p>`
    : invite
      ? `<p class="muted">That game already has two players.</p>`
      : `<p class="muted">Change one letter at a time.</p>`;
  const next = encodeURIComponent(location.pathname === "/" ? "/" : location.pathname);
  app.innerHTML = `
    <main class="screen center">
      <h1 class="logo-big">${brand(true)}</h1>
      ${intro}
      ${problem ? `<p class="form-error" role="alert">${problem}</p>` : ""}
      <a class="btn google" href="/auth/google/login?next=${next}">${GOOGLE_G}<span>Continue with Google</span></a>
      <p class="muted small" style="margin:0">Your games follow you to any phone or browser. We never show your
        email to other players. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
    </main>`;
}

function renderUsername() {
  app.innerHTML = `
    <main class="screen center">
      <h1 class="logo-big">${brand(true)}</h1>
      <h2>Pick a username</h2>
      <p class="muted" style="margin:0">This is what your friends and the leaderboard will see. Your Google name and email stay private.</p>
      <form class="stack" data-form="username">
        <label class="label" for="username">Username</label>
        <input class="input" id="username" name="username" maxlength="20" required autocomplete="nickname"
          autocapitalize="none" spellcheck="false" value="${esc(state.me.suggestion ?? "")}">
        <p class="small muted" style="margin:0">3–20 letters or numbers. You can use _ . -</p>
        <p class="form-error" id="username-error" role="alert"></p>
        <button class="btn daily" type="submit">Continue</button>
      </form>
    </main>`;
  const input = app.querySelector("#username");
  input.focus();
  input.select();
}

function renderAccount() {
  const m = state.me;
  app.innerHTML = `
    <main class="screen">
      <div class="top"><a class="icon-btn" href="/" data-link aria-label="Back">←</a><h2>Account</h2><span style="width:24px"></span></div>
      <section class="card stack" style="flex-direction:row;align-items:center;gap:14px">
        <span class="avatar big" aria-hidden="true">${esc([...m.name][0]?.toUpperCase() ?? "?")}</span>
        <span style="min-width:0"><span class="label">Username</span><br><b style="font:800 1.3rem var(--display)">${esc(m.name)}</b>
          <br><span class="small muted" style="overflow-wrap:anywhere">${GOOGLE_G} ${esc(m.email ?? "Google account")}</span></span>
      </section>
      <p class="small muted" style="margin:0">Only you can see your email. Sign in with the same Google account on any device to continue your games.</p>
      <button class="btn ghost" data-action="logout">Log out</button>
      <div style="margin-top:auto" class="stack">
        <button class="btn ghost danger-text" data-action="delete-account">Delete my account</button>
        <p class="small muted" style="margin:0;text-align:center"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
      </div>
    </main>`;
}

// ---------- home ----------

async function renderHome() {
  app.innerHTML = `<main class="screen"><div class="top">${brand()}</div></main>`;
  let games = { active: [], finished: [] };
  try {
    [games, state.daily] = await Promise.all([api("/api/games"), api("/api/daily")]);
  } catch (e) {
    toast(e.message);
  }
  // One calm row per game; the only colour is the pill on games that need you.
  const row = (g) => {
    const who = g.mode === "solo" ? "Solo" : g.partner ? esc(g.partner) : "Invite sent";
    const letter = { solo: "S", team: "T", race: "C" }[g.mode];
    let right = "";
    if (g.mode === "race" && g.status === "finished") {
      right = `<span class="st res">${{ won: "Won", lost: "Lost", tie: "Tie" }[g.outcome] ?? "No winner"}</span>`;
    } else if (g.status === "won") right = `<span class="st res stars" aria-label="${g.stars} stars">${starText(g.stars)}</span>`;
    else if (g.status === "gave_up") right = `<span class="st res">Gave up</span>`;
    else if (g.my_turn) right = `<span class="st go">${g.mode === "solo" ? "Continue" : g.mode === "race" ? "Your go" : "Your turn"}</span>`;
    return `
      <a class="gm" href="/g/${g.code}" data-link>
        <span class="mb" aria-hidden="true">${letter}</span>
        <span class="nm">${who} <small>· ${up(g.start)} → ${up(g.end)}</small></span>
        ${right}
      </a>`;
  };
  const install = !isStandalone() && state.installPrompt
    ? `<div class="banner"><span><b>Install Word Ladder</b><br><span class="small">Open it from your home screen like an app.</span></span><button class="btn blue" data-action="install">Install</button></div>`
    : "";

  app.innerHTML = `
    <main class="screen">
      <div class="top">
        ${brand()}
        <span class="top-actions">
          <a class="trophy" href="/leaderboard" data-link aria-label="Leaderboard" title="Leaderboard">🏆</a>
          <a class="avatar" href="/account" data-link aria-label="Your account (${esc(state.me.name)})">${esc([...state.me.name][0]?.toUpperCase() ?? "?")}</a>
        </span>
      </div>
      <section class="modes-grid" aria-label="Ways to play">
        ${dailyCard()}
        <a class="blk solo" data-l="S" href="/new?mode=solo" data-link>
          <span class="lab"></span><b>Solo</b><span>Your own pace, no clock</span><span class="go">Start →</span>
        </a>
        <a class="blk team" data-l="T" href="/new?mode=team" data-link>
          <span class="lab"></span><b>Team</b><span>Take turns, win together</span><span class="go">Invite →</span>
        </a>
        <a class="blk compete" data-l="C" href="/new?mode=race" data-link>
          <span class="lab"></span><b>Compete</b><span>Same puzzle, fewest steps</span><span class="go">Challenge →</span>
        </a>
      </section>
      <a class="howrow" href="${tutorialSeen() ? "/help" : "/tutorial"}" data-link><span>New here? <b>How to play</b></span><span aria-hidden="true">→</span></a>
      <form class="row" data-form="join-code">
        <input class="input code-input" id="join-code" name="code" aria-label="Game code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" style="flex:2">
        <button class="btn ghost" type="submit">Join</button>
      </form>
      ${install}
      ${installHint()}
      <section class="stack">
        <div class="row" style="align-items:baseline"><span class="label">Your games</span>
          ${games.active.length ? `<span class="small muted" style="text-align:right">${games.active.length} active</span>` : ""}</div>
        ${games.active.length ? `<div class="games">${games.active.map(row).join("")}</div>`
          : `<p class="small muted" style="margin:0">No games in progress. Pick a way to play above.</p>`}
      </section>
      ${games.finished.length ? `
      <section class="stack">
        <span class="label">Finished</span>
        <div class="games">${games.finished.map(row).join("")}</div>
      </section>` : ""}
    </main>`;
}

// ---------- setup ----------

const EXAMPLES = { 4: ["cold", "warm"], 5: ["stone", "money"], 6: ["winter", "summer"] };

function renderSetup(mode) {
  state.setup = {
    mode, length: 5, difficulty: "easy", source: "suggest",
    start: "", end: "", par: null, error: null, checking: false,
  };
  drawSetup();
  suggest();
}

function drawSetup() {
  const s = state.setup;
  const seg = (name, values, current, labels = values) => `
    <div class="seg" role="group" aria-label="${name}">
      ${values.map((v, i) => `<button type="button" data-action="setup" data-key="${name}" data-value="${v}" aria-pressed="${v === current}">${labels[i]}</button>`).join("")}
    </div>`;
  const [exStart, exEnd] = EXAMPLES[s.length];
  const words = s.source === "suggest"
    ? `
      <div class="field"><span class="label">Difficulty</span>${seg("difficulty", ["easy", "medium", "hard"], s.difficulty, ["Easy", "Medium", "Hard"])}</div>
      <div class="card stack picked" aria-live="polite">
        <div class="picked-words">
          <div class="field"><span class="label">Start</span><div id="pick-start">${s.start ? tiles(s.start, { target: s.end }) : ""}</div></div>
          <div class="field"><span class="label">End</span><div id="pick-end">${s.end ? tiles(s.end, { cls: "end" }) : ""}</div></div>
        </div>
        <div class="row" style="align-items:center">
          <span id="puzzle-status" class="badge"></span>
          <button type="button" class="btn quiet" data-action="suggest" style="flex:0 0 auto">Other words</button>
        </div>
      </div>`
    : `
      <div class="field">
        <label class="label" for="start">Start word</label>
        <input class="input word-input" id="start" name="start" maxlength="${s.length}" value="${esc(s.start)}"
          placeholder="Type a word, e.g. ${exStart}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="next">
      </div>
      <div class="field">
        <label class="label" for="end">End word</label>
        <input class="input word-input" id="end" name="end" maxlength="${s.length}" value="${esc(s.end)}"
          placeholder="Type a word, e.g. ${exEnd}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done">
      </div>
      <p class="muted small" style="margin:0">Any two real ${s.length}-letter words. We'll check there's a ladder between them.</p>
      <span id="puzzle-status" class="badge"></span>`;

  app.innerHTML = `
    <main class="screen">
      <div class="top"><a class="icon-btn" href="/" data-link aria-label="Back">←</a></div>
      ${hero(s.mode, `<span class="lab">${MODES[s.mode].label}</span><h2>${MODES[s.mode].title}</h2><p>${MODES[s.mode].blurb}</p>`)}
      <div class="field"><span class="label">Letters</span>${seg("length", [4, 5, 6], s.length)}</div>
      <div class="field"><span class="label">Words</span>${seg("source", ["suggest", "own"], s.source, ["Suggest words", "My own words"])}</div>
      <form class="stack" data-form="setup">
        ${words}
        <button class="btn${MODES[s.mode].cls}" id="setup-go" type="submit" style="margin-top:8px">
          ${MODES[s.mode].button}
        </button>
      </form>
    </main>`;
  drawSetupStatus();
}

function drawSetupStatus() {
  const s = state.setup;
  const el = document.getElementById("puzzle-status");
  const goBtn = document.getElementById("setup-go");
  if (!el) return;
  if (s.checking) { el.className = "badge"; el.textContent = s.source === "suggest" ? "Finding words…" : "Checking…"; }
  else if (s.error) { el.className = "badge bad"; el.textContent = s.error; }
  else if (s.par) { el.className = "badge ok"; el.textContent = `✓ Can be done in ${s.par} steps`; }
  else { el.className = "badge"; el.textContent = ""; }
  goBtn.disabled = !s.par || s.checking;
}

async function suggest() {
  const s = state.setup;
  s.checking = true; s.error = null;
  drawSetupStatus();
  try {
    const p = await api(`/api/suggest?length=${s.length}&difficulty=${s.difficulty}`);
    Object.assign(s, { start: p.start, end: p.end, par: p.par, checking: false });
    document.getElementById("pick-start").innerHTML = tiles(p.start, { target: p.end });
    document.getElementById("pick-end").innerHTML = tiles(p.end, { cls: "end" });
  } catch (e) {
    Object.assign(s, { checking: false, error: e.message });
  }
  drawSetupStatus();
}

let checkTimer;
function onSetupInput() {
  const s = state.setup;
  s.start = document.getElementById("start").value.trim().toLowerCase();
  s.end = document.getElementById("end").value.trim().toLowerCase();
  s.par = null; s.error = null;
  clearTimeout(checkTimer);
  if (s.start.length !== s.length || s.end.length !== s.length) {
    s.error = s.start && s.end ? `Both words need ${s.length} letters.` : null;
    return drawSetupStatus();
  }
  s.checking = true;
  drawSetupStatus();
  checkTimer = setTimeout(async () => {
    try {
      const r = await api("/api/puzzles/check", { method: "POST", body: { length: s.length, start: s.start, end: s.end } });
      s.par = r.par;
    } catch (e) {
      s.error = e.message;
    }
    s.checking = false;
    drawSetupStatus();
  }, 350);
}

async function startGame() {
  const s = state.setup;
  const btn = document.getElementById("setup-go");
  btn.disabled = true;
  try {
    const g = await api("/api/games", {
      method: "POST",
      body: {
        mode: s.mode, length: s.length, start: s.start, end: s.end,
        difficulty: s.source === "suggest" ? s.difficulty : null,
      },
    });
    go(`/g/${g.code}`, { replace: true });
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

// ---------- game ----------

let socket = null, socketCode = null, pingTimer = null, retryTimer = null, retryDelay = 1000;

function closeSocket() {
  socketCode = null;
  clearInterval(pingTimer);
  clearTimeout(retryTimer);
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
}

// The server only skips a notification when the game is actually on screen.
function sendVisibility() {
  if (socket?.readyState === 1) socket.send(document.hidden ? "hidden" : "visible");
}

function openSocket(code) {
  if (socketCode === code && socket) return;
  closeSocket();
  socketCode = code;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws/games/${code}`);
  socket.onopen = () => {
    retryDelay = 1000;
    sendVisibility();
    pingTimer = setInterval(() => socket?.readyState === 1 && socket.send("ping"), 25000);
  };
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state" && msg.game.code === state.game?.code) applyState(msg.game);
    if (msg.type === "again") {
      state.again = msg;
      if (state.game && ["won", "gave_up", "finished"].includes(state.game.status)) drawGame();
      else toast(`${msg.by} started a new ${state.game?.mode === "race" ? "challenge" : "ladder"}`);
    }
  };
  socket.onclose = () => {
    clearInterval(pingTimer);
    socket = null;
    if (socketCode !== code) return;
    retryTimer = setTimeout(() => { socketCode = null; openSocket(code); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
}

async function openGame(code) {
  state.entry = ""; state.hintPos = null; state.hint = null; state.feedback = null; state.again = null;
  app.innerHTML = `<main class="screen center"><p class="muted pulse" style="text-align:center">Loading…</p></main>`;
  try {
    state.game = await api(`/api/games/${code}`);
  } catch (e) {
    return renderError(e.message);
  }
  if (location.pathname.startsWith("/j/") && state.game.my_seat) history.replaceState(null, "", `/g/${code}`);
  drawGame();
  if (state.game.my_seat && ["team", "race"].includes(state.game.mode)) openSocket(code);
}

function applyState(g) {
  const old = state.game;
  state.game = g;
  if (old && g.mode === "race") {
    const partner = g.players.find((p) => !p.me);
    const was = old.race?.seats.find((x) => x.seat !== g.my_seat);
    const now = g.race?.seats.find((x) => x.seat !== g.my_seat);
    if (old.status === "waiting" && g.status === "active") toast(`${partner?.name ?? "Your friend"} accepted!`);
    else if (now?.finished && !was?.finished) toast(`${partner?.name} finished in ${now.steps} steps`);
    else if (now?.gave_up && !was?.gave_up) toast(`${partner?.name} gave up`);
  } else if (old) {
    const partner = g.players.find((p) => !p.me);
    if (g.ladder.length > old.ladder.length) {
      const last = g.ladder[g.ladder.length - 1];
      if (last.seat !== g.my_seat) {
        state.feedback = { text: `${partner?.name ?? "Your friend"} played ${last.word.toUpperCase()}`, kind: "meh" };
        state.hintPos = null;
        state.hint = null;
      }
    } else if (g.ladder.length < old.ladder.length && !g.my_turn) {
      state.feedback = { text: `${partner?.name ?? "Your friend"} stepped back one rung`, kind: "meh" };
    }
    if (old.status === "waiting" && g.status === "active") toast(`${partner?.name ?? "Your friend"} joined!`);
    if (!old.my_turn && g.my_turn && document.hidden) document.title = "Your turn · Word Ladder";
  }
  drawGame();
}

document.addEventListener("visibilitychange", () => {
  sendVisibility();
  if (document.hidden) return;
  document.title = "Word Ladder";
  // Phones drop sockets while asleep; resync when the app comes back.
  if (state.game && location.pathname.startsWith("/g/")) {
    api(`/api/games/${state.game.code}`).then(applyState).catch(() => {});
    if (["team", "race"].includes(state.game.mode) && state.game.my_seat && !socket) openSocket(state.game.code);
  }
});

function drawGame() {
  const g = state.game;
  if (!g) return;
  stopClock();
  if (!g.my_seat) return drawJoin(g);
  if (g.status === "waiting") return drawInvite(g);
  if (g.mode === "daily") return g.status === "finished" ? drawDailyResult(g) : drawDaily(g);
  if (g.mode === "race") return g.status === "finished" ? drawRaceResult(g) : drawRace(g);
  if (g.status === "won" || g.status === "gave_up") return drawResult(g);
  drawPlay(g);
}

function drawJoin(g) {
  const host = g.players[0]?.name ?? "A friend";
  const race = g.mode === "race";
  app.innerHTML = `
    <main class="screen center">
      ${hero(g.mode, `
        <span class="lab">${MODES[g.mode].label} · ${g.length} letters</span>
        <h1 style="font-size:1.9rem">${esc(host)} ${race ? "challenged you" : "invited you"}</h1>
        <p>${race ? "You both solve the same puzzle on your own ladder. Fewest steps wins; a tie goes to the faster time."
          : "Take turns adding one word each, and reach the end word together."}</p>`)}
      <div class="card stack" style="align-items:center">
        ${tiles(g.start, { target: g.end, cls: "small" })}
        <span class="muted small">to</span>
        ${tiles(g.end, { cls: "small end" })}
      </div>
      <button class="btn${MODES[g.mode].cls}" data-action="join">${race ? "Accept the challenge" : `Join ${esc(host)}'s game`}</button>
      <a class="linkish" href="/tutorial?then=${encodeURIComponent(`/g/${g.code}`)}" data-link style="align-self:center">New to word ladders? 20-second tutorial</a>
    </main>`;
}

function drawInvite(g) {
  const url = inviteUrl(g.code);
  app.innerHTML = `
    <main class="screen">
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
        <span class="label">${g.length} letters · ${esc(g.difficulty ?? "your words")}</span>
      </div>
      ${hero(g.mode, `
        <div class="stack" style="align-items:center;text-align:center;gap:10px;padding-block:6px">
          <span class="lab">Game code</span>
          <div class="tiles code-tiles">${[...g.code].map((c) => `<span class="t">${esc(c)}</span>`).join("")}</div>
          <p style="max-width:none">Send this to a friend. They tap it, sign in with Google and join.</p>
        </div>`)}
      <div class="link-box"><code>${esc(url)}</code><button class="btn quiet" data-action="copy-invite" style="min-height:36px">Copy</button></div>
      ${navigator.share ? `<button class="btn${MODES[g.mode].cls}" data-action="share-invite">Share link</button>` : ""}
      <div class="card stack" style="align-items:center">
        <span class="label">${g.mode === "race" ? "The puzzle" : "Your ladder"}</span>
        ${tiles(g.start, { target: g.end, cls: "small" })}
        <span class="muted small">par ${g.par}</span>
        ${tiles(g.end, { cls: "small end" })}
      </div>
      ${installHint()}
      <button class="linkish" data-action="give-up" style="align-self:center;margin-top:auto">Cancel this game</button>
    </main>`;
}

function drawPlay(g) {
  const partner = g.players.find((p) => !p.me);
  const team = g.mode === "team";
  const turnName = g.players.find((p) => p.seat === g.turn_seat)?.name;

  const who = g.players.map((p) => `
    <div class="who s${p.seat}${g.status === "active" && p.seat === g.turn_seat && team ? " turn" : ""}">
      ${team ? `<span class="dot${p.online || p.me ? " on" : ""}" aria-label="${p.online || p.me ? "online" : "away"}"></span>` : ""}
      <span class="name">${p.me ? "You" : esc(p.name)}</span>
    </div>`).join("");

  const { rungs, toGo } = ladderRungs(g);

  const bottom = g.my_turn
    ? `
      <div class="tools">
        ${hintButton(g)}
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>Undo</button>
        <button data-action="give-up" class="danger">Give up</button>
      </div>
      ${keyboard()}`
    : `
      <div class="waiting card">
        <h2 style="color:var(--p${g.turn_seat})">${esc(turnName)}'s turn</h2>
        <p class="muted small" style="margin:0">${partner?.online
          ? "They have the game open. Their word will appear here."
          : `They're away right now. Their word will show up here when they play. Last move ${ago(g.updated_at)}.`}</p>
        ${partner?.online ? "" : `<button class="btn quiet" data-action="copy-invite">Copy game link to remind them</button>`}
        <a class="linkish" href="/" data-link>Back to my games</a>
      </div>`;

  app.innerHTML = `
    <main class="game">
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back to my games">←</a>
        ${team ? `<div class="team" style="flex:1">${who}</div>`
          : `<h2 style="font-size:1.2rem">Solo</h2><span class="label">${g.length} letters</span>`}
      </div>
      <div class="progress"><span>Step ${g.steps_used}</span><span>Par ${g.par}</span><span>${toGo}</span></div>
      <div class="ladder" id="ladder">${rungs.join("")}</div>
      ${feedbackLine(g)}
      ${bottom}
    </main>`;
  drawEntry();
  scrollToEntry();
}

function hintButton(g) {
  if (state.hint && state.hint.from === g.current && !state.hint.shown) {
    return `<button data-action="hint" class="hint-on">Show word</button>`;
  }
  const cost = g.hints_cost ? ` <span class="muted">+1 step</span>` : "";
  return `<button data-action="hint" ${g.hints_left ? "" : "disabled"}>Hint · ${g.hints_left}${cost}</button>`;
}

// The message line under the ladder. Before the first word it explains what to do.
function feedbackLine(g) {
  const f = state.feedback ?? (g.my_turn && !g.ladder.length
    ? { text: `Change one letter of ${g.current.toUpperCase()} to make a new word`, kind: "tip" } : null);
  return `<div class="feedback ${f?.kind ?? ""}" id="feedback">${esc(f?.text ?? "")}</div>`;
}

function ladderRungs(g) {
  let prev = g.start;
  const rungs = [tiles(g.start, { target: g.end })];
  g.ladder.forEach((m, i) => {
    rungs.push(tiles(m.word, { prev, seat: m.seat, target: g.end, cls: i === g.ladder.length - 1 ? "rung-new" : "" }));
    prev = m.word;
  });
  const toGo = g.distance === null || g.distance < 0 ? "no way through" : `${g.distance} to go`;
  if (g.current === g.end && g.ladder.length) {  // reached the end: show it as the last rung
    rungs[rungs.length - 1] = tiles(g.end, { cls: "end" });
    return { rungs, toGo };
  }
  if (g.my_turn) rungs.push(`<div id="entry"></div>`);
  rungs.push(`<div class="gap">· · · ${toGo} · · ·</div>`);
  rungs.push(tiles(g.end, { cls: "end" }));
  return { rungs, toGo };
}

function scrollToEntry() {
  const ladderEl = document.getElementById("ladder");
  const target = document.getElementById("entry") ?? ladderEl?.lastElementChild?.previousElementSibling;
  target?.scrollIntoView({ block: "center" });
}

// ---------- race ----------

let clockTimer = null;
function stopClock() { clearInterval(clockTimer); clockTimer = null; }

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function startClock(iso) {
  const started = new Date(iso).getTime();
  const tick = () => {
    const el = document.getElementById("clock");
    if (el) el.textContent = fmtTime(Date.now() - started);
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function raceStatus(x) {
  if (x.gave_up) return "Gave up";
  if (x.finished) return `Done · ${x.steps} steps · ${fmtTime(x.time_ms)}`;
  if (x.started) return `Racing · ${x.steps} step${x.steps === 1 ? "" : "s"}`;
  return "Not started";
}

function drawRace(g) {
  const mine = g.race.seats.find((x) => x.seat === g.my_seat);
  const them = g.race.seats.find((x) => x.seat !== g.my_seat);
  const partner = g.players.find((p) => !p.me);
  const cards = g.players.map((p) => {
    const x = g.race.seats.find((r) => r.seat === p.seat);
    return `
      <div class="who s${p.seat}">
        <span class="dot${p.online || p.me ? " on" : ""}" aria-label="${p.online || p.me ? "online" : "away"}"></span>
        <span class="stackish"><span class="name">${p.me ? "You" : esc(p.name)}</span><span class="small muted">${raceStatus(x)}</span></span>
      </div>`;
  }).join("");
  const top = `
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back to my games">←</a>
        <div class="team" style="flex:1">${cards}</div>
      </div>`;

  if (!mine.started) {
    app.innerHTML = `
      <main class="screen">
        ${top}
        <div class="card stack" style="align-items:center;text-align:center;margin-block:auto">
          <span class="label">Compete · par ${g.par}</span>
          ${tiles(g.start, { target: g.end })}
          <span class="muted">to</span>
          ${tiles(g.end, { cls: "end" })}
          <p class="muted small" style="margin:0">Fewest steps wins; a tie goes to the faster time.
            Your clock starts when you tap Start. Hints are allowed, but each adds a step.</p>
          <button class="btn race" data-action="race-start" style="width:100%">Start</button>
        </div>
      </main>`;
    return;
  }

  if (!g.my_turn) {  // finished or gave up, waiting for the other player
    const { rungs } = ladderRungs(g);
    app.innerHTML = `
      <main class="game">
        ${top}
        <div class="ladder" id="ladder">${rungs.join("")}</div>
        <div class="waiting card">
          <h2>${mine.gave_up ? "You gave up" : `Done in ${mine.steps} steps · ${fmtTime(mine.time_ms)}`}</h2>
          <p class="muted small" style="margin:0">Waiting for ${esc(partner?.name)} to finish (${raceStatus(them).toLowerCase()}).
            We'll show both ladders when they're done.</p>
          <a class="linkish" href="/" data-link>Back to my games</a>
        </div>
      </main>`;
    return;
  }

  const { rungs, toGo } = ladderRungs(g);
  app.innerHTML = `
    <main class="game">
      ${top}
      <div class="progress"><span>Step ${g.steps_used}</span><span>Par ${g.par}</span><span>⏱ <span id="clock">0:00</span></span><span>${toGo}</span></div>
      <div class="ladder" id="ladder">${rungs.join("")}</div>
      ${feedbackLine(g)}
      <div class="tools">
        ${hintButton(g)}
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>Undo</button>
        <button data-action="give-up" class="danger">Give up</button>
      </div>
      ${keyboard()}
    </main>`;
  drawEntry();
  scrollToEntry();
  startClock(mine.started_at);
}

function drawRaceResult(g) {
  const partner = g.players.find((p) => !p.me);
  const outcome = g.race.outcome;
  const title = { won: "You win", lost: `${esc(partner?.name)} wins`, tie: "It's a tie" }[outcome] ?? "No winner";
  const ordered = [...g.race.seats].sort((a, b) => (a.seat === g.my_seat ? -1 : b.seat === g.my_seat ? 1 : 0));
  const nameOf = (x) => (x.seat === g.my_seat ? "You" : esc(partner?.name));
  const ladderOf = (x) => {
    let prev = g.start;
    const out = [tiles(g.start, { target: g.end, cls: "small" })];
    for (const w of x.ladder ?? []) {
      out.push(w === g.end ? tiles(w, { cls: "small end" }) : tiles(w, { prev, seat: x.seat, target: g.end, cls: "small" }));
      prev = w;
    }
    return out.join("");
  };
  app.innerHTML = `
    <main class="screen">
      ${state.again ? `
        <div class="banner"><span><b>${esc(state.again.by)}</b> challenged you to a rematch.</span>
          <a class="btn race" href="/g/${esc(state.again.code)}" data-link style="flex:0 0 auto">Open</a></div>` : ""}
      ${hero("race", `
        <span class="lab">Compete · ${up(g.start)} → ${up(g.end)} · par ${g.par}</span>
        <h1 style="font-size:1.8rem">${title}</h1>
        <div class="stats">
          ${ordered.map((x) => `
            <div class="${x.seat === g.race.winner_seat ? "winner" : ""}">
              <span class="small">${nameOf(x)}${x.seat === g.race.winner_seat ? " · winner" : ""}</span>
              <b>${x.gave_up ? "Gave up" : `${x.steps} steps`}</b>
              <span class="small">${x.gave_up ? `after ${x.steps} steps` : `${fmtTime(x.time_ms)} · ${starText(x.stars)}`}</span>
            </div>`).join("")}
        </div>`)}
      <div class="race-ladders">
        ${ordered.map((x) => `
          <div class="card stack"><span class="label">${nameOf(x)}</span><div class="mini-ladder">${ladderOf(x)}</div></div>`).join("")}
      </div>
      <details class="card">
        <summary><b>Shortest possible ladder</b> <span class="muted">(${g.par} steps)</span></summary>
        <div class="mini-ladder" style="margin-top:12px">
          ${(g.solution ?? []).map((w, i, a) => tiles(w, { target: g.end, cls: i === a.length - 1 ? "small end" : "small" })).join("")}
        </div>
      </details>
      <div class="row" style="margin-top:auto">
        <a class="btn ghost" href="/" data-link>Home</a>
        <button class="btn race" data-action="again">Rematch ${esc(partner?.name ?? "")}</button>
      </div>
    </main>`;
}

// ---------- daily ladder ----------

const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function brand(big = false) {
  return `<span class="brand${big ? " big" : ""}" aria-label="Word Ladder">
    <span class="brand-tiles" aria-hidden="true"><i>W</i><i class="hit">O</i><i>R</i><i>D</i></span>
    <span class="brand-word" aria-hidden="true">Ladder</span></span>`;
}

// The Daily block in the home grid; what it says depends on whether you've played today.
function dailyCard() {
  const d = state.daily;
  const nextIn = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)}h` : `${Math.max(1, Math.round(sec / 60))}m`);
  if (!d) return `<div class="blk daily" data-l="D"><span class="lab"></span><b>Daily</b><span>Unavailable right now</span></div>`;
  const m = d.mine;
  if (m?.status === "finished" && !m.gave_up) {
    return `
      <a class="blk daily" data-l="D" href="/g/${m.code}" data-link>
        <span class="lab">Done · next in ${nextIn(d.resets_in)}</span><b>Daily #${m.rank}</b>
        <span>${m.steps} steps · ${fmtTime(m.time_ms)} · ${starText(m.stars)}</span><span class="go">See result →</span>
      </a>`;
  }
  if (m?.gave_up) {
    return `
      <a class="blk daily" data-l="D" href="/leaderboard" data-link>
        <span class="lab">Next in ${nextIn(d.resets_in)}</span><b>Daily</b><span>You gave up today</span><span class="go">Leaderboard →</span>
      </a>`;
  }
  if (m?.started) {
    return `
      <a class="blk daily" data-l="D" href="/g/${m.code}" data-link>
        <span class="lab">${d.length} letters</span><b>Daily</b><span>In progress · ${m.steps} step${m.steps === 1 ? "" : "s"}</span><span class="go">Continue →</span>
      </a>`;
  }
  return `
    <button class="blk daily" data-l="D" data-action="daily-play">
      <span class="lab">${d.length} letters${d.streak > 1 ? ` · ${d.streak}-day streak` : ""}</span><b>Daily</b>
      <span>Today's puzzle for everyone</span><span class="go">Play →</span>
    </button>`;
}

function dailyTop(g) {
  return `
    <div class="top">
      <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
      <h2 style="font-size:1.2rem">Daily ladder</h2>
      <span class="label">${g.length} letters · ${fmtDay(g.daily_date)}</span>
    </div>`;
}

function drawDaily(g) {
  const mine = g.race.seats[0];
  if (!mine.started) {
    const hidden = `<div class="tiles">${"<span class=\"t\">?</span>".repeat(g.length)}</div>`;
    app.innerHTML = `
      <main class="screen">
        ${dailyTop(g)}
        <div class="card stack" style="align-items:center;text-align:center;margin-block:auto">
          <span class="label">Today's ${g.length}-letter ladder · par ${g.par}</span>
          ${hidden}
          <span class="muted">to</span>
          ${hidden.replace(/class="t"/g, 'class="t end"')}
          <p class="muted small" style="margin:0">Everyone gets the same puzzle today, and you get <b>one try</b>.
            The words appear when you tap Start, and your clock starts then too.
            Fewest steps wins; ties go to the faster time. Each hint adds a step.</p>
          <button class="btn daily" data-action="race-start" style="width:100%">Start</button>
        </div>
      </main>`;
    return;
  }
  const { rungs, toGo } = ladderRungs(g);
  app.innerHTML = `
    <main class="game">
      ${dailyTop(g)}
      <div class="progress"><span>Step ${g.steps_used}</span><span>Par ${g.par}</span><span>⏱ <span id="clock">0:00</span></span><span>${toGo}</span></div>
      <div class="ladder" id="ladder">${rungs.join("")}</div>
      ${feedbackLine(g)}
      <div class="tools">
        ${hintButton(g)}
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>Undo</button>
        <button data-action="give-up" class="danger">Give up</button>
      </div>
      ${keyboard()}
    </main>`;
  drawEntry();
  scrollToEntry();
  startClock(mine.started_at);
}

function shareText(g) {
  const me = g.race.seats[0];
  const words = [g.start, ...(me.ladder ?? [])];
  const grid = words.map((w) => [...w].map((ch, i) => (ch === g.end[i] ? "🟩" : "⬜")).join("")).join("\n");
  const result = me.gave_up ? `Gave up after ${me.steps} steps` : `${me.steps} steps (par ${g.par}) · ${fmtTime(me.time_ms)} ${starText(me.stars)}`;
  return `Word Ladder · Daily ${fmtDay(g.daily_date)} · ${g.length} letters\n${result}\n${grid}\n${location.origin}`;
}

async function drawDailyResult(g) {
  const me = g.race.seats[0];
  const won = !me.gave_up;
  let prev = g.start;
  const played = [tiles(g.start, { target: g.end, cls: "small" })];
  for (const w of me.ladder ?? []) {
    played.push(w === g.end ? tiles(w, { cls: "small end" }) : tiles(w, { prev, seat: 1, target: g.end, cls: "small" }));
    prev = w;
  }
  app.innerHTML = `
    <main class="screen">
      ${dailyTop(g)}
      <section class="hero daily" data-l="D">
        <span class="lab">Daily ladder</span>
        ${won ? `<span class="big" id="daily-rank">${me.steps <= g.par ? "Perfect!" : "Solved!"}</span>` : `<span class="big">Not today</span>`}
        <p>${won ? `${me.steps} steps · ${fmtTime(me.time_ms)} · par ${g.par} · <span class="hero-stars">${starText(me.stars)}</span>` : `Stopped after ${me.steps} steps`}</p>
      </section>
      <div class="row">
        <button class="btn daily" data-action="daily-share">Share result</button>
        <a class="btn ghost" href="/leaderboard" data-link>🏆 Leaderboard</a>
      </div>
      <div class="card stack">
        <span class="label">Your ladder</span>
        <div class="mini-ladder">${played.join("")}</div>
      </div>
      <details class="card">
        <summary><b>Shortest possible ladder</b> <span class="muted">(${g.par} steps)</span></summary>
        <div class="mini-ladder" style="margin-top:12px">
          ${(g.solution ?? []).map((w, i, a) => tiles(w, { target: g.end, cls: i === a.length - 1 ? "small end" : "small" })).join("")}
        </div>
      </details>
      <a class="btn ghost" href="/" data-link style="margin-top:auto">Home</a>
    </main>`;
  try {
    const board = await api("/api/leaderboard/today");
    const ranked = board.rows.filter((r) => !r.gave_up).length;
    const el = document.getElementById("daily-rank");
    if (el && board.me?.rank) el.innerHTML = `#${board.me.rank} <span style="font-size:1rem;font-weight:700;opacity:.85">of ${ranked} today</span>`;
  } catch { /* the rank line is optional */ }
}

// ---------- leaderboard ----------

async function renderLeaderboard() {
  state.lb = state.lb ?? { tab: "today" };
  const { tab } = state.lb;
  const tabs = [["today", "Today"], ["week", "This week"], ["friends", "Friends"]].map(([v, label]) =>
    `<button type="button" data-action="lb-tab" data-value="${v}" aria-pressed="${v === tab}">${label}</button>`).join("");
  app.innerHTML = `
    <main class="screen">
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
        <h2>Leaderboard</h2>
        <span style="width:24px"></span>
      </div>
      <div class="seg" role="tablist" aria-label="Leaderboard">${tabs}</div>
      <div id="board"><p class="muted pulse" style="text-align:center">Loading…</p></div>
    </main>`;
  const el = document.getElementById("board");
  const medal = (r) => (r ? `<span class="rank-n${r <= 3 ? ` top${r}` : ""}">${r}</span>` : "—");
  const you = (r) => (r.me ? "<b>You</b>" : esc(r.name));
  // Top 50, plus your own row underneath if you're further down.
  const pinned = (rows, me, cols) => {
    const top = rows.slice(0, 50);
    const below = me && !top.some((r) => r.me);
    return { top, extra: below ? `<tr class="gap-row"><td colspan="${cols}">⋯</td></tr>` : "", meRow: below ? me : null };
  };
  try {
    if (tab === "today") {
      const b = await api("/api/leaderboard/today");
      const { top, extra, meRow } = pinned(b.rows, b.me, 5);
      const row = (r) => `
        <tr class="${r.me ? "me" : ""}">
          <td class="rank">${r.gave_up ? "—" : medal(r.rank)}</td><td class="name">${you(r)}</td>
          ${r.gave_up ? `<td colspan="3" class="muted">Gave up</td>`
            : `<td class="num">${r.steps}</td><td class="num">${fmtTime(r.time_ms)}</td><td class="stars">${starText(r.stars)}</td>`}
        </tr>`;
      el.innerHTML = `
        <p class="small muted board-head">Daily ladder · ${fmtDay(b.date)} · ${b.length} letters · par ${b.par} · ${b.played} played</p>
        ${state.me && !b.me ? `<div class="banner"><span>You haven't played today's ladder yet.</span><button class="btn daily" data-action="daily-play" style="flex:0 0 auto">Play</button></div>` : ""}
        ${b.rows.length ? `
        <div class="board-wrap"><table class="board">
          <thead><tr><th>#</th><th>Player</th><th class="num">Steps</th><th class="num">Time</th><th></th></tr></thead>
          <tbody>${top.map(row).join("")}${extra}${meRow ? row(meRow) : ""}</tbody>
        </table></div>` : `<p class="empty card">Nobody has finished today's ladder yet. Be the first!</p>`}
        <p class="small muted">Ranked by fewest steps, then fastest time. One try per player per day.</p>`;
    } else if (tab === "week") {
      const b = await api("/api/leaderboard/week");
      const { top, extra, meRow } = pinned(b.rows, b.me, 4);
      const row = (r) => `
        <tr class="${r.me ? "me" : ""}">
          <td class="rank">${medal(r.rank)}</td><td class="name">${you(r)}</td>
          <td class="num">${r.days}/${b.days_so_far}</td><td class="num"><span class="stars">★</span> ${r.stars}</td>
        </tr>`;
      el.innerHTML = `
        <p class="small muted board-head">${fmtDay(b.from)} – ${fmtDay(b.to)} · daily ladders</p>
        ${b.rows.length ? `
        <div class="board-wrap"><table class="board">
          <thead><tr><th>#</th><th>Player</th><th class="num">Days</th><th class="num">Stars</th></tr></thead>
          <tbody>${top.map(row).join("")}${extra}${meRow ? row(meRow) : ""}</tbody>
        </table></div>` : `<p class="empty card">No daily ladders finished this week yet.</p>`}
        <p class="small muted">Stars from every daily ladder since Monday. Ties go to the lower total time. Resets every Monday.</p>`;
    } else {
      if (!state.me) { el.innerHTML = `<p class="empty card">Enter your name on the home screen to see your friends.</p>`; return; }
      const b = await api("/api/leaderboard/friends");
      el.innerHTML = b.rows.length ? `
        <div class="board-wrap"><table class="board">
          <thead><tr><th>Friend</th><th class="num">Won–Lost</th><th class="num">Team games</th><th class="num">Avg ★</th></tr></thead>
          <tbody>${b.rows.map((r) => `
            <tr><td class="name">${esc(r.name)}</td>
              <td class="num">${r.won}–${r.lost}${r.tied ? ` (${r.tied} tie${r.tied === 1 ? "" : "s"})` : ""}</td>
              <td class="num">${r.team_games}</td><td class="num">${r.avg_stars ?? "—"}</td></tr>`).join("")}
          </tbody>
        </table></div>
        <p class="small muted">Your record against each friend in Compete games, and how your Team games went.</p>`
        : `<p class="empty card">Play a Team or Compete game with a friend and they'll show up here.</p>`;
    }
  } catch (e) {
    el.innerHTML = `<p class="empty card">${esc(e.message)}</p>`;
  }
}

// ---------- tutorial ----------
// A tiny ladder (COLD → WORD, par 2) with tips that appear as you play. Runs in the browser only;
// moves are checked against the dictionary through /api/puzzles/check.

const TUTORIAL = { start: "cold", end: "word", par: 2 };

function tutorialSeen() {
  try { return localStorage.getItem("wl-tutorial") === "done"; } catch { return false; }
}

function finishTutorial() {
  try { localStorage.setItem("wl-tutorial", "done"); } catch { /* shows again next time; harmless */ }
  const then = new URLSearchParams(location.search).get("then");
  state.tutorial = null;
  state.game = null;
  go(then && then.startsWith("/") ? then : "/", { replace: true });
}

function renderTutorial() {
  state.tutorial = { words: [TUTORIAL.start], misses: 0, dist: TUTORIAL.par };
  state.entry = "";
  state.hintPos = null;
  state.feedback = null;
  drawTutorial();
}

function tutorialGame() {
  const t = state.tutorial;
  const words = t.words;
  const current = words[words.length - 1];
  return {
    length: 4, my_turn: current !== TUTORIAL.end, my_seat: 1, current, start: TUTORIAL.start, end: TUTORIAL.end,
    ladder: words.slice(1).map((w) => ({ word: w, seat: 1 })), distance: t.dist,
  };
}

function drawTutorial() {
  const t = state.tutorial;
  const g = (state.game = tutorialGame());
  const steps = t.words.length - 1;
  let tip;
  if (g.current === TUTORIAL.end) {
    tip = `<b>You did it in ${steps} steps! ${steps <= TUTORIAL.par ? "★★★" : "★★"}</b><br>
      <b>Par</b> is the fewest steps possible. Finish in par for three stars.
      That's all there is to it. Now try a real one, on your own, with a friend, or the daily ladder.`;
  } else if (steps === 0) {
    tip = `<b>Turn COLD into WORD.</b> Change <b>one letter</b> at a time, and every step must be a real word.<br>
      Try it: change the <b>L</b> to an <b>R</b> and press Enter.`;
  } else {
    tip = `<b>Nice!</b> The <b class="tip-hit">green</b> tiles are letters already in the right place for WORD.
      The outlined tile is the one you changed.<br>${t.dist === 1
        ? "One more change to reach <b>WORD</b>."
        : `Keep going: WORD is ${t.dist} changes away.`}`;
  }
  const done = g.current === TUTORIAL.end;
  const { rungs } = ladderRungs({ ...g, ladder: g.ladder, my_turn: !done });
  app.innerHTML = `
    <main class="game">
      <div class="top">
        <h2>Quick tutorial</h2>
        ${done ? "" : `<button class="linkish" data-action="tutorial-skip">Skip</button>`}
      </div>
      <div class="coach" role="status">${tip}</div>
      <div class="ladder" id="ladder">${rungs.join("")}</div>
      ${feedbackLine(g)}
      ${done ? `<button class="btn daily" data-action="tutorial-skip">Start playing</button>` : keyboard()}
    </main>`;
  drawEntry();
  scrollToEntry();
}

async function tutorialSubmit() {
  const t = state.tutorial;
  const here = t.words[t.words.length - 1];
  const word = state.entry;
  const miss = (text) => {
    t.misses += 1;
    // After two misses on the main path, point at the letter to change.
    const step = { cold: "cord", cord: "word" }[here];
    if (t.misses >= 2 && step) state.hintPos = [...here].findIndex((ch, i) => ch !== step[i]);
    setFeedback(t.misses >= 2 && step ? `${text} Try ${step.toUpperCase()}.` : text, "bad");
    shake();
    drawEntry();
  };
  if (word.length !== 4) return miss("Type a 4-letter word.");
  const changed = [...word].filter((ch, i) => ch !== here[i]).length;
  if (changed !== 1) return miss(changed ? `Change only one letter. That changed ${changed}.` : "Change one letter.");
  if (t.words.includes(word)) return miss(`${word.toUpperCase()} is already on the ladder.`);
  let dist = 0;
  if (word !== TUTORIAL.end) {
    try {  // checks it's a real word, and how far it is from WORD
      dist = (await api("/api/puzzles/check", { method: "POST", body: { length: 4, start: word, end: TUTORIAL.end } })).par;
    } catch (e) {
      return miss(e.message.includes("dictionary") ? `${word.toUpperCase()} isn't a word we know.`
        : `${word.toUpperCase()} is a dead end: there's no way from it to WORD.`);
    }
  }
  t.dist = dist;
  t.words.push(word);
  t.misses = 0;
  state.entry = "";
  state.hintPos = null;
  const closer = dist < (t.prevDist ?? TUTORIAL.par);
  t.prevDist = dist;
  state.feedback = word === TUTORIAL.end ? null
    : { text: closer ? "One step closer!" : "That works, but it's not closer to WORD.", kind: closer ? "ok" : "meh" };
  drawTutorial();
}

// ---------- how to play ----------

function pushCheckText() {
  return {
    granted: "Notifications are on for this device.",
    default: "Not set up on this device yet. The test below will ask for permission.",
    denied: "Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.",
    "install-first": "On iPhone, notifications only work after you add Word Ladder to your Home Screen (Share → Add to Home Screen) and open it from there.",
    unsupported: "This browser can't show notifications. Try Chrome, or Safari on an iPhone with the app added to the Home Screen.",
  }[pushStatus()];
}

function renderHelp() {
  const ex = ["cold", "cord", "card", "ward", "warm"];
  let prev = null;
  const example = ex.map((w, i) => {
    const t = i === ex.length - 1 ? tiles(w, { cls: "small end" }) : tiles(w, { prev, seat: 1, target: "warm", cls: "small" });
    prev = w;
    return t;
  }).join("");
  const canTest = ["granted", "default"].includes(pushStatus());
  app.innerHTML = `
    <main class="screen help">
      <div class="top">
        <a class="icon-btn" href="${state.me ? "/" : "/"}" data-link aria-label="Back">←</a>
        <h2>How to play</h2>
        <span style="width:24px"></span>
      </div>
      <a class="btn daily" href="/tutorial" data-link>Play the 20-second tutorial</a>
      <section class="help-example card">
        <div class="mini-ladder">${example}</div>
        <p class="small muted" style="margin:0">COLD becomes WARM in 4 steps, changing one letter each time.</p>
      </section>
      <section class="stack">
        <h3>The rules</h3>
        <ul class="rules">
          <li>Start at the top word. Change <b>exactly one letter</b> to make a new, real word.</li>
          <li>Keep going until you reach the <b>end word</b> at the bottom.</li>
          <li>You can't use the same word twice in one ladder.</li>
          <li>Letters keep their place. You can't add, remove or swap letters around.</li>
        </ul>
      </section>
      <section class="stack">
        <h3>Reading the tiles</h3>
        <div class="legend">
          <span class="t hit">A</span><span>Right letter in the right place for the end word.</span>
          <span class="t s1">R</span><span>The letter that was just changed. Orange is you (or player 1), blue is your friend.</span>
          <span class="t end">M</span><span>The end word you're climbing to.</span>
        </div>
      </section>
      <section class="stack">
        <h3>Scoring</h3>
        <ul class="rules">
          <li><b>Par</b> is the fewest steps the puzzle can be solved in.</li>
          <li>Finish in par for ★★★, 1–2 extra steps for ★★, more for ★.</li>
          <li><b>Hint</b> shows which letter to change and what to change it to; tap again to fill in the word. You get 3 hints for 4-letter words, 4 for 5 and 5 for 6. In Compete and the daily, each hint adds a step.</li>
          <li><b>Undo</b> takes back the last word, but that step still counts.</li>
          <li>Stuck with "no way through"? That word is a dead end. Undo and try another.</li>
        </ul>
      </section>
      <section class="stack">
        <h3>Ways to play</h3>
        <div class="modes-help">
          <div><b>Solo</b><span>Just you and the puzzle.</span></div>
          <div><b>Team</b><span>You and a friend take turns adding one word each to the same ladder, and win together. You get a notification when it's your turn.</span></div>
          <div><b>Daily ladder</b><span>One puzzle a day, the same for everyone. Its length (4, 5 or 6 letters) changes from day to day. You get one try, the words appear when you tap Start, and you're ranked on the leaderboard by fewest steps, then time. Play every day to keep your streak.</span></div>
          <div><b>Compete</b><span>You both get the same puzzle and climb your own ladders. Fewest steps wins; if tied, the faster time wins. Your clock starts when you tap Start, and you can't see your friend's words until you're both done. Hints cost a step.</span></div>
        </div>
      </section>
      <section class="stack">
        <h3>Notifications</h3>
        <p class="small" style="margin:0" id="push-state">${pushCheckText()}</p>
        ${canTest && state.me ? `<button class="btn quiet" data-action="push-test">Send me a test notification</button>` : ""}
        <p class="small muted" style="margin:0" id="push-result"></p>
      </section>
      <a class="btn ghost" href="/" data-link>Back to the game</a>
    </main>`;
}

function drawEntry() {
  const el = document.getElementById("entry");
  const g = state.game;
  if (!el || !g) return;
  const cells = [];
  for (let i = 0; i < g.length; i++) {
    const ch = state.entry[i];
    const hint = state.hintPos === i ? " hint" : "";
    cells.push(ch
      ? `<span class="t filled${hint}">${esc(ch)}</span>`
      : `<span class="t${hint}"><span class="ghost">${esc(g.current[i])}</span></span>`);
  }
  el.className = `tiles entry s${g.my_seat}`;
  el.setAttribute("aria-label", `Your word: ${state.entry || "empty"}`);
  el.innerHTML = cells.join("");
}

function keyboard() {
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const key = (k) => `<button type="button" data-key="${k}" aria-label="${k}">${k.toUpperCase()}</button>`;
  return `
    <div class="kb">
      <div>${[...rows[0]].map(key).join("")}</div>
      <div>${[...rows[1]].map(key).join("")}</div>
      <div><button type="button" class="wide" data-key="back" aria-label="Delete">⌫</button>${[...rows[2]].map(key).join("")}<button type="button" class="wide enter" data-key="enter">ENTER</button></div>
    </div>`;
}

function setFeedback(text, kind) {
  state.feedback = { text, kind };
  const el = document.getElementById("feedback");
  if (el) { el.className = `feedback ${kind}`; el.textContent = text; }
}

function pressKey(k) {
  const g = state.game;
  if (!g?.my_turn) return;
  if (k === "enter") return submitWord();
  if (k === "back") state.entry = state.entry.slice(0, -1);
  else if (/^[a-z]$/.test(k) && state.entry.length < g.length) state.entry += k;
  drawEntry();
}

let submitting = false;
async function submitWord() {
  const g = state.game;
  if (submitting) return;
  if (state.tutorial) {
    submitting = true;
    try { await tutorialSubmit(); } finally { submitting = false; }
    return;
  }
  if (state.entry.length !== g.length) {
    setFeedback(`Type a ${g.length}-letter word.`, "bad");
    return shake();
  }
  submitting = true;
  const before = g.distance;
  try {
    const next = await api(`/api/games/${g.code}/moves`, { method: "POST", body: { word: state.entry } });
    state.entry = ""; state.hintPos = null; state.hint = null;
    if (next.status === "won" || next.distance === 0) state.feedback = null;
    else if (next.distance < 0 || next.distance === null) state.feedback = { text: "Dead end: no way to the end from here. Try Undo.", kind: "bad" };
    else if (next.distance < before) state.feedback = { text: "One step closer!", kind: "ok" };
    else if (next.distance === before) state.feedback = { text: "Same distance as before", kind: "meh" };
    else state.feedback = { text: "That took you further away", kind: "meh" };
    state.game = next;
    drawGame();
    navigator.vibrate?.(15);
  } catch (e) {
    setFeedback(e.message, "bad");
    shake();
  } finally {
    submitting = false;
  }
}

function shake() {
  const el = document.getElementById("entry");
  if (!el) return;
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
  navigator.vibrate?.([30, 40, 30]);
}

function drawResult(g) {
  const won = g.status === "won";
  const team = g.mode === "team";
  const partner = g.players.find((p) => !p.me);
  let prev = g.start;
  const played = [tiles(g.start, { target: g.end, cls: "small" })];
  for (const m of g.ladder) { played.push(tiles(m.word, { prev, seat: m.seat, target: g.end, cls: "small" })); prev = m.word; }
  if (won) played[played.length - 1] = tiles(g.end, { cls: "small end" });
  const counts = g.players.map((p) => ({ ...p, n: g.ladder.filter((m) => m.seat === p.seat).length }));
  const stars = g.stars ?? 0;
  const title = won ? (team ? "You did it together" : "You made it") : "Ladder stopped";

  app.innerHTML = `
    <main class="screen">
      ${state.again ? `
        <div class="banner"><span><b>${esc(state.again.by)}</b> started a new ladder.</span>
          <a class="btn blue" href="/g/${esc(state.again.code)}" data-link>Open</a></div>` : ""}
      ${hero(g.mode, `
        <span class="lab">${MODES[g.mode].label} · ${up(g.start)} → ${up(g.end)} · par ${g.par}</span>
        <h1 style="font-size:1.8rem">${title}</h1>
        <p>${won ? `${g.steps_used} steps · <span class="hero-stars">${starText(stars)}</span>` : `Stopped after ${g.steps_used} steps`}</p>
        ${team ? `<div class="stats">${counts.map((p) => `<div><span class="small">${p.me ? "You" : esc(p.name)}</span><b>${p.n} word${p.n === 1 ? "" : "s"}</b></div>`).join("")}</div>` : ""}`)}
      <div class="card stack">
        <span class="label">${won ? "Your ladder" : "How far you got"}</span>
        <div class="mini-ladder">${played.join("")}</div>
      </div>
      <details class="card">
        <summary><b>Shortest possible ladder</b> <span class="muted">(${g.par} steps)</span></summary>
        <div class="mini-ladder" style="margin-top:12px">
          ${(g.solution ?? []).map((w, i, a) => tiles(w, { target: g.end, cls: i === a.length - 1 ? "small end" : "small" })).join("")}
        </div>
      </details>
      <div class="row" style="margin-top:auto">
        <a class="btn ghost" href="/" data-link>Home</a>
        <button class="btn${MODES[g.mode].cls}" data-action="again">Play again${team && partner ? ` with ${esc(partner.name)}` : ""}</button>
      </div>
    </main>`;
}

// ---------- events ----------

let giveUpArmed = null;
const actions = {
  async logout(el) {
    el.disabled = true;
    try {  // this device should stop getting notifications for this account
      const sub = await navigator.serviceWorker?.ready.then((r) => r.pushManager?.getSubscription());
      if (sub) await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
    } catch { /* not subscribed */ }
    await api("/api/logout", { method: "POST" }).catch(() => {});
    state.me = null;
    state.daily = null;
    go("/", { replace: true });
  },
  async "delete-account"(el) {
    if (giveUpArmed !== el) {  // same two-tap confirm as Give up
      giveUpArmed = el;
      el.textContent = "Tap again to delete everything";
      setTimeout(() => { if (giveUpArmed === el) { giveUpArmed = null; el.textContent = "Delete my account"; } }, 4000);
      return;
    }
    giveUpArmed = null;
    try {
      const sub = await navigator.serviceWorker?.ready.then((r) => r.pushManager?.getSubscription());
      await sub?.unsubscribe();
    } catch { /* not subscribed */ }
    await api("/api/account/delete", { method: "POST" });
    state.me = null;
    toast("Your account was deleted");
    go("/", { replace: true });
  },
  async install() {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    await p.userChoice.catch(() => {});
    state.installPrompt = null;
    renderHome();
  },
  setup(el) {
    const s = state.setup;
    const v = el.dataset.value;
    s[el.dataset.key] = el.dataset.key === "length" ? Number(v) : v;
    s.start = ""; s.end = ""; s.par = null; s.error = null;
    drawSetup();
    if (s.source === "suggest") suggest();
    else document.getElementById("start").focus();
  },
  suggest() { suggest(); },
  async join() {
    try {
      state.game = await api(`/api/games/${state.game.code}/join`, { method: "POST" });
      history.replaceState(null, "", `/g/${state.game.code}`);
      drawGame();
      openSocket(state.game.code);
    } catch (e) {
      toast(e.message);
    }
  },
  "copy-invite"() { copy(inviteUrl(state.game.code)); },
  "tutorial-skip"() { finishTutorial(); },
  async "daily-play"(el) {
    el.disabled = true;
    try {
      const g = await api("/api/daily", { method: "POST" });
      go(`/g/${g.code}`);
    } catch (e) {
      toast(e.message);
      el.disabled = false;
    }
  },
  async "daily-share"() {
    const text = shareText(state.game);
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch { /* closed the share sheet */ return; }
    }
    try { await navigator.clipboard.writeText(text); toast("Result copied. Paste it in any chat."); } catch { toast("Couldn't copy the result."); }
  },
  "lb-tab"(el) { state.lb.tab = el.dataset.value; renderLeaderboard(); },
  async "race-start"(el) {
    el.disabled = true;
    try {
      state.game = await api(`/api/games/${state.game.code}/start`, { method: "POST" });
      state.entry = ""; state.feedback = null;
      drawGame();
    } catch (e) {
      toast(e.message);
      el.disabled = false;
    }
  },
  async "push-test"(el) {
    const out = document.getElementById("push-result");
    el.disabled = true;
    // Ask first, straight from the tap: Safari ignores the request after an await.
    const asked = pushStatus() === "default" ? Notification.requestPermission() : Promise.resolve(pushStatus());
    try {
      const permission = await asked;
      document.getElementById("push-state").textContent = pushCheckText();
      if (permission !== "granted") {
        out.textContent = "Permission wasn't given, so nothing was sent.";
        return;
      }
      out.textContent = "Sending…";
      await syncPush();
      const r = await api("/api/push/test", { method: "POST" });
      if (!r.devices) out.textContent = "This device couldn't register for notifications. Close the app completely, open it again and retry.";
      else if (r.sent) out.textContent = "Sent! It should arrive within a few seconds. If it doesn't, check that notifications for Word Ladder are allowed in your phone's settings and that Focus or Do Not Disturb is off.";
      else out.textContent = `The notification service refused it: ${r.problems.join("; ") || "unknown reason"}`;
    } catch (e) {
      out.textContent = `Couldn't send a test: ${e.message}`;
    } finally {
      el.disabled = false;
    }
  },
  async "share-invite"() {
    const g = state.game;
    try {
      await navigator.share({
        title: "Word Ladder",
        text: `Climb a word ladder with me: ${g.start.toUpperCase()} → ${g.end.toUpperCase()}`,
        url: inviteUrl(g.code),
      });
    } catch { /* closed the share sheet */ }
  },
  async hint() {
    const g = state.game;
    // Second tap on the same step: fill in the word, ready for Enter. Costs nothing extra.
    if (state.hint && state.hint.from === g.current) {
      state.entry = state.hint.word;
      state.feedback = { text: `Press Enter to play ${state.hint.word.toUpperCase()}`, kind: "ok" };
      state.hint.shown = true;
      return drawGame();
    }
    try {
      const r = await api(`/api/games/${g.code}/hint`, { method: "POST" });
      state.game = r.game;
      state.hint = { from: g.current, word: r.word, shown: false };
      state.hintPos = r.position;
      state.entry = "";
      const nth = ["1st", "2nd", "3rd", "4th", "5th", "6th"][r.position];
      state.feedback = {
        text: `Change the ${nth} letter, ${g.current[r.position].toUpperCase()}, to ${r.letter.toUpperCase()}${r.penalty ? " (+1 step)" : ""}`,
        kind: "ok",
      };
      drawGame();
    } catch (e) {
      setFeedback(e.message, "bad");
    }
  },
  async undo() {
    try {
      state.game = await api(`/api/games/${state.game.code}/undo`, { method: "POST" });
      state.entry = ""; state.hintPos = null; state.hint = null;
      state.feedback = { text: "Stepped back one rung (counts as a step)", kind: "meh" };
      drawGame();
    } catch (e) {
      setFeedback(e.message, "bad");
    }
  },
  async "give-up"(el) {
    if (giveUpArmed !== el) {
      giveUpArmed = el;
      const label = el.textContent;
      el.classList.add("armed");
      el.textContent = "Tap again to confirm";
      setTimeout(() => { if (giveUpArmed === el) { giveUpArmed = null; el.classList.remove("armed"); el.textContent = label; } }, 3000);
      return;
    }
    giveUpArmed = null;
    try {
      state.game = await api(`/api/games/${state.game.code}/give-up`, { method: "POST" });
      if (state.game.status === "gave_up" && state.game.ladder.length === 0 && state.game.players.length < 2) return go("/", { replace: true });
      if (state.game.mode === "race") state.feedback = null;
      drawGame();
    } catch (e) {
      toast(e.message);
    }
  },
  async again(el) {
    el.disabled = true;
    try {
      const g = await api(`/api/games/${state.game.code}/again`, { method: "POST", body: {} });
      go(`/g/${g.code}`);
    } catch (e) {
      toast(e.message);
      el.disabled = false;
    }
  },
};

app.addEventListener("click", (ev) => {
  if (state.me) askForPushOnce();
  const link = ev.target.closest("a[data-link]");
  if (link) {
    ev.preventDefault();
    return go(link.getAttribute("href"));
  }
  const key = ev.target.closest("[data-key]:not([data-action])");
  if (key) return pressKey(key.dataset.key);
  const act = ev.target.closest("[data-action]");
  if (act && actions[act.dataset.action]) actions[act.dataset.action](act);
});

app.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target.dataset.form;
  if (form === "username") {
    const errEl = document.getElementById("username-error");
    const btn = ev.target.querySelector("button[type=submit]");
    askForPushOnce();
    btn.disabled = true;
    errEl.textContent = "";
    try {
      state.me = await api("/api/username", { method: "POST", body: { username: new FormData(ev.target).get("username").trim() } });
      syncPush().catch(() => {});
      // A brand-new player (not from an invite) learns the game by playing a tiny one.
      if (location.pathname === "/" && !tutorialSeen()) return go("/tutorial", { replace: true });
      route();
    } catch (e) {
      errEl.textContent = e.message;
      btn.disabled = false;
    }
  } else if (form === "join-code") {
    const code = new FormData(ev.target).get("code").trim().toUpperCase();
    if (code.length === 5) go(`/g/${code}`);
    else toast("Game codes have 5 characters.");
  } else if (form === "setup") {
    startGame();
  }
});

app.addEventListener("input", (ev) => {
  if (ev.target.id === "start" || ev.target.id === "end") onSetupInput();
});

document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target.matches?.("input, textarea")) return;
  if (!state.game?.my_turn || !document.getElementById("entry")) return;
  const k = ev.key === "Enter" ? "enter" : ev.key === "Backspace" ? "back" : ev.key.toLowerCase();
  if (k === "enter" || k === "back" || /^[a-z]$/.test(k)) {
    ev.preventDefault();
    pressKey(k);
  }
});

window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  state.installPrompt = ev;
  if (location.pathname === "/" && state.me) renderHome();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

route();
