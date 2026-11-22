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
  solo: { title: "Solo game", button: "Start game", cls: "" },
  team: { title: "Team up with a friend", button: "Create invite", cls: " blue" },
  race: { title: "Race a friend", button: "Create race", cls: " race" },
};
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
  const path = location.pathname;
  const gameMatch = path.match(/^\/(g|j)\/([A-Za-z0-9]+)/);

  if (path === "/leaderboard") {  // also readable before entering a name
    if (!state.me) state.me = await api("/api/me").catch(() => null);
    return renderLeaderboard();
  }
  if (path === "/help") {  // readable before entering a name
    if (!state.me) state.me = await api("/api/me").catch(() => null);
    return renderHelp();
  }

  if (!state.me) {
    try {
      state.me = await api("/api/me");
      syncPush().catch(() => {});
    } catch (e) {
      if (e.status !== 401) return renderError(e.message);
      let invite = null;
      if (gameMatch) invite = await api(`/api/invites/${gameMatch[2]}`).catch(() => null);
      return renderName({ invite });
    }
  }
  window.scrollTo(0, 0);
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

function renderName({ invite = null, rename = false } = {}) {
  const intro = invite?.open
    ? invite.mode === "race"
      ? `<p><b>${esc(invite.host)}</b> challenged you to a ${invite.length}-letter word ladder race.</p>`
      : `<p><b>${esc(invite.host)}</b> invited you to climb a ${invite.length}-letter word ladder together.</p>`
    : invite
      ? `<p class="muted">That game already has two players.</p>`
      : `<p class="muted">Change one letter at a time to turn one word into another. Play solo or team up with a friend.</p>`;
  app.innerHTML = `
    <main class="screen center">
      <h1 class="logo-big">Word Ladder</h1>
      ${rename ? "" : intro}
      <form class="stack" data-form="name">
        <div class="field">
          <label class="label" for="name">${rename ? "Change your name" : "Your name"}</label>
          <input class="input" id="name" name="name" maxlength="24" autocomplete="nickname" required
            value="${esc(rename ? state.me?.name : "")}" placeholder="What your friend will see">
        </div>
        <button class="btn" type="submit">${rename ? "Save" : invite?.open ? "Join the game" : "Start playing"}</button>
        ${rename ? `<a class="btn ghost" href="/" data-link>Cancel</a>` : ""}
      </form>
      ${rename ? "" : `<p class="muted small">No signup. Your games are saved in this browser. <a href="/help" data-link>How to play</a></p>`}
    </main>`;
  app.querySelector("#name").focus();
}

// ---------- home ----------

async function renderHome() {
  app.innerHTML = `<main class="screen"><div class="top"><span class="logo">Word Ladder</span></div></main>`;
  let games = { active: [], finished: [] };
  try {
    [games, state.daily] = await Promise.all([api("/api/games"), api("/api/daily")]);
  } catch (e) {
    toast(e.message);
  }
  const row = (g) => {
    const who = g.mode === "solo" ? "Solo" : g.partner ? esc(g.partner) : "Invite sent";
    const kind = { solo: "", team: "Team · ", race: "Race · " }[g.mode];
    let right;
    if (g.mode === "race" && g.status === "finished") {
      right = { won: `<span class="pill turn">🏆 Won</span>`, lost: `<span class="pill wait">Lost</span>`,
        tie: `<span class="pill wait">Tie</span>` }[g.outcome] ?? `<span class="pill wait">No winner</span>`;
    } else if (g.mode === "race" && g.status === "active") {
      right = g.my_turn ? `<span class="pill turn">Your go</span>` : `<span class="pill wait">Waiting for ${esc(g.partner)}</span>`;
    } else if (g.status === "won") right = `<span class="stars" aria-label="${g.stars} stars">${starText(g.stars)}</span>`;
    else if (g.status === "gave_up") right = `<span class="pill wait">Gave up</span>`;
    else if (g.status === "waiting") right = `<span class="pill wait">Waiting for friend</span>`;
    else if (g.my_turn) right = `<span class="pill turn">Your turn</span>`;
    else right = `<span class="pill wait">Their turn · ${ago(g.updated_at)}</span>`;
    return `
      <a href="/g/${g.code}" data-link>
        <span class="item-main"><b>${who}</b><span class="item-words">${kind}${up(g.start)} → ${up(g.end)}</span></span>
        ${right}
      </a>`;
  };
  const install = !isStandalone() && state.installPrompt
    ? `<div class="banner"><span><b>Install Word Ladder</b><br><span class="small">Open it from your home screen like an app.</span></span><button class="btn blue" data-action="install">Install</button></div>`
    : "";

  app.innerHTML = `
    <main class="screen">
      <div class="top">
        <span class="logo">Word Ladder</span>
        <span class="top-actions">
          <a class="help-btn" href="/leaderboard" data-link aria-label="Leaderboard">🏆</a>
          <a class="help-btn" href="/help" data-link aria-label="How to play">?</a>
          <button class="linkish" data-action="rename">Hi, ${esc(state.me.name)}</button>
        </span>
      </div>
      ${games.active.length || games.finished.length || state.daily?.mine ? "" : `
        <a class="banner" href="/help" data-link style="text-decoration:none">
          <span><b>New to word ladders?</b><br><span class="small">See how to play in 30 seconds.</span></span><b aria-hidden="true">→</b>
        </a>`}
      <section class="daily card" id="daily-card">${dailyCard()}</section>
      <div class="stack">
        <a class="btn" href="/new?mode=solo" data-link>Play solo</a>
        <a class="btn blue" href="/new?mode=team" data-link>Team up with a friend</a>
        <a class="btn race" href="/new?mode=race" data-link>Race a friend</a>
      </div>
      <form class="row" data-form="join-code">
        <input class="input code-input" id="join-code" name="code" aria-label="Game code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" style="flex:2">
        <button class="btn ghost" type="submit">Join</button>
      </form>
      ${install}
      ${installHint()}
      <section class="stack">
        <span class="label">Your games</span>
        <div class="list">${games.active.length ? games.active.map(row).join("") : `<div class="empty">No games in progress. Start one above.</div>`}</div>
      </section>
      ${games.finished.length ? `
      <section class="stack">
        <span class="label">Finished</span>
        <div class="list">${games.finished.map(row).join("")}</div>
      </section>` : ""}
    </main>`;
}

// ---------- setup ----------

const EXAMPLES = { 4: ["cold", "warm"], 5: ["stone", "money"], 6: ["winter", "summer"] };

function renderSetup(mode) {
  state.setup = {
    mode, length: 5, difficulty: "medium", source: "suggest",
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
          <button type="button" class="btn quiet" data-action="suggest" style="flex:0 0 auto">↻ Other words</button>
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
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
        <h2>${MODES[s.mode].title}</h2>
        <span style="width:24px"></span>
      </div>
      <div class="field"><span class="label">Letters</span>${seg("length", [4, 5, 6], s.length)}</div>
      <div class="field"><span class="label">Words</span>${seg("source", ["suggest", "own"], s.source, ["✨ Suggest for me", "✏️ Choose my own"])}</div>
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
      else toast(`${msg.by} started a new ${state.game?.mode === "race" ? "race" : "ladder"}`);
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
  state.entry = ""; state.hintPos = null; state.feedback = null; state.again = null;
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
  app.innerHTML = `
    <main class="screen center">
      <span class="label">Invitation · ${g.length} letters</span>
      <h1 class="logo-big" style="font-size:2.2rem">${esc(host)} ${g.mode === "race" ? "challenged you to a race" : "invited you"}</h1>
      <p class="muted">${g.mode === "race"
        ? "You both solve the same puzzle, each on your own ladder. Fewest steps wins; if it's a tie, the faster time wins."
        : "Take turns adding one word each. Get from the start word to the end word together."}</p>
      <div class="stack" style="align-items:center">
        ${tiles(g.start, { target: g.end })}
        <span class="muted">to</span>
        ${tiles(g.end, { cls: "end" })}
      </div>
      <button class="btn${MODES[g.mode].cls}" data-action="join">${g.mode === "race" ? "Accept the race" : `Join ${esc(host)}'s game`}</button>
      <a class="linkish" href="/help" data-link style="align-self:center">How to play</a>
    </main>`;
}

function drawInvite(g) {
  const url = inviteUrl(g.code);
  app.innerHTML = `
    <main class="screen">
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
        <h2>Invite a friend</h2>
        <span class="label">${g.length} · ${esc(g.difficulty ?? "custom")}</span>
      </div>
      <div class="stack" style="align-items:center;text-align:center">
        <span class="label">Game code</span>
        <div class="tiles code-tiles">${[...g.code].map((c) => `<span class="t">${esc(c)}</span>`).join("")}</div>
      </div>
      <div class="link-box"><code>${esc(url)}</code><button class="btn quiet" data-action="copy-invite" style="min-height:36px">Copy</button></div>
      ${navigator.share ? `<button class="btn blue" data-action="share-invite">Share link</button>` : ""}
      <p class="muted small" style="text-align:center;margin:0">Send the link in any chat. Your friend taps it, types a name and joins. No signup.${
        g.mode === "race" ? " You'll both get this same puzzle." : ""}</p>
      <div class="card stack" style="align-items:center">
        <span class="label">${g.mode === "race" ? "The puzzle" : "Your ladder"}</span>
        ${tiles(g.start, { target: g.end, cls: "small" })}
        <span class="muted small">par ${g.par}</span>
        ${tiles(g.end, { cls: "small end" })}
      </div>
      ${installHint()}
      <p class="muted pulse" style="text-align:center;margin-top:auto">● Waiting for your friend to join…</p>
      <button class="linkish" data-action="give-up" style="align-self:center">Cancel this game</button>
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
        <button data-action="hint" ${g.hints_left ? "" : "disabled"}>💡 Hint (${g.hints_left})</button>
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>↶ Undo</button>
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
        <div class="team" style="flex:1">${who}</div>
      </div>
      <div class="progress"><span>Step ${g.steps_used}</span><span>Par ${g.par}</span><span>${toGo}</span></div>
      <div class="ladder" id="ladder">${rungs.join("")}</div>
      <div class="feedback ${state.feedback?.kind ?? ""}" id="feedback">${esc(state.feedback?.text ?? "")}</div>
      ${bottom}
    </main>`;
  drawEntry();
  scrollToEntry();
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
          <span class="label">Race · par ${g.par}</span>
          ${tiles(g.start, { target: g.end })}
          <span class="muted">to</span>
          ${tiles(g.end, { cls: "end" })}
          <p class="muted small" style="margin:0">Fewest steps wins. If you tie, the faster time wins.
            Your clock starts when you tap Start, so start when you're ready.</p>
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
      <div class="feedback ${state.feedback?.kind ?? ""}" id="feedback">${esc(state.feedback?.text ?? "")}</div>
      <div class="tools">
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>↶ Undo</button>
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
  const title = { won: "You win! 🏆", lost: `${esc(partner?.name)} wins`, tie: "It's a tie" }[outcome] ?? "No winner";
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
          <a class="btn race" href="/g/${esc(state.again.code)}" data-link>Open</a></div>` : ""}
      <div class="result">
        <span class="label">Race · ${up(g.start)} → ${up(g.end)} · par ${g.par}</span>
        <h1>${title}</h1>
      </div>
      <div class="contrib">
        ${ordered.map((x) => `
          <div class="s${x.seat}${x.seat === g.race.winner_seat ? " winner" : ""}">
            <span class="label">${nameOf(x)}${x.seat === g.race.winner_seat ? " · 🏆" : ""}</span>
            <b>${x.gave_up ? "Gave up" : `${x.steps} steps`}</b>
            <span class="small">${x.gave_up ? `after ${x.steps} steps` : `${fmtTime(x.time_ms)} · ${starText(x.stars)}`}</span>
          </div>`).join("")}
      </div>
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

function dailyCard() {
  const d = state.daily;
  if (!d) return `<span class="muted small">Daily ladder unavailable right now.</span>`;
  const m = d.mine;
  const done = m?.status === "finished";
  const hours = Math.floor(d.resets_in / 3600);
  const next = hours ? `Next in ${hours}h` : `Next in ${Math.max(1, Math.round(d.resets_in / 60))}m`;
  const side = [d.streak ? `🔥 ${d.streak}` : "", done ? next : ""].filter(Boolean).join(" · ");
  let body;
  if (done && !m.gave_up) {
    body = `
      <div class="daily-result">
        <span><b>${m.steps} steps · ${fmtTime(m.time_ms)}</b> <span class="stars">${starText(m.stars)}</span></span>
        <span class="daily-rank">#${m.rank}</span>
      </div>
      <div class="row">
        <a class="btn quiet" href="/leaderboard" data-link>Leaderboard</a>
        <a class="btn quiet" href="/g/${m.code}" data-link>My ladder</a>
      </div>`;
  } else if (m?.gave_up) {
    body = `<a class="btn quiet" href="/leaderboard" data-link>Leaderboard</a>`;
  } else if (m?.started) {
    body = `<a class="btn" href="/g/${m.code}" data-link>Continue · ${m.steps} step${m.steps === 1 ? "" : "s"} so far</a>`;
  } else {
    body = `<button class="btn" data-action="daily-play">Play · ${d.length} letters</button>`;
  }
  return `
    <div class="daily-head">
      <span class="label">Daily ladder${m?.gave_up ? " · gave up" : ""}</span>
      ${side ? `<span class="small muted">${side}</span>` : ""}
    </div>
    ${body}`;
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
            Fewest steps wins; ties go to the faster time. No hints.</p>
          <button class="btn" data-action="race-start" style="width:100%">Start</button>
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
      <div class="feedback ${state.feedback?.kind ?? ""}" id="feedback">${esc(state.feedback?.text ?? "")}</div>
      <div class="tools">
        <button data-action="undo" ${g.ladder.length ? "" : "disabled"}>↶ Undo</button>
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
      <div class="result">
        <span class="label">${won ? `${me.steps} steps · ${fmtTime(me.time_ms)} · par ${g.par}` : `Stopped after ${me.steps} steps`}</span>
        <h1>${won ? (me.steps <= g.par ? "Perfect ladder!" : "Solved!") : "Not today"}</h1>
        ${won ? `<div class="big-stars" aria-label="${me.stars} of 3 stars">${"★".repeat(me.stars)}<span class="off">${"★".repeat(3 - me.stars)}</span></div>` : ""}
        <p class="daily-rank-big" id="daily-rank">&nbsp;</p>
      </div>
      <div class="row">
        <button class="btn" data-action="daily-share">Share result</button>
        <a class="btn quiet" href="/leaderboard" data-link>Leaderboard</a>
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
    if (el && board.me?.rank) el.innerHTML = `<b>#${board.me.rank}</b> of ${ranked} today`;
    else if (el) el.textContent = `${board.played} played today`;
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
  const medal = (r) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : r ?? "—");
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
        ${state.me && !b.me ? `<div class="banner"><span>You haven't played today's ladder yet.</span><button class="btn" data-action="daily-play">Play</button></div>` : ""}
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
          <thead><tr><th>Friend</th><th class="num">Races W–L</th><th class="num">Team games</th><th class="num">Avg ★</th></tr></thead>
          <tbody>${b.rows.map((r) => `
            <tr><td class="name">${esc(r.name)}</td>
              <td class="num">${r.won}–${r.lost}${r.tied ? ` (${r.tied} tie${r.tied === 1 ? "" : "s"})` : ""}</td>
              <td class="num">${r.team_games}</td><td class="num">${r.avg_stars ?? "—"}</td></tr>`).join("")}
          </tbody>
        </table></div>
        <p class="small muted">Your record against each friend in races, and how your team games went.</p>`
        : `<p class="empty card">Play a Team game or a Race with a friend and they'll show up here.</p>`;
    }
  } catch (e) {
    el.innerHTML = `<p class="empty card">${esc(e.message)}</p>`;
  }
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
          <li><b>Hint</b> shows which letter to change next (2 per game). <b>Undo</b> takes back the last word, but that step still counts.</li>
          <li>Stuck with "no way through"? That word is a dead end. Undo and try another.</li>
        </ul>
      </section>
      <section class="stack">
        <h3>Ways to play</h3>
        <div class="modes-help">
          <div><b>Solo</b><span>Just you and the puzzle.</span></div>
          <div><b>Team</b><span>You and a friend take turns adding one word each to the same ladder, and win together. You get a notification when it's your turn.</span></div>
          <div><b>Daily ladder</b><span>One puzzle a day, the same for everyone. Its length (4, 5 or 6 letters) changes from day to day. You get one try, the words appear when you tap Start, and you're ranked on the leaderboard by fewest steps, then time. Play every day to keep your streak.</span></div>
          <div><b>Race</b><span>You both get the same puzzle and climb your own ladders. Fewest steps wins; if tied, the faster time wins. Your clock starts when you tap Start, and you can't see your friend's words until you're both done. No hints.</span></div>
        </div>
      </section>
      <section class="stack">
        <h3>Notifications</h3>
        <p class="small" style="margin:0" id="push-state">${pushCheckText()}</p>
        ${canTest && state.me ? `<button class="btn quiet" data-action="push-test">Send me a test notification</button>` : ""}
        <p class="small muted" style="margin:0" id="push-result"></p>
      </section>
      <a class="btn" href="/" data-link>Let's play</a>
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
      <div><button type="button" class="wide" data-key="enter">ENTER</button>${[...rows[2]].map(key).join("")}<button type="button" class="wide" data-key="back" aria-label="Delete">⌫</button></div>
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
  if (state.entry.length !== g.length) {
    setFeedback(`Type a ${g.length}-letter word.`, "bad");
    return shake();
  }
  submitting = true;
  const before = g.distance;
  try {
    const next = await api(`/api/games/${g.code}/moves`, { method: "POST", body: { word: state.entry } });
    state.entry = ""; state.hintPos = null;
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
      <div class="result">
        <span class="label">${won ? `Ladder complete in ${g.steps_used} · par ${g.par}` : `Stopped after ${g.steps_used} steps · par ${g.par}`}</span>
        <h1>${title}</h1>
        ${won ? `<div class="big-stars" aria-label="${stars} of 3 stars">${"★".repeat(stars)}<span class="off">${"★".repeat(3 - stars)}</span></div>` : ""}
      </div>
      ${team ? `<div class="contrib">${counts.map((p) => `<div class="s${p.seat}"><span class="label">${p.me ? "You" : esc(p.name)}</span><b>${p.n} word${p.n === 1 ? "" : "s"}</b></div>`).join("")}</div>` : ""}
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
        <button class="btn${team ? " blue" : ""}" data-action="again">Play again${team && partner ? ` with ${esc(partner.name)}` : ""}</button>
      </div>
    </main>`;
}

// ---------- events ----------

let giveUpArmed = null;
const actions = {
  async rename() { renderName({ rename: true }); },
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
    try {
      const r = await api(`/api/games/${state.game.code}/hint`, { method: "POST" });
      state.game = r.game;
      state.hintPos = r.position;
      state.feedback = { text: `Hint: change letter ${r.position + 1}`, kind: "ok" };
      drawGame();
    } catch (e) {
      setFeedback(e.message, "bad");
    }
  },
  async undo() {
    try {
      state.game = await api(`/api/games/${state.game.code}/undo`, { method: "POST" });
      state.entry = ""; state.hintPos = null;
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
  if (form === "name") {
    const name = new FormData(ev.target).get("name").trim();
    if (!name) return;
    askForPushOnce();
    try {
      state.me = await api("/api/players", { method: "POST", body: { name } });
      syncPush().catch(() => {});
      route();
    } catch (e) {
      toast(e.message);
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
