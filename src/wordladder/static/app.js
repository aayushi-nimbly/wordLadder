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

const starText = (n) => "★".repeat(n || 0) + "☆".repeat(3 - (n || 0));
const inviteUrl = (code) => `${location.origin}/j/${code}`;

function tiles(word, { prev = null, seat = null, cls = "" } = {}) {
  const letters = [...word].map((ch, i) => {
    const changed = prev && prev[i] !== ch;
    return `<span class="t${changed && seat ? ` s${seat}` : ""}">${esc(ch)}</span>`;
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
  const path = location.pathname;
  const gameMatch = path.match(/^\/(g|j)\/([A-Za-z0-9]+)/);

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
  if (path === "/new") return renderSetup(new URLSearchParams(location.search).get("mode") || "solo");
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
    ? `<p><b>${esc(invite.host)}</b> invited you to climb a ${invite.length}-letter word ladder together.</p>`
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
      ${rename ? "" : `<p class="muted small">No signup. Your games are saved in this browser.</p>`}
    </main>`;
  app.querySelector("#name").focus();
}

// ---------- home ----------

async function renderHome() {
  app.innerHTML = `<main class="screen"><div class="top"><span class="logo">Word Ladder</span></div></main>`;
  let games = { active: [], finished: [] };
  try {
    games = await api("/api/games");
  } catch (e) {
    toast(e.message);
  }
  const row = (g) => {
    const who = g.mode === "solo" ? "Solo" : g.partner ? esc(g.partner) : "Invite sent";
    let right;
    if (g.status === "won") right = `<span class="stars" aria-label="${g.stars} stars">${starText(g.stars)}</span>`;
    else if (g.status === "gave_up") right = `<span class="pill wait">Gave up</span>`;
    else if (g.status === "waiting") right = `<span class="pill wait">Waiting for friend</span>`;
    else if (g.my_turn) right = `<span class="pill turn">Your turn</span>`;
    else right = `<span class="pill wait">Their turn · ${ago(g.updated_at)}</span>`;
    return `
      <a href="/g/${g.code}" data-link>
        <span class="item-main"><b>${who}</b><span class="item-words">${up(g.start)} → ${up(g.end)}</span></span>
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
        <button class="linkish" data-action="rename">Hi, ${esc(state.me.name)}</button>
      </div>
      <div class="stack">
        <a class="btn" href="/new?mode=solo" data-link>Play solo</a>
        <a class="btn blue" href="/new?mode=team" data-link>Play with a friend</a>
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

function renderSetup(mode) {
  state.setup = { mode, length: 5, difficulty: "medium", start: "", end: "", par: null, error: null, checking: false };
  drawSetup();
  suggest();
}

function drawSetup() {
  const s = state.setup;
  const seg = (name, values, current, labels = values) => `
    <div class="seg" role="group" aria-label="${name}">
      ${values.map((v, i) => `<button type="button" data-action="setup" data-key="${name}" data-value="${v}" aria-pressed="${v === current}">${labels[i]}</button>`).join("")}
    </div>`;
  app.innerHTML = `
    <main class="screen">
      <div class="top">
        <a class="icon-btn" href="/" data-link aria-label="Back">←</a>
        <h2>${s.mode === "solo" ? "Solo game" : "Play with a friend"}</h2>
        <span style="width:24px"></span>
      </div>
      <div class="field"><span class="label">Letters</span>${seg("length", [4, 5, 6], s.length)}</div>
      <div class="field"><span class="label">Difficulty</span>${seg("difficulty", ["easy", "medium", "hard"], s.difficulty, ["Easy", "Medium", "Hard"])}</div>
      <form class="stack" data-form="setup">
        <div class="field">
          <label class="label" for="start">Start word</label>
          <input class="input word-input" id="start" name="start" maxlength="${s.length}" value="${esc(s.start)}" autocomplete="off" autocapitalize="none" spellcheck="false">
        </div>
        <div class="field">
          <label class="label" for="end">End word</label>
          <input class="input word-input" id="end" name="end" maxlength="${s.length}" value="${esc(s.end)}" autocomplete="off" autocapitalize="none" spellcheck="false">
        </div>
        <div class="row" style="align-items:center">
          <span id="puzzle-status" class="badge"></span>
          <button type="button" class="btn quiet" data-action="suggest" style="flex:0 0 auto">↻ Suggest again</button>
        </div>
        <p class="muted small" style="margin:0">Use our suggestion or type your own words.</p>
        <button class="btn${s.mode === "team" ? " blue" : ""}" id="setup-go" type="submit" style="margin-top:8px">
          ${s.mode === "solo" ? "Start game" : "Create invite"}
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
  if (s.checking) { el.className = "badge"; el.textContent = "Checking…"; }
  else if (s.error) { el.className = "badge bad"; el.textContent = s.error; }
  else if (s.par) { el.className = "badge ok"; el.textContent = `✓ Solvable · par ${s.par}`; }
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
    document.getElementById("start").value = p.start;
    document.getElementById("end").value = p.end;
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
    s.error = `Both words need ${s.length} letters.`;
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
      body: { mode: s.mode, length: s.length, difficulty: s.difficulty, start: s.start, end: s.end },
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

function openSocket(code) {
  if (socketCode === code && socket) return;
  closeSocket();
  socketCode = code;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws/games/${code}`);
  socket.onopen = () => {
    retryDelay = 1000;
    pingTimer = setInterval(() => socket?.readyState === 1 && socket.send("ping"), 25000);
  };
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "state" && msg.game.code === state.game?.code) applyState(msg.game);
    if (msg.type === "again") {
      state.again = msg;
      if (state.game && ["won", "gave_up"].includes(state.game.status)) drawGame();
      else toast(`${msg.by} started a new ladder`);
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
  if (state.game.my_seat && state.game.mode === "team") openSocket(code);
}

function applyState(g) {
  const old = state.game;
  state.game = g;
  if (old) {
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
  if (document.hidden) return;
  document.title = "Word Ladder";
  // Phones drop sockets while asleep; resync when the app comes back.
  if (state.game && location.pathname.startsWith("/g/")) {
    api(`/api/games/${state.game.code}`).then(applyState).catch(() => {});
    if (state.game.mode === "team" && state.game.my_seat && !socket) openSocket(state.game.code);
  }
});

function drawGame() {
  const g = state.game;
  if (!g) return;
  if (!g.my_seat) return drawJoin(g);
  if (g.status === "waiting") return drawInvite(g);
  if (g.status === "won" || g.status === "gave_up") return drawResult(g);
  drawPlay(g);
}

function drawJoin(g) {
  const host = g.players[0]?.name ?? "A friend";
  app.innerHTML = `
    <main class="screen center">
      <span class="label">Invitation · ${g.length} letters</span>
      <h1 class="logo-big" style="font-size:2.2rem">${esc(host)} invited you</h1>
      <p class="muted">Take turns adding one word each. Get from the start word to the end word together.</p>
      <div class="stack" style="align-items:center">
        ${tiles(g.start)}
        <span class="muted">to</span>
        ${tiles(g.end, { cls: "end" })}
      </div>
      <button class="btn blue" data-action="join">Join ${esc(host)}'s game</button>
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
      <p class="muted small" style="text-align:center;margin:0">Send the link in any chat. Your friend taps it, types a name and joins. No signup.</p>
      <div class="card stack" style="align-items:center">
        <span class="label">Your ladder</span>
        ${tiles(g.start, { cls: "small" })}
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

  let prev = g.start;
  const rungs = [tiles(g.start)];
  g.ladder.forEach((m, i) => {
    rungs.push(tiles(m.word, { prev, seat: m.seat, cls: i === g.ladder.length - 1 ? "rung-new" : "" }));
    prev = m.word;
  });
  if (g.my_turn) rungs.push(`<div id="entry"></div>`);
  const toGo = g.distance === null || g.distance < 0 ? "no way through" : `${g.distance} to go`;
  rungs.push(`<div class="gap">· · · ${toGo} · · ·</div>`);
  rungs.push(tiles(g.end, { cls: "end" }));

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
  const ladderEl = document.getElementById("ladder");
  const target = document.getElementById("entry") ?? ladderEl.lastElementChild?.previousElementSibling;
  target?.scrollIntoView({ block: "center" });
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
    if (next.status === "won") state.feedback = null;
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
  const played = [tiles(g.start, { cls: "small" })];
  for (const m of g.ladder) { played.push(tiles(m.word, { prev, seat: m.seat, cls: "small" })); prev = m.word; }
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
          ${(g.solution ?? []).map((w, i, a) => tiles(w, { cls: i === a.length - 1 ? "small end" : "small" })).join("")}
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
    s.start = ""; s.end = ""; s.par = null;
    drawSetup();
    suggest();
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
