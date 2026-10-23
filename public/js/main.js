// App entry: lobby, socket wiring, HUD, and glue between the 3D view, media, and sound.
import { io } from '/socket.io/socket.io.esm.min.js';
import { World } from './scene/world.js';
import { GameView } from './game.js';
import { MediaManager } from './media.js';
import { Sound } from './sound.js';
import { tileName, KINDS } from '/shared/tiles.js';
import { waits as handWaits, shanten } from '/shared/scoring.js';
import { loadTileFont, buildAtlas, tileCss } from './scene/tileFaces.js';
import { WIND_CHAR, WIND_EN } from './game.js';
import { ACHIEVEMENTS, ACHIEVEMENT_BY_ID } from './achievements.js';
import { PadInput, GLYPHS } from './gamepad.js';
import { PadNav, OnScreenKeyboard } from './padnav.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString();
const safe = (store) => ({
  get: (k) => { try { return store.getItem(k); } catch { return null; } },
  set: (k, v) => { try { store.setItem(k, v); } catch { /* ignore */ } },
  del: (k) => { try { store.removeItem(k); } catch { /* ignore */ } },
});
const local = safe(window.localStorage);
const session = safe(window.sessionStorage);

// Per-tab identity so refreshing reconnects you to your seat (and two tabs = two players for testing).
let clientKey = session.get('hr_key');
if (!clientKey) {
  clientKey = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + Math.random().toString(36).slice(2, 10);
  session.set('hr_key', clientKey);
}

const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

// ---------------- desktop (Steam) build ----------------
// In the desktop app, preload.cjs exposes `window.hrDesktop`. The page is served by a game
// server running inside the app, and tables created here are hosted by this PC. Joining a
// friend's table goes through a Steam tunnel: `?server=<tunnel>&via=steam`.
// In the browser version `?server=` can point the page at another game server.
const desktop = window.hrDesktop || null;
const urlParams = new URLSearchParams(location.search);
const serverParam = urlParams.get('server');
const viaParam = urlParams.get('via');
const VIA_STEAM = !!desktop && viaParam === 'steam';
function resolveServer(p) {
  if (!p) return '';
  if (p === 'local') return desktop?.localServer || '';
  return p;
}
let SERVER = resolveServer(serverParam).replace(/\/$/, '');
if (SERVER === location.origin) SERVER = '';
const HOSTING_HERE = !!desktop && !SERVER; // tables made in this app are hosted by this PC
const isLocalServer = (u) => !u || /\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(u);
const PUBLIC_BASE = SERVER && !isLocalServer(SERVER) ? SERVER : location.origin;
const withServer = (qs = '') => {
  const parts = [];
  if (serverParam) parts.push(`server=${encodeURIComponent(serverParam)}`);
  if (viaParam) parts.push(`via=${encodeURIComponent(viaParam)}`);
  if (qs) parts.push(qs);
  return parts.length ? `${location.pathname}?${parts.join('&')}` : location.pathname;
};
const quality = local.get('hr_quality') || (isMobile ? 'medium' : 'high');

// ---------------- boot ----------------
await loadTileFont(); // tile faces and Chinese signage need the bundled font before drawing
buildAtlas({ corners: local.get('mj_corners') !== '0' });
const world = new World($('scene'), quality);
const sfx = new Sound();
if (local.get('hr_dev_output')) sfx.setOutput(local.get('hr_dev_output'));
sfx.sfxOn = local.get('hr_sfx') !== '0';
const app = { code: null, pid: null, room: null, state: null, lastTurnKey: '', sel: null, handKey: '', resultsKey: '' };

const view = new GameView(world, {
  sfx,
  onSeatClick: (seat) => emit('sit', { seat }),
});
view.onBanner = showBanner;
view.onTimer = (info) => {
  const el = $('turn-timer');
  if (!info) { el.classList.add('hidden'); return; }
  const secs = Math.ceil(info.left / 1000);
  el.classList.remove('hidden');
  el.classList.toggle('mine', info.mine);
  el.classList.toggle('warn', info.left < 10000 && info.left >= 5000);
  el.classList.toggle('urgent', info.left < 5000);
  el.querySelector('.tt-name').textContent = info.mine ? (info.claim ? 'Claim it?' : 'Your turn — discard a tile') : info.claim ? 'Waiting for claims…' : `${info.name} is thinking…`;
  el.querySelector('.tt-secs').textContent = info.noClock ? '' : `${secs}s`;
  el.querySelector('.tt-bar > div').style.width = info.noClock ? '100%' : `${(info.left / info.total) * 100}%`;
};
world.onResize = () => view.applyCamera(); // re-aim when rotating the phone

const socketOpts = { transports: ['websocket', 'polling'] };
const socket = SERVER ? io(SERVER, socketOpts) : io(socketOpts);
const media = new MediaManager(socket, {
  iceUrl: `${SERVER}/api/ice`,
  videoDevice: local.get('hr_dev_video') || '',
  audioDevice: local.get('hr_dev_audio') || '',
  outputDevice: local.get('hr_dev_output') || '',
  forceRelay: local.get('hr_force_relay') === '1',
  // Desktop: add the host's webcam relay as a fallback for players who can't connect directly.
  // The host reaches it locally; guests go through their own Steam tunnel port.
  buildIce: async (j) => {
    const list = [...(j.iceServers || [])];
    if (j.relay && desktop) {
      const port = VIA_STEAM ? await desktop.relayPort?.().catch(() => null) : j.relay.port;
      if (port) list.push({ urls: `turn:127.0.0.1:${port}?transport=tcp`, username: j.relay.username, credential: j.relay.credential });
    }
    return list;
  },
  onRemoteVideo: (pid, video) => { view.setVideoForPid(pid, media.isHidden(pid) ? null : video); renderTiles(); },
  onRemoteGone: (pid) => { view.setVideoForPid(pid, null); renderTiles(); },
  onLevel: (pid, level) => {
    if (media.isMuted?.(pid)) level = 0;
    view.setSpeaking(pid, level);
    if (pid === app.pid) $('self-level').style.width = `${Math.round(level * 100)}%`;
  },
  onLocalStream: (stream) => {
    const sv = $('self-video');
    if (sv.srcObject === stream) sv.srcObject = null; // same stream, new track: reload it
    sv.srcObject = stream;
    $('self-wrap').classList.toggle('hidden', !stream || !stream.getVideoTracks().length);
  },
});

setTimeout(() => { $('loading').classList.add('fade'); showLobby(); }, 350);

function emitQuiet(ev, data = {}) {
  return new Promise((resolve) => socket.emit(ev, data, (res) => resolve(res || { ok: false })));
}

function emit(ev, data = {}) {
  return new Promise((resolve) => socket.emit(ev, data, (res) => {
    if (res && !res.ok && res.error) toast(res.error);
    resolve(res || { ok: false });
  }));
}

// ---------------- lobby ----------------
function showLobby() {
  $('lobby').classList.remove('hidden');
  $('hud').classList.add('hidden');
  world.setCameraGoal(world.camera.position, world.camLook, 'lobby');
  $('name-input').value = local.get('hr_name') || String(app.steam?.name || '').slice(0, 16);
  const notice = session.get('hr_notice');
  if (notice) { session.del('hr_notice'); $('lobby-error').textContent = notice; }
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase();
  if (code) {
    $('code-input').value = code;
    // Auto-rejoin after a page refresh, or auto-join from a Steam invite.
    if (session.get('hr_room') === code && local.get('hr_name')) { joinTable(code); return; }
    if (params.get('join') === '1') { app.autoJoin = code; tryAutoJoin(); return; }
    ($('name-input').value ? $('join-btn') : $('name-input')).focus();
  } else $('name-input').focus();
}

function tryAutoJoin() {
  if (!app.autoJoin || app.code) return;
  if (!$('name-input').value.trim()) return; // waits for the Steam name (desktop) or the user
  const code = app.autoJoin;
  app.autoJoin = null;
  joinTable(code);
}

function getName() {
  const n = $('name-input').value.trim();
  if (!n) { $('lobby-error').textContent = 'Enter a name first.'; $('name-input').focus(); return null; }
  local.set('hr_name', n);
  return n;
}

$('create-btn').addEventListener('click', async () => {
  const name = getName();
  if (!name) return;
  unlockAudio();
  const res = await whileBusy($('create-btn'), 'Creating table…', () => emit('create', {
    name, key: clientKey, steamId: app.steam?.steamId,
    settings: { listed: HOSTING_HERE && $('set-listed').checked, ...lobbySettings() },
  }));
  if (res.ok) enterGame(res);
  else $('lobby-error').textContent = res.error || 'Could not create table';
});

function lobbySettings() {
  const v = (id) => Number($(id).value);
  const out = {
    rounds: v('set-rounds'), minFaan: v('set-minfaan'), startingPoints: v('set-points'), actionTime: v('set-timer'),
    unit: v('set-unit'), maxFaan: v('set-maxfaan'), bonusTiles: $('set-bonus').value === '1', sevenPairs: $('set-sevenpairs').value === '1',
  };
  local.set('mj_lobby', JSON.stringify(out));
  return out;
}
(() => { // restore the last table settings
  try {
    const o = JSON.parse(local.get('mj_lobby') || 'null');
    if (!o) return;
    const set = (id, val) => { if (val !== undefined && $(id).querySelector(`option[value="${val}"]`)) $(id).value = String(val); };
    set('set-rounds', o.rounds); set('set-minfaan', o.minFaan); set('set-points', o.startingPoints); set('set-timer', o.actionTime);
    set('set-unit', o.unit); set('set-maxfaan', o.maxFaan); set('set-bonus', o.bonusTiles ? 1 : 0); set('set-sevenpairs', o.sevenPairs ? 1 : 0);
  } catch { /* ignore */ }
})();

// Show a spinner on a lobby button until the server answers. If the server is still
// waking up, say so on the button so it never looks like nothing happened.
async function whileBusy(btn, label, fn) {
  if (btn.classList.contains('busy')) return { ok: false };
  const original = btn.innerHTML;
  const setLabel = () => { btn.textContent = socket.connected ? label : (desktop ? 'Connecting…' : 'Waking up server…'); };
  btn.classList.add('busy');
  btn.disabled = true;
  setLabel();
  const relabel = setInterval(setLabel, 500);
  $('lobby-error').textContent = '';
  try {
    return await Promise.race([
      fn(),
      new Promise((r) => setTimeout(() => r({ ok: false, error: 'The game server did not answer. Check your connection and try again.' }), 120000)),
    ]);
  } finally {
    clearInterval(relabel);
    btn.classList.remove('busy');
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// Single player: an instant table filled with bots, dealt right away.
$('solo-btn').addEventListener('click', async () => {
  const name = getName();
  if (!name) return;
  unlockAudio();
  const res = await whileBusy($('solo-btn'), 'Dealing you in…', () => emit('create', {
    name, key: clientKey,
    settings: { ...lobbySettings(), fillBots: 4, botLevel: $('solo-level').value },
  }));
  if (!res.ok) { $('lobby-error').textContent = res.error || 'Could not start a game'; return; }
  local.set('hr_solo_level', $('solo-level').value);
  enterGame(res);
  emit('start');
});
if (local.get('hr_solo_level')) $('solo-level').value = local.get('hr_solo_level');

$('join-btn').addEventListener('click', () => joinTable($('code-input').value));
$('code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinTable(e.target.value); });
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code-input').value ? joinTable($('code-input').value) : $('create-btn').click()); });

async function joinTable(code) {
  const name = getName();
  if (!name) return;
  code = String(code || '').toUpperCase().trim();
  if (code.length !== 5) { $('lobby-error').textContent = 'Table codes are 5 characters.'; return; }
  unlockAudio();
  const btn = $('join-btn');
  // Desktop: a code that isn't one of this PC's own tables is looked up on Steam.
  if (HOSTING_HERE) {
    const res = await whileBusy(btn, 'Finding table…', async () => {
      const mine = await emitQuiet('join', { code, name, key: clientKey, steamId: app.steam?.steamId });
      if (mine.ok || !app.steam?.ok) return mine;
      btn.textContent = 'Finding table on Steam…';
      const target = await desktop.findTable(code);
      if (target?.server) { goToRemoteTable(target); return { ok: false, navigating: true }; }
      return { ok: false, error: target?.error || mine.error };
    });
    if (res.ok) enterGame(res);
    else if (!res.navigating) {
      $('lobby-error').textContent = res.error || 'Could not join';
      if (!app.steam?.ok) $('lobby-error').textContent += ' (Steam isn\u2019t running, so only tables on this PC can be joined.)';
      session.del('hr_room');
    }
    return;
  }
  const res = await whileBusy(btn, 'Joining…', () => emit('join', { code, name, key: clientKey, steamId: app.steam?.steamId }));
  if (res.ok) enterGame(res);
  else {
    $('lobby-error').textContent = res.error || 'Could not join';
    session.del('hr_room');
    if (VIA_STEAM) setTimeout(() => { location.href = location.pathname; }, 3000); // back to our own lobby
  }
}

function enterGame(res) {
  app.code = res.code;
  app.pid = res.pid;
  media.setMyPid(res.pid);
  session.set('hr_room', res.code);
  history.replaceState(null, '', withServer(`room=${res.code}`));
  hostSteamLobby(res.code);
  $('lobby').classList.add('hidden');
  $('lobby-error').textContent = '';
  $('hud').classList.remove('hidden');
  $('room-code').textContent = res.code;
  if (local.get('hr_amb') !== '0') sfx.setAmbience(true);
  view.applyCamera();
}

function unlockAudio() { sfx.ensure(); media.unlockPlayback(); }
document.addEventListener('pointerdown', () => media.unlockPlayback(), { passive: true });

// ---------------- socket ----------------
socket.on('connect', () => {
  if (app.code) socket.emit('join', { code: app.code, key: clientKey, name: local.get('hr_name'), steamId: app.steam?.steamId }, (res) => {
    if (!res?.ok) { session.set('hr_notice', res?.error || 'That table has closed.'); leaveToLobby(); }
  });
});
socket.on('disconnect', () => toast('Connection lost — reconnecting…'));

// Lobby server status. The online server sleeps when idle and can take up to a minute to
// wake, so show that clearly instead of letting buttons look dead.
const serverStatus = (() => {
  const el = $('server-status');
  const text = el.querySelector('.ss-text');
  const remote = !!SERVER && !isLocalServer(SERVER);
  let since = Date.now();
  let failed = false;
  const set = (cls, msg) => { el.className = `server-status ${cls}`; text.textContent = msg; };
  function tick() {
    if (desktop) {
      if (VIA_STEAM) return socket.connected ? set('online', 'Connected to the host through Steam') : set('waking', 'Connecting to the host through Steam…');
      if (!app.steam) return set('connecting', 'Checking Steam…');
      if (app.steam.ok) return set('online', `Signed in to Steam as ${app.steam.name} — you host your own tables, friends join through Steam`);
      return set('offline', 'Steam isn\u2019t running — you can play here, but friends can\u2019t join until Steam is open');
    }
    if (socket.connected) return set('online', remote ? 'Game server online' : 'Ready');
    const secs = Math.round((Date.now() - since) / 1000);
    if (!remote) return set(failed ? 'offline' : 'connecting', failed ? 'Cannot reach the game server.' : 'Starting…');
    if (secs < 3 && !failed) return set('connecting', 'Connecting to the game server…');
    if (secs > 150) return set('offline', 'Still can’t reach the game server — check your internet connection.');
    set('waking', `Waking up the game server… ${secs}s (this can take up to a minute after it’s been idle)`);
  }
  setInterval(tick, 1000);
  tick();
  return {
    connected() { failed = false; tick(); },
    lost() { since = Date.now(); tick(); },
    error() { failed = true; tick(); },
  };
})();
socket.on('connect_error', () => serverStatus.error());
socket.on('connect', () => serverStatus.connected());
socket.on('disconnect', () => serverStatus.lost());

socket.on('room', (room) => {
  app.room = room;
  view.setRoom(room, app.pid);
  media.syncMembers(room.members);
  if ($('bots-dialog').open) renderBotsDialog();
  if ($('players-dialog').open) renderPlayers();
  publishTable();
  view.rebindVideos(media.videoMap());
  updateHUD();
  renderTiles();
});

socket.on('state', (s) => {
  // Convert server deadline to local clock.
  s.deadline = s.deadline ? s.deadline - s.serverNow + Date.now() : 0;
  const wasMine = !!app.state?.you.legal;
  const prevHand = app.state?.table.handNumber;
  app.state = s;
  if (prevHand !== s.table.handNumber) { app.sel = null; app.handKey = ''; }
  view.applyState(s);
  view.rebindVideos(media.videoMap());
  if (!wasMine && s.you.legal) {
    sfx.play('turn');
    if (padStyle) pad.rumble(140, 0.4, 0.25);
  }
  updateHUD();
});

socket.on('events', (events) => {
  view.handleEvents(events);
  for (const e of events) {
    if (e.type === 'win') {
      const items = (e.items || []).map((i) => i.name).join(', ');
      addChat({ system: true, text: `${e.name} won${e.selfDrawn ? ' (self-drawn)' : ''} — ${e.faan} faan${e.limit ? ' (limit)' : ''}${items ? `: ${items}` : ''}.` });
    } else if (e.type === 'drawGame') addChat({ system: true, text: 'Draw game — the wall ran out.' });
  }
});

socket.on('chat', (m) => { addChat(m); if (!m.system && m.pid !== app.pid) sfx.play('chat'); });
socket.on('chatHistory', (list) => { $('chat-log').innerHTML = ''; list.forEach(addChat); });
socket.on('toast', toast);
socket.on('reaction', ({ pid, emoji }) => {
  const seat = app.state?.table.seats.findIndex((s) => s && s.id === pid);
  if (seat >= 0) view.showReaction(seat, emoji);
  if (pid === app.pid && seat === app.state?.you.seat) toast(`You reacted ${emoji}`);
});

// ---------------- HUD ----------------
const ROUND_NAME = ['East', 'South', 'West', 'North'];
const tileEl = (k, cls = '') => `<span class="mj-tile ${cls}" style="${tileCss(k)}" title="${k >= 0 ? tileName(k) : ''}"></span>`;

function updateHUD() {
  const s = app.state, room = app.room;
  if (!s || !room) return;
  const t = s.table, you = s.you;
  const me = you.seat >= 0 ? t.seats[you.seat] : null;

  // Host controls
  $('host-controls').classList.toggle('hidden', !you.isHost);
  $('start-btn').classList.toggle('hidden', room.running);
  $('pause-btn').classList.toggle('hidden', !room.running);

  // Status line
  const seated = t.seats.filter(Boolean).length;
  let status = '';
  if (you.seat < 0) status = '\u{1F440} Watching — you’ll get a seat when a bot’s seat frees up';
  else if (!room.running) status = you.isHost ? (seated < 4 ? 'Share the code, or add bots (Bots…) to fill the table' : 'Ready when you are — hit “Start game”') : 'Waiting for the host to start';
  else if (t.gameOver) status = 'Game over — a new game starts shortly';
  else if (t.phase === 'idle') status = seated < 4 ? 'Waiting for four players…' : 'Washing the tiles…';
  else status = `Game ${t.gameNumber} · Hand ${t.handNumber}`;
  $('status-line').textContent = status;

  // Round / wall info
  $('table-info').classList.add('hidden');
  if (t.wallTotal && t.gameActive && t.phase !== 'idle') {
    const dealer = t.seats[t.dealer]?.name || '';
    $('status-line').innerHTML = `<b class="round-wind">${WIND_CHAR[t.roundWind]}</b> ${ROUND_NAME[t.roundWind]} round · Hand ${t.handNumber} · Dealer ${escapeHtml(dealer)} · <span class="wall-left">${t.wallLeft} tiles left</span>`;
  }

  // My info
  $('my-info').classList.toggle('hidden', !me);
  if (me) {
    $('my-stack').textContent = `${fmt(me.points)} pts`;
    const w = $('my-wind');
    w.textContent = t.handNumber ? WIND_CHAR[me.wind] : '';
    w.title = `You are ${WIND_EN[me.wind]}${me.wind === 0 ? ' (dealer)' : ''}`;
    w.classList.toggle('dealer', me.wind === 0);
    $('sitout-btn').textContent = you.sittingOut ? "I'm back" : 'Sit out';
  }
  renderHand();
  renderActions();
  renderResults();
  renderTablePanel();
}

function escapeHtml(x) { return String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- table panel: everyone's discards and melds, readable on any screen ----------
const SIDE = ['You', 'Right', 'Across', 'Left']; // relative to your seat
app.panelOpen = local.get('mj_panel') !== '0';
app.callout = local.get('mj_callout') !== '0';
$('callout-toggle').checked = app.callout;
$('callout-toggle').addEventListener('change', (e) => { app.callout = e.target.checked; local.set('mj_callout', e.target.checked ? '1' : '0'); });
$('tp-toggle').addEventListener('click', () => {
  app.panelOpen = !app.panelOpen;
  local.set('mj_panel', app.panelOpen ? '1' : '0');
  app.panelKey = '';
  renderTablePanel();
});

// How many copies of a kind you can see: table discards and melds plus your own tiles.
function visibleCount(k) {
  const s = app.state;
  let n = s.you.hand.filter((x) => x === k).length;
  for (const p of s.table.seats) {
    if (!p) continue;
    n += p.discards.filter((x) => x === k).length;
    for (const m of p.melds) if (!(m.concealed && m.type === 'kong' && p.id !== app.pid)) n += m.tiles.filter((x) => x === k).length;
  }
  return Math.min(4, n);
}

function renderTablePanel() {
  const s = app.state;
  const t = s?.table;
  const panel = $('table-panel');
  const live = t && t.wallTotal && (t.phase === 'turn' || t.phase === 'claim' || t.phase === 'robkong' || t.phase === 'over');
  panel.classList.toggle('hidden', !live);
  if (!live) { app.panelKey = ''; return; }
  const focus = app.sel;
  const ld = t.lastDiscard;
  const key = JSON.stringify([app.panelOpen, focus, ld, t.seats.map((p) => p && [p.name, p.wind, p.discards, p.melds.map((m) => m.tiles), p.points])]);
  if (key === app.panelKey) return;
  app.panelKey = key;
  panel.classList.toggle('collapsed', !app.panelOpen);
  $('tp-toggle').setAttribute('aria-expanded', String(app.panelOpen));
  const total = t.seats.reduce((a, p) => a + (p ? p.discards.length : 0), 0);
  $('tp-count').textContent = `${total} discards`;
  if (!app.panelOpen) { $('tp-body').innerHTML = ''; return; }
  const me = s.you.seat >= 0 ? s.you.seat : 0;
  const order = [3, 2, 1, 0].map((d) => (me + d) % 4); // left, across, right, you
  const mark = (k) => (focus !== null && k === focus ? ' match' : '');
  $('tp-body').innerHTML = order.map((seat) => {
    const p = t.seats[seat];
    if (!p) return '';
    const rel = SIDE[(seat - me + 4) % 4];
    const turn = t.toAct === seat ? ' acting' : '';
    const melds = p.melds.map((m) => `<span class="tp-meld">${m.tiles.map((k, i) => {
      const hidden = m.concealed && (i === 0 || i === 3);
      return tileEl(hidden ? -1 : k, (hidden ? 'back' : '') + mark(k));
    }).join('')}</span>`).join('');
    const disc = p.discards.map((k, i) => {
      const last = ld && ld.seat === seat && i === p.discards.length - 1;
      return tileEl(k, `${last ? 'last' : ''}${mark(k)}`);
    }).join('');
    return `<div class="tp-row${turn}${seat === s.you.seat ? ' mine' : ''}">
      <div class="tp-head"><span class="tp-wind${p.wind === 0 ? ' dealer' : ''}">${WIND_CHAR[p.wind]}</span><b>${escapeHtml(seat === s.you.seat ? 'You' : p.name)}</b><span class="tp-rel">${seat === s.you.seat ? '' : rel}</span><span class="tp-pts">${fmt(p.points)}</span></div>
      ${melds ? `<div class="tp-melds">${melds}</div>` : ''}
      <div class="tp-disc">${disc || '<span class="tp-none">no discards yet</span>'}</div>
    </div>`;
  }).join('');
}

// A big, brief look at each discard as it lands.
let calloutTimer;
function showDiscardCallout(e) {
  if (!app.callout || !app.state) return;
  const p = app.state.table.seats[e.seat];
  const el = $('discard-callout');
  const mine = e.seat === app.state.you.seat;
  el.innerHTML = `${tileEl(e.tile)}<span><b>${escapeHtml(mine ? 'You' : p?.name || '')}</b> discarded<br>${tileName(e.tile)}</span>`;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => el.classList.remove('show'), 1900);
}
view.onDiscard = showDiscardCallout;

// ---------- your tiles ----------
function myTiles() {
  const s = app.state;
  const hand = s.you.hand.slice().sort((a, b) => a - b);
  const drawn = s.you.drawn;
  if (drawn !== null && drawn !== undefined && hand.includes(drawn) && hand.length % 3 === 2) {
    hand.splice(hand.indexOf(drawn), 1);
    return { hand, drawn };
  }
  return { hand, drawn: null };
}

function renderHand() {
  const s = app.state;
  const t = s.table;
  const me = s.you.seat >= 0 ? t.seats[s.you.seat] : null;
  const bar = $('hand-bar');
  const live = me && me.inHand && t.phase !== 'idle' && s.you.hand.length;
  bar.classList.toggle('hidden', !live);
  if (!live) { $('my-hint').innerHTML = ''; app.handKey = ''; return; }
  const legal = s.you.legal;
  const canDiscard = legal?.type === 'turn';
  const { hand, drawn } = myTiles();
  const melds = me.melds;
  const key = JSON.stringify([hand, drawn, melds.map((m) => m.tiles), me.bonus, canDiscard, app.sel, app.hints, t.phase, app.sel !== null ? visibleCount(app.sel) : 0]);
  if (key === app.handKey) return;
  const fresh = !app.handKey;
  app.handKey = key;

  // Which discards leave you ready, and what you'd wait on.
  const readyAfter = new Map();
  if (app.hints && canDiscard) {
    const all = drawn !== null ? [...hand, drawn] : hand;
    for (const k of new Set(all)) {
      const rest = all.slice(); rest.splice(rest.indexOf(k), 1);
      const w = handWaits(rest, melds.length, t.rules);
      if (w.length) readyAfter.set(k, w);
    }
  }
  if (app.sel !== null && !(drawn === app.sel || hand.includes(app.sel))) app.sel = null;

  const box = $('my-hand');
  box.classList.toggle('can-discard', canDiscard);
  const html = [];
  const one = (k, cls) => {
    const ready = readyAfter.has(k);
    const tip = `${tileName(k)}${ready ? ` — discard to be ready (waiting on ${readyAfter.get(k).map(tileName).join(', ')})` : ''}`;
    html.push(`<button type="button" class="mj-tile ${cls}${app.sel === k ? ' sel' : ''}${ready ? ' ready' : ''}" data-k="${k}" style="${tileCss(k)}" title="${tip}" aria-label="${tip}"></button>`);
  };
  hand.forEach((k) => one(k, ''));
  if (drawn !== null) one(drawn, 'drawn');
  box.innerHTML = html.join('');
  if (fresh) {
    box.classList.remove('deal'); void box.offsetWidth; box.classList.add('deal');
    clearTimeout(app.dealAnim);
    app.dealAnim = setTimeout(() => box.classList.remove('deal'), 700);
  }

  $('my-melds').innerHTML = melds.map((m) => `<span class="meld">${m.tiles.map((k, i) => tileEl(m.concealed && (i === 0 || i === 3) ? -1 : k, m.concealed && (i === 0 || i === 3) ? 'back' : '')).join('')}</span>`).join('');
  $('my-bonus').innerHTML = me.bonus.map((k) => tileEl(k)).join('');

  // Not your turn: show what you're waiting on.
  let hint = '';
  if (app.hints && !canDiscard && hand.length % 3 === 1) {
    const w = handWaits(hand, melds.length, t.rules);
    if (w.length) hint = `Ready! Waiting on ${w.map((k) => tileEl(k)).join('')}`;
    else {
      const sh = shanten(hand, melds.length, t.rules);
      hint = sh === 1 ? '1 tile from ready' : '';
    }
  } else if (canDiscard) hint = '<span class="discard-hint">Tap a tile to discard</span>';
  if (app.sel !== null) {
    const seen = visibleCount(app.sel);
    hint = `${tileEl(app.sel)} <span class="seen">${seen} of 4 visible \u00b7 ${4 - seen} unseen</span>${canDiscard ? ' <span class="discard-hint">tap again to discard</span>' : ''}`;
  }
  $('my-hint').innerHTML = hint;
}

$('my-hand').addEventListener('click', (e) => {
  const b = e.target.closest('.mj-tile');
  if (!b) return;
  const k = Number(b.dataset.k);
  const legal = app.state?.you.legal;
  if (legal?.type !== 'turn') { app.sel = app.sel === k ? null : k; app.handKey = ''; renderHand(); return; }
  if (app.quick || app.sel === k) { discardTile(k); return; }
  app.sel = k;
  app.handKey = '';
  renderHand();
});
$('my-hand').addEventListener('dblclick', (e) => {
  const b = e.target.closest('.mj-tile');
  if (b && app.state?.you.legal?.type === 'turn') discardTile(Number(b.dataset.k));
});

function moveSel(dir) {
  const s = app.state;
  if (!s || !s.you.hand.length) return;
  const { hand, drawn } = myTiles();
  const order = drawn !== null ? [...hand, drawn] : hand;
  let i = app.sel === null ? (dir > 0 ? -1 : order.length) : order.lastIndexOf(app.sel);
  i = Math.max(0, Math.min(order.length - 1, i + dir));
  app.sel = order[i];
  app.handKey = '';
  renderHand();
}

let acting = false;
async function sendAct(action, data = {}) {
  if (acting) return;
  acting = true;
  try { await emit('act', { action, ...data }); } finally { acting = false; }
}

function discardTile(k) {
  if (app.state?.you.legal?.type !== 'turn') return;
  app.sel = null;
  sendAct('discard', { tile: k });
}

// ---------- claim / turn buttons ----------
function renderActions() {
  const s = app.state;
  const legal = s?.you.legal;
  const bar = $('action-bar');
  const btns = [];
  let claimHtml = '';
  if (legal && (legal.type === 'claim' || legal.type === 'robkong')) {
    const from = s.table.seats[legal.from]?.name || '';
    claimHtml = `${tileEl(legal.tile)}<span>${escapeHtml(from)} ${legal.type === 'robkong' ? 'is adding to a kong' : 'discarded'}</span>`;
    if (legal.win) btns.push({ a: 'win', cls: 'win', html: legal.win.ok ? `Mahjong! <small>${legal.win.faan} faan</small>` : `Mahjong <small>${legal.win.faan}/${s.table.rules.minFaan} faan</small>`, disabled: !legal.win.ok });
    if (legal.kong) btns.push({ a: 'kong', cls: 'kong', html: 'Kong' });
    if (legal.pung) btns.push({ a: 'pung', cls: 'pung', html: 'Pung' });
    for (const ch of legal.chows || []) {
      const tiles = [ch[0], ch[1], legal.tile].sort((a, b) => a - b);
      btns.push({ a: 'chow', cls: 'chow', data: { tiles: ch }, html: `Chow ${tiles.map((k) => tileEl(k)).join('')}` });
    }
    btns.push({ a: 'pass', cls: 'pass', html: 'Pass' });
  } else if (legal?.type === 'turn') {
    if (legal.win) btns.push({ a: 'win', cls: 'win', html: legal.win.ok ? `Mahjong! <small>self-drawn · ${legal.win.faan} faan</small>` : `Mahjong <small>${legal.win.faan}/${s.table.rules.minFaan} faan</small>`, disabled: !legal.win.ok });
    for (const k of legal.kongs || []) btns.push({ a: 'kong', cls: 'kong', data: { tile: k }, html: `Kong ${tileEl(k)}` });
  }
  const show = btns.length > 0;
  bar.classList.toggle('hidden', !show);
  bar.classList.toggle('my-turn', show);
  document.body.classList.toggle('my-turn', !!legal);
  const key = JSON.stringify([claimHtml, btns.map((b) => [b.a, b.html, b.disabled])]);
  if (key === app.actionsKey) return;
  app.actionsKey = key;
  $('claim-tile').innerHTML = claimHtml;
  const row = $('action-btns');
  row.textContent = '';
  for (const b of btns) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `act ${b.cls}`;
    el.innerHTML = b.html;
    el.disabled = !!b.disabled;
    if (b.disabled) el.title = `Your hand only scores ${app.state.you.legal.win.faan} faan; this table needs ${app.state.table.rules.minFaan}.`;
    el.dataset.action = b.a;
    el.addEventListener('click', () => sendAct(b.a, b.data || {}));
    row.append(el);
  }
}

// Keyboard / controller shortcut for an action button (first match).
function clickAction(a) {
  const el = [...$('action-btns').querySelectorAll('button')].find((b) => b.dataset.action === a && !b.disabled);
  if (el) { el.click(); return true; }
  return false;
}

// ---------- results ----------
function renderResults() {
  const s = app.state;
  const t = s.table;
  const box = $('results');
  const r = t.results;
  const showGame = t.gameOver && t.gameResults;
  if (!showGame && !(r && t.phase === 'over')) {
    if (!box.classList.contains('hidden')) box.classList.add('hidden');
    app.resultsKey = '';
    return;
  }
  const key = JSON.stringify([t.handNumber, t.gameNumber, !!showGame, r?.type]);
  if (key === app.resultsKey) return;
  app.resultsKey = key;
  const q = (c) => box.querySelector(c);
  box.classList.remove('hidden', 'me');
  void box.offsetWidth;
  if (showGame) {
    const st = t.gameResults;
    q('.r-title').textContent = `${st[0].name} wins the game!`;
    q('.r-sub').textContent = 'Final points';
    q('.r-hand').innerHTML = '';
    q('.r-faan').innerHTML = '';
    q('.r-pay').innerHTML = `<div class="r-stand">${st.map((p, i) => `<span class="${i ? '' : 'first'}">${i + 1}.</span><span class="${i ? '' : 'first'}">${escapeHtml(p.name)}</span><span class="${i ? '' : 'first'}">${fmt(p.points)}</span>`).join('')}</div>`;
    q('.r-foot').textContent = 'A new game starts in a few seconds — points reset.';
    box.classList.toggle('me', st[0].seat === s.you.seat);
    return;
  }
  if (r.type === 'draw') {
    q('.r-title').textContent = 'Draw game';
    q('.r-sub').textContent = 'The wall ran out with no winner. The dealer deals again.';
    q('.r-hand').innerHTML = q('.r-faan').innerHTML = q('.r-pay').innerHTML = '';
    q('.r-foot').textContent = '';
    return;
  }
  const winner = t.seats[r.winner];
  const from = r.from !== null && r.from !== undefined ? t.seats[r.from]?.name : null;
  q('.r-title').textContent = r.winner === s.you.seat ? 'You win!' : `${winner?.name || 'Someone'} wins!`;
  q('.r-sub').textContent = r.selfDrawn ? 'Self-drawn — everyone pays' : r.robbingKong ? `Robbed ${from}’s kong` : `On ${from}’s discard — ${from} pays`;
  // Winning hand: melds, then the concealed tiles with the winning tile marked.
  const concealed = r.hand.slice();
  let winMarked = false;
  const groups = [
    ...r.melds.map((m) => `<span class="grp">${m.tiles.map((k) => tileEl(k)).join('')}</span>`),
    `<span class="grp">${concealed.map((k) => { const w = !winMarked && k === r.tile; if (w) winMarked = true; return tileEl(k, w ? 'win' : ''); }).join('')}</span>`,
  ];
  if (r.bonus.length) groups.push(`<span class="grp">${r.bonus.map((k) => tileEl(k)).join('')}</span>`);
  q('.r-hand').innerHTML = groups.join('');
  q('.r-faan').innerHTML = r.items.map((i) => `<span>${escapeHtml(i.name)}</span><span>${i.faan}</span>`).join('')
    + `<span class="tot">Total${r.limit ? ' (limit)' : ''}</span><span class="tot">${r.faan} faan</span>`;
  q('.r-pay').innerHTML = r.delta.map((d, i) => (t.seats[i] && d ? `<span>${escapeHtml(t.seats[i].name)} <span class="${d > 0 ? 'plus' : 'minus'}">${d > 0 ? '+' : ''}${fmt(d)}</span></span>` : '')).join('');
  q('.r-foot').textContent = '';
  box.classList.toggle('me', r.winner === s.you.seat);
}

// ---------- scoring help ----------
const FAAN_HELP = [
  ['Situations', null],
  ['Self-drawn win', 1], ['Concealed hand (no claimed sets)', 1], ['Win on the last tile / last discard', 1], ['Win on a kong replacement', 1], ['Robbing a kong', 1],
  ['Bonus tiles', null],
  ['No flowers or seasons', 1], ['Your seat’s flower / season (each)', 1], ['All four flowers / all four seasons', 2],
  ['Sets', null],
  ['Pung of dragons (each)', 1], ['Pung of your seat wind', 1], ['Pung of the round wind', 1], ['All Chows', 1], ['Mixed Terminals (only 1s, 9s and honors)', 1],
  ['All Pungs', 3], ['Mixed One Suit (one suit + honors)', 3], ['Small Three Dragons', 5], ['Pure One Suit', 7], ['Great Three Dragons', 8],
  ['Limit hands (table maximum)', null],
  ['Thirteen Orphans · Four Concealed Pungs · All Honors · All Terminals · Great / Small Four Winds · Four Kongs · Nine Gates · Heavenly / Earthly Hand', 'max'],
];
function renderFaanTable() {
  const st = app.room?.settings;
  const rows = FAAN_HELP.slice();
  if (st?.sevenPairs) rows.splice(rows.findIndex((r) => r[0] === 'All Pungs'), 0, ['Seven Pairs (house rule)', 4]);
  $('faan-table').innerHTML = rows.map(([n, f]) => (f === null ? `<span class="h">${n}</span>` : `<span>${n}</span><span>${f === 'max' ? (st?.maxFaan ?? 10) : f}</span>`)).join('')
    + `<span class="h">This table</span><span>Minimum to win</span><span>${st?.minFaan ?? 3}</span><span>Limit</span><span>${st?.maxFaan ?? 10}</span>`;
}
for (const id of ['help-btn', 'lobby-rules-btn']) {
  $(id).addEventListener('click', () => { $('menu').classList.add('hidden'); renderFaanTable(); $('help-dialog').showModal(); });
}

$('sitout-btn').addEventListener('click', () => emit('sitout', { value: !app.state?.you.sittingOut }));
$('start-btn').addEventListener('click', () => emit('start'));
$('pause-btn').addEventListener('click', () => emit('pause'));
$('stand-btn').addEventListener('click', () => { emit('stand'); $('menu').classList.add('hidden'); });
$('leave-btn').addEventListener('click', async () => {
  await emit('leave');
  leaveToLobby();
});

function leaveToLobby() {
  app.code = null; app.state = null; app.room = null;
  session.del('hr_room');
  media.closeAll();
  resetMediaUI();
  sfx.setAmbience(false);
  desktop?.leaveTable();
  if (VIA_STEAM) { location.href = location.pathname; return; } // back to our own server
  history.replaceState(null, '', withServer());
  location.reload(); // cleanest way to reset the 3D table
}

// ---------------- bots (host) ----------------
const LEVEL_NAME = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
function renderBotsDialog() {
  const room = app.room;
  if (!room) return;
  const list = $('bot-list');
  list.textContent = '';
  const bots = room.members.filter((m) => m.bot);
  if (!bots.length) {
    const e = document.createElement('div');
    e.className = 'bot-empty';
    e.textContent = 'No bots yet.';
    list.append(e);
  }
  for (const b of bots) {
    const row = document.createElement('div');
    row.className = 'bot-row';
    const nm = document.createElement('span'); nm.className = 'br-name'; nm.textContent = `\u{1F916} ${b.name}`;
    const lv = document.createElement('span'); lv.className = 'br-level'; lv.textContent = LEVEL_NAME[b.bot] || b.bot;
    row.append(nm, lv);
    if (b.botAuto) { const a = document.createElement('span'); a.className = 'br-auto'; a.textContent = 'auto'; row.append(a); }
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'btn small ghost'; rm.textContent = 'Remove';
    rm.addEventListener('click', () => emit('removeBot', { pid: b.pid }));
    row.append(rm);
    list.append(row);
  }
  const fill = room.settings.fillBots || 0;
  $('bot-fill').value = String(fill);
  $('bot-fill-level').value = room.settings.botLevel || 'medium';
  $('bot-fill-level').disabled = !fill;
  const seated = app.state ? app.state.table.seats.filter(Boolean).length : 0;
  $('bot-add').disabled = seated >= 4;
}
$('bots-btn').addEventListener('click', () => { renderBotsDialog(); $('bots-dialog').showModal(); });
$('bot-add').addEventListener('click', () => emit('addBot', { level: $('bot-add-level').value }));
const sendFill = () => emit('botFill', { count: Number($('bot-fill').value), level: $('bot-fill-level').value });
$('bot-fill').addEventListener('change', sendFill);
$('bot-fill-level').addEventListener('change', sendFill);

$('table-rules-btn').addEventListener('click', () => {
  const d = $('rules-dialog');
  const st = app.room?.settings || {};
  const set = (id, v) => { $(id).value = String(v); };
  set('r-minfaan', st.minFaan ?? 3); set('r-maxfaan', st.maxFaan ?? 10); set('r-rounds', st.rounds ?? 1); set('r-unit', st.unit ?? 10);
  set('r-bonus', st.bonusTiles === false ? 0 : 1); set('r-sevenpairs', st.sevenPairs ? 1 : 0); set('r-timer', st.actionTime ?? 20); set('r-claim', st.claimTime ?? 8);
  d.showModal();
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const v = (id) => Number($(id).value);
    emit('settings', { minFaan: v('r-minfaan'), maxFaan: v('r-maxfaan'), rounds: v('r-rounds'), unit: v('r-unit'), bonusTiles: v('r-bonus') === 1, sevenPairs: v('r-sevenpairs') === 1, actionTime: v('r-timer'), claimTime: v('r-claim') });
  };
});

$('copy-link').addEventListener('click', async () => {
  if (desktop) {
    // A real link: the web page opens steam://joinlobby/…, which starts the game (or tells the
    // running game) and drops the friend straight into this table. The code works as a backup.
    const inv = await desktop.inviteInfo?.().catch(() => null);
    let text; let note;
    if (inv?.lobbyId) {
      const q = new URLSearchParams({ c: app.code, a: String(inv.appId), l: inv.lobbyId, h: inv.steamId || '' });
      const steamUrl = `steam://joinlobby/${inv.appId}/${inv.lobbyId}${inv.steamId ? `/${inv.steamId}` : ''}`;
      const link = inv.base ? `${inv.base}?${q}` : steamUrl;
      // Just the link, so it works pasted anywhere (chat or a browser's address bar); the page
      // itself shows the table code as a backup.
      text = link;
      note = `Invite link copied (table code ${app.code}) — friends click it to join through Steam`;
    } else {
      text = `Join my High Roller Mahjong table on Steam: open the game, then Join table with code ${app.code}`;
      note = `Invite copied — friends enter code ${app.code} in the game`;
    }
    try { await navigator.clipboard.writeText(text); toast(note, 4500); }
    catch { toast(`Table code: ${app.code}`); }
    return;
  }
  const url = `${PUBLIC_BASE}/?room=${app.code}`;
  try {
    if (navigator.share && isMobile) await navigator.share({ title: 'High Roller Mahjong', text: `Join my mahjong table! Code ${app.code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied — send it to your friends!'); }
  } catch { toast(`Share this link: ${url}`); }
});

// Camera view
const CAMS = ['seat', 'overhead', 'orbit'];
function setCam(v) {
  view.setCameraView(v);
  document.querySelectorAll('#cam-seg button').forEach((b) => b.classList.toggle('active', b.dataset.cam === v));
  if (v === 'orbit') toast('Free camera: drag to orbit, scroll to zoom');
}
document.querySelectorAll('#cam-seg button').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));
$('cam-cycle').addEventListener('click', () => {
  const next = CAMS[(CAMS.indexOf(view.camView) + 1) % CAMS.length];
  setCam(next);
  toast({ seat: 'Seated view', overhead: 'Overhead view', orbit: 'Free camera: drag to orbit, pinch to zoom' }[next]);
});

// Menu
$('menu-btn').addEventListener('click', () => $('menu').classList.toggle('hidden'));
$('quality-select').value = quality;
$('quality-select').addEventListener('change', (e) => { local.set('hr_quality', e.target.value); world.setQuality(e.target.value); });
// Realistic players: on by default except on phones / Low graphics (they're ~7 MB and heavier to draw).
const peopleOn = () => { const v = local.get('hr_people'); return v ? v === '1' : !isMobile && quality !== 'low'; };
$('people-toggle').checked = peopleOn();
view.setRealisticPeople($('people-toggle').checked);
$('people-toggle').addEventListener('change', (e) => { local.set('hr_people', e.target.checked ? '1' : '0'); view.setRealisticPeople(e.target.checked); });
$('sfx-toggle').checked = sfx.sfxOn;
$('sfx-toggle').addEventListener('change', (e) => { sfx.sfxOn = e.target.checked; local.set('hr_sfx', e.target.checked ? '1' : '0'); });
$('amb-toggle').checked = local.get('hr_amb') !== '0';
$('amb-toggle').addEventListener('change', (e) => { sfx.setAmbience(e.target.checked); local.set('hr_amb', e.target.checked ? '1' : '0'); });
// Tile readability and helpers.
$('corners-toggle').checked = local.get('mj_corners') !== '0';
$('corners-toggle').addEventListener('change', (e) => { local.set('mj_corners', e.target.checked ? '1' : '0'); buildAtlas({ corners: e.target.checked }); });
app.hints = local.get('mj_hints') !== '0';
$('hints-toggle').checked = app.hints;
$('hints-toggle').addEventListener('change', (e) => { app.hints = e.target.checked; local.set('mj_hints', e.target.checked ? '1' : '0'); app.handKey = ''; updateHUD(); });
app.quick = local.get('mj_quick') === '1';
$('quick-toggle').checked = app.quick;
$('quick-toggle').addEventListener('change', (e) => { app.quick = e.target.checked; local.set('mj_quick', e.target.checked ? '1' : '0'); });
$('tiles-toggle').addEventListener('change', (e) => { $('tiles').classList.toggle('hidden', !e.target.checked); renderTiles(); });
$('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
});
let lastFrames = 0;
setInterval(() => {
  const f = (world.totalFrames || 0) - lastFrames;
  lastFrames = world.totalFrames || 0;
  $('fps').textContent = `${f} fps · ${Math.round(world.renderer.getPixelRatio() * 100)}% res · GPU: ${world.gpuName}`;
}, 1000);
if (world.softwareGL) {
  setTimeout(() => toast('Your browser is drawing 3D without the graphics card. Turn on hardware acceleration in your browser settings for smooth play (⚙ menu shows the GPU in use).', 12000), 1500);
}

// Keyboard shortcuts: ←/→ pick a tile, Enter/Space/D discard, W/H win, P pung, K kong, C chow, X/Esc pass.
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const legal = app.state?.you.legal;
  if (k === 'arrowleft' || k === 'arrowright') { moveSel(k === 'arrowleft' ? -1 : 1); e.preventDefault(); }
  else if ((k === 'enter' || k === ' ' || k === 'd') && legal?.type === 'turn' && app.sel !== null) { discardTile(app.sel); e.preventDefault(); }
  else if (k === 'w' || k === 'h') clickAction('win');
  else if (k === 'p') clickAction('pung');
  else if (k === 'k') clickAction('kong');
  else if (k === 'c') clickAction('chow');
  else if (k === 'x' || k === 'escape') clickAction('pass');
  else if (k === 'v') setCam(CAMS[(CAMS.indexOf(view.camView) + 1) % CAMS.length]);
  else if (k === 'enter' && app.code) { $('chat-input').focus(); e.preventDefault(); }
});

// Chat + reactions
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (text) emit('chat', { text });
  $('chat-input').value = '';
  $('chat-input').blur();
});
document.querySelectorAll('.reactions button').forEach((b) => b.addEventListener('click', () => socket.emit('reaction', { emoji: b.dataset.emoji })));

function addChat(m) {
  const log = $('chat-log');
  const div = document.createElement('div');
  if (m.system) { div.className = 'sys'; div.textContent = m.text; }
  else {
    const who = document.createElement('span');
    who.className = 'who';
    const member = app.room?.members.find((x) => x.pid === m.pid);
    who.style.color = ['#ff8a80', '#82b1ff', '#8be0a8', '#d1a3ff', '#ffcf7a', '#7fe3ee', '#ff9ccf', '#cfcfcf'][member ? member.color % 8 : 0];
    who.textContent = m.name;
    div.append(who, document.createTextNode(m.text));
  }
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.appendChild(div);
  while (log.children.length > 150) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------------- media UI ----------------
$('media-start').addEventListener('click', async () => {
  try {
    unlockAudio();
    const got = await media.start({ video: true, audio: true });
    $('media-start').classList.add('hidden');
    $('media-controls').classList.remove('hidden');
    $('mic-btn').disabled = !got.mic;
    $('cam-btn').disabled = !got.cam;
    updateMediaButtons();
    if (got.cam && app.state?.you?.seat >= 0) grantAchievement('SAY_CHEESE');
    if (!got.cam) toast('No camera found — joined with microphone only.');
    else if (!got.mic) toast('No microphone found — joined with camera only.');
  } catch (err) {
    const msg = err?.name === 'NotAllowedError' ? 'Camera/mic permission was blocked. Allow it in the browser address bar and try again.' : err?.message || String(err);
    toast(msg, 6000);
  }
});
$('mic-btn').addEventListener('click', () => { media.toggleMic(); updateMediaButtons(); });
$('cam-btn').addEventListener('click', () => { media.toggleCam(); updateMediaButtons(); $('self-wrap').classList.toggle('hidden', !media.camOn); });
$('media-stop').addEventListener('click', () => { media.stop(); resetMediaUI(); });

// ---------------- camera & mic picker ----------------
const devUI = { preview: null, meter: null, timer: null };
const DEV_SELECTS = { video: 'dev-video-select', audio: 'dev-audio-select', output: 'dev-output-select' };

function fillDeviceSelect(sel, list, current) {
  sel.textContent = '';
  sel.append(new Option('System default', ''));
  for (const d of list) sel.append(new Option(d.label, d.id));
  sel.value = list.some((d) => d.id === current) ? current : '';
}

async function refreshDeviceLists() {
  const l = await media.listDevices();
  fillDeviceSelect($(DEV_SELECTS.video), l.video, media.devices.video);
  fillDeviceSelect($(DEV_SELECTS.audio), l.audio, media.devices.audio);
  $('dev-output-row').classList.toggle('hidden', !l.output);
  $('dev-test').classList.toggle('hidden', !l.output);
  if (l.output) fillDeviceSelect($(DEV_SELECTS.output), l.output, media.devices.output);
  $('dev-note').textContent = !l.labelled ? 'Device names show up once you allow camera & mic access.'
    : media.local ? 'Changes apply right away — the table sees and hears the new device.'
      : 'Used when you click “Join with camera & mic”.';
}

function stopDevicePreview() {
  devUI.preview?.getTracks().forEach((t) => t.stop());
  devUI.preview = null;
}

// Show the camera + mic level: the live shared stream if you're on camera, else a private preview.
async function showDevicePreview() {
  let stream = media.local;
  if (!stream) {
    stopDevicePreview();
    const tries = [{ video: media.videoConstraints(), audio: media.audioConstraints() }, { video: false, audio: media.audioConstraints() }, { video: media.videoConstraints(), audio: false }, { video: true, audio: true }];
    for (const c of tries) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { if (e?.name === 'NotAllowedError') { $('dev-note').textContent = 'Camera & mic access is blocked — allow it and reopen this window.'; break; } }
    }
    if (!$('devices-dialog').open) { stream?.getTracks().forEach((t) => t.stop()); return; }
    devUI.preview = stream;
  }
  const v = $('dev-video');
  v.srcObject = null; v.srcObject = stream || null;
  const hasCam = !!stream?.getVideoTracks().some((t) => t.readyState === 'live');
  $('dev-novideo').classList.toggle('hidden', hasCam);
  devUI.meter = {};
  if (stream) media.attachAnalyser(devUI.meter, stream);
  await refreshDeviceLists(); // permission granted -> real device names
}

function devLevel() {
  const m = devUI.meter;
  if (!m?.analyser) { $('dev-level').style.width = '0'; return; }
  m.analyser.getByteTimeDomainData(m.levelBuf);
  let sum = 0;
  for (const x of m.levelBuf) { const d = (x - 128) / 128; sum += d * d; }
  $('dev-level').style.width = `${Math.round(Math.min(1, Math.sqrt(sum / m.levelBuf.length) * 6) * 100)}%`;
}

function openDevices() {
  $('menu').classList.add('hidden');
  const d = $('devices-dialog');
  if (d.open) return;
  d.showModal();
  refreshDeviceLists();
  showDevicePreview();
  clearInterval(devUI.timer);
  devUI.timer = setInterval(devLevel, 80);
}

$('devices-dialog').addEventListener('close', () => {
  clearInterval(devUI.timer);
  stopDevicePreview();
  devUI.meter = null;
  $('dev-video').srcObject = null;
});

for (const [kind, id] of Object.entries(DEV_SELECTS)) {
  $(id).addEventListener('change', async (e) => {
    const value = e.target.value;
    local.set(`hr_dev_${kind}`, value);
    if (kind === 'output') { media.setDevice('output', value); sfx.setOutput(value); return; }
    try {
      if (media.local) { await media.setDevice(kind, value); updateMediaButtons(); }
      else media.devices[kind] = value;
      await showDevicePreview();
    } catch (err) {
      toast(err?.name === 'NotReadableError' ? 'That device is in use by another app.' : `Couldn't switch: ${err?.message || err}`, 5000);
      refreshDeviceLists();
    }
  });
}

// A short two-note chime on the chosen speakers.
$('dev-test').addEventListener('click', () => {
  const rate = 22050; const n = Math.floor(rate * 0.7);
  const buf = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, str) => [...str].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); buf.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true); buf.setUint32(28, rate * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true); w(36, 'data'); buf.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate; const f = t < 0.3 ? 660 : 880; const env = Math.min(1, t * 40) * Math.exp(-((t % 0.35) * 6));
    buf.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * t) * env * 0.4 * 32767, true);
  }
  const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  (a.setSinkId ? a.setSinkId(media.devices.output || '') : Promise.resolve()).catch(() => {}).finally(() => a.play().catch(() => {}));
});

$('devices-btn').addEventListener('click', openDevices);
$('media-devices').addEventListener('click', openDevices);
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if ($('devices-dialog').open) refreshDeviceLists(); });

function updateMediaButtons() {
  $('mic-btn').innerHTML = media.micOn ? '🎙<span class="lbl-long"> Mute</span>' : '🔇<span class="lbl-long"> Unmute</span>';
  $('cam-btn').innerHTML = media.camOn ? '📷<span class="lbl-long"> Camera off</span>' : '🚫<span class="lbl-long"> Camera on</span>';
}
function resetMediaUI() {
  $('media-start').classList.remove('hidden');
  $('media-controls').classList.add('hidden');
  $('self-wrap').classList.add('hidden');
}

function renderTiles() {
  const box = $('tiles');
  if (box.classList.contains('hidden') || !app.room) { box.innerHTML = ''; return; }
  const vids = media.videoMap();
  const want = app.room.members.filter((m) => m.pid !== app.pid && m.media?.cam && vids.has(m.pid));
  const have = new Map([...box.children].map((el) => [el.dataset.pid, el]));
  for (const [pid, el] of have) if (!want.find((m) => m.pid === pid)) el.remove();
  for (const m of want) {
    let el = have.get(m.pid);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile'; el.dataset.pid = m.pid;
      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      const s = document.createElement('span');
      el.append(v, s);
      box.appendChild(el);
    }
    const v = el.querySelector('video');
    const src = vids.get(m.pid).srcObject;
    if (v.srcObject !== src) { v.srcObject = src; v.play().catch(() => {}); }
    el.querySelector('span').textContent = m.name;
  }
}

// ---------------- banner / toast ----------------
let bannerTimer;
function showBanner(title, sub, isMe) {
  const b = $('banner');
  b.querySelector('.b-title').textContent = title;
  b.querySelector('.b-sub').textContent = sub || '';
  b.classList.toggle('me', !!isMe);
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 3600);
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------------- achievements ----------------
// The server tells us what we earned each hand; unlocks and running totals live on this PC
// (and on Steam in the desktop build). Steam's own popup can't draw over the game window,
// so the game shows its own.
const achUnlocked = new Set((() => { try { return JSON.parse(local.get('mj_ach') || '[]'); } catch { return []; } })());
const achStats = (() => { try { return { hands: 0, wins: 0, ...JSON.parse(local.get('mj_stats') || '{}') }; } catch { return { hands: 0, wins: 0 }; } })();
const achQueue = [];
let achShowing = false;

function grantAchievement(id) {
  const a = ACHIEVEMENT_BY_ID[id];
  if (!a) return;
  if (!achUnlocked.has(id)) {
    achUnlocked.add(id);
    local.set('mj_ach', JSON.stringify([...achUnlocked]));
    achQueue.push(a);
    showNextAchievement();
    if ($('ach-dialog').open) renderAchievements();
  }
  desktop?.unlockAchievement?.(id);
}

function showNextAchievement() {
  if (achShowing || !achQueue.length) return;
  const a = achQueue.shift();
  const el = $('ach-pop');
  el.querySelector('.ap-icon').src = `/img/ach/${a.id}.jpg`;
  el.querySelector('.ap-name').textContent = a.name;
  el.querySelector('.ap-desc').textContent = a.desc;
  achShowing = true;
  el.classList.add('show');
  sfx.play?.('win');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { achShowing = false; showNextAchievement(); }, 450);
  }, 4200);
}

socket.on('awards', ({ ids = [], stats = {} } = {}) => {
  achStats.hands += Number(stats.hands) || 0;
  achStats.wins += Number(stats.wins) || 0;
  local.set('mj_stats', JSON.stringify(achStats));
  for (const id of ids) grantAchievement(id);
  for (const a of ACHIEVEMENTS) if (a.count && achStats[a.count.stat] >= a.count.target) grantAchievement(a.id);
  if ($('ach-dialog').open) renderAchievements();
});

function renderAchievements() {
  const list = $('ach-list');
  list.textContent = '';
  $('ach-summary').textContent = `${achUnlocked.size} of ${ACHIEVEMENTS.length} unlocked · ${achStats.hands.toLocaleString()} hand${achStats.hands === 1 ? '' : 's'} played · ${achStats.wins.toLocaleString()} won`;
  for (const a of ACHIEVEMENTS) {
    const done = achUnlocked.has(a.id);
    const row = document.createElement('div');
    row.className = `ach-row${done ? ' done' : ''}`;
    const icon = document.createElement('img'); icon.className = 'ach-icon'; icon.alt = ''; icon.src = `/img/ach/${a.id}${done ? '' : '_locked'}.jpg`;
    const txt = document.createElement('div'); txt.className = 'ach-txt';
    const nm = document.createElement('div'); nm.className = 'ach-name'; nm.textContent = a.name;
    const ds = document.createElement('div'); ds.className = 'ach-desc'; ds.textContent = a.desc;
    txt.append(nm, ds);
    if (a.count && !done) {
      const n = Math.min(achStats[a.count.stat] || 0, a.count.target);
      const bar = document.createElement('div'); bar.className = 'ach-bar';
      const fill = document.createElement('div'); fill.style.width = `${(n / a.count.target) * 100}%`;
      bar.append(fill);
      const lbl = document.createElement('div'); lbl.className = 'ach-count'; lbl.textContent = `${n.toLocaleString()} / ${a.count.target.toLocaleString()}`;
      txt.append(bar, lbl);
    }
    row.append(icon, txt);
    list.append(row);
  }
}
for (const id of ['ach-btn', 'lobby-ach-btn']) {
  $(id).addEventListener('click', () => { $('menu')?.classList.add('hidden'); renderAchievements(); $('ach-dialog').showModal(); });
}

// ---------------- players panel: mute / hide camera / remove ----------------
const kickArmed = new Map();
let playersSig = '';
function renderPlayers(force = false) {
  const room = app.room;
  if (!room) return;
  const amHost = room.hostPid === app.pid;
  // Only rebuild when something shown here changed (keeps clicks and the controller highlight steady).
  const sig = JSON.stringify([room.hostPid, room.settings.listed, amHost, room.members.map((m) => [m.pid, m.name, m.bot, m.connected, m.media?.cam, m.media?.mic, media.isMuted(m.pid), media.isHidden(m.pid), kickArmed.get(m.pid) > Date.now()])]);
  if (!force && sig === playersSig) return;
  playersSig = sig;
  const focusKey = nav.current?.dataset?.key;
  $('listed-row').classList.toggle('hidden', !(amHost && HOSTING_HERE && app.steam?.ok));
  $('listed-toggle').checked = !!room.settings.listed;
  const list = $('players-list');
  list.textContent = '';
  const others = room.members.filter((m) => m.pid !== app.pid);
  if (!others.length) { const e = document.createElement('div'); e.className = 'browse-empty'; e.textContent = 'Nobody else is here yet.'; list.append(e); }
  for (const m of others) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const nm = document.createElement('div'); nm.className = 'pr-name';
    nm.textContent = m.bot ? `\u{1F916} ${m.name}` : m.name;
    const tags = document.createElement('span'); tags.className = 'pr-tags';
    tags.textContent = [m.pid === room.hostPid ? 'host' : '', m.bot ? `${m.bot} bot` : '', m.media?.cam ? 'camera on' : '', m.media?.mic ? 'mic on' : '', m.connected ? '' : 'offline'].filter(Boolean).join(' · ');
    nm.append(tags);
    row.append(nm);
    const mk = (label, on, fn, key) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn small ghost${on ? ' on' : ''}`; b.textContent = label; b.dataset.key = `${m.pid}:${key}`; b.addEventListener('click', fn); row.append(b); return b; };
    if (!m.bot) {
      const muted = media.isMuted(m.pid);
      mk(muted ? 'Unmute' : 'Mute', muted, () => { media.setBlocked(m.pid, { muted: !muted }); renderPlayers(); }, 'mute');
      const hidden = media.isHidden(m.pid);
      mk(hidden ? 'Show camera' : 'Hide camera', hidden, () => {
        media.setBlocked(m.pid, { hidden: !hidden });
        view.hiddenVideo ||= new Set();
        if (!hidden) view.hiddenVideo.add(m.pid); else view.hiddenVideo.delete(m.pid);
        view.rebindVideos(media.videoMap());
        renderTiles();
        renderPlayers();
      }, 'cam');
    }
    if (amHost) {
      const armed = kickArmed.get(m.pid) > Date.now();
      mk(m.bot ? 'Remove' : armed ? 'Confirm remove' : 'Remove', armed, async () => {
        if (!m.bot && !(kickArmed.get(m.pid) > Date.now())) { kickArmed.set(m.pid, Date.now() + 6000); renderPlayers(); setTimeout(() => $("players-dialog").open && renderPlayers(), 6100); return; }
        kickArmed.delete(m.pid);
        const res = await emit('kick', { pid: m.pid });
        if (res.ok && res.steamId) desktop?.banPeer?.(res.steamId);
      }, 'kick');
    }
    list.append(row);
  }
  if (focusKey && padStyle) { const el = list.querySelector(`[data-key="${focusKey}"]`); if (el) nav.focus(el); }
}
$('players-btn').addEventListener('click', () => { renderPlayers(true); $('players-dialog').showModal(); });
$('listed-toggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const res = await emit('listed', { on });
  if (res.ok && app.code) { desktop?.hostTable?.(app.code, on); publishTable(true); }
});
socket.on('kicked', () => {
  session.set('hr_notice', 'The host removed you from that table.');
  session.del('hr_room');
  setTimeout(() => leaveToLobby(), 200);
});

// ---------------- table browser (Steam) ----------------
async function refreshBrowser() {
  const list = $('browse-list');
  $('browse-status').textContent = 'Looking for open tables on Steam…';
  list.textContent = '';
  const res = await desktop.listTables().catch(() => ({ ok: false, tables: [] }));
  const tables = (res.tables || []).map((t) => ({ ...t, humans: +t.humans || 0, bots: +t.bots || 0, seated: +t.seated || 0, seats: +t.seats || 4 }));
  tables.sort((a, b) => b.humans - a.humans || (b.seats - b.seated > 0) - (a.seats - a.seated > 0) || b.seated - a.seated);
  $('browse-status').textContent = !res.ok ? 'Couldn\u2019t reach Steam. Is it running?' : tables.length ? `${tables.length} open table${tables.length === 1 ? '' : 's'}` : '';
  if (!tables.length) {
    const e = document.createElement('div');
    e.className = 'browse-empty';
    e.innerHTML = 'No open tables right now.<br>Create one with <b>List publicly</b> ticked and others can find you here — or play vs bots while you wait.';
    list.append(e);
    return;
  }
  for (const t of tables) {
    const row = document.createElement('div');
    row.className = `table-row${t.mine ? ' mine' : ''}`;
    const main = document.createElement('div'); main.className = 'tr-main';
    const title = document.createElement('div'); title.className = 'tr-title'; title.textContent = `${t.hostName || 'Someone'}\u2019s table${t.mine ? ' (yours)' : ''}`;
    const open = Math.max(0, t.seats - t.seated);
    const sub = document.createElement('div'); sub.className = 'tr-sub';
    const humanSeats = Math.max(0, 4 - t.humans);
    sub.textContent = `${t.humans} player${t.humans === 1 ? '' : 's'}${t.bots ? ` + ${t.bots} bot${t.bots === 1 ? '' : 's'}` : ''} · ${humanSeats || open} seat${(humanSeats || open) === 1 ? '' : 's'} for friends · min ${+t.minFaan || 0} faan · ${['', 'East round', 'East + South', '', 'Full game'][+t.rounds || 1]}`;
    main.append(title, sub);
    const st = document.createElement('span'); st.className = `tr-status${t.running === '1' ? '' : ' waiting'}`; st.textContent = t.running === '1' ? 'Playing' : 'Waiting';
    const join = document.createElement('button'); join.type = 'button'; join.className = 'btn small green'; join.textContent = 'Join';
    join.disabled = !!t.mine;
    join.addEventListener('click', async () => {
      if (!getName()) { $('browse-dialog').close(); return; }
      join.disabled = true; join.textContent = 'Joining…';
      const target = await desktop.joinLobby(t.lobbyId).catch(() => ({ error: 'Could not join that table.' }));
      if (target?.server) { $('browse-dialog').close(); goToRemoteTable(target); return; }
      join.disabled = false; join.textContent = 'Join';
      $('browse-status').textContent = target?.error || 'Could not join that table.';
    });
    row.append(main, st, join);
    list.append(row);
  }
}
$('browse-btn').addEventListener('click', () => { $('browse-dialog').showModal(); refreshBrowser(); });
$('browse-refresh').addEventListener('click', refreshBrowser);

// ---------------- controller (gamepad) ----------------
// LB/RB or D-pad left/right: pick a tile · A discard (or the first claim: Mahjong/Pung/Chow) · X pass
// Y Mahjong · B kong · D-pad up/down: move between buttons · ☰ menu · ⧉ camera · right stick: look around
let padStyle = null; // 'xbox' | 'ps' | 'nintendo' while a controller is in use
const nav = new PadNav();
const osk = new OnScreenKeyboard();
const glyph = (b) => GLYPHS[padStyle || 'xbox'][b];
function refreshHints() {
  const g = (b) => `<kbd class="pad-glyph g-${b}">${glyph(b)}</kbd>`;
  $('pad-hints').innerHTML = padStyle ? [
    [g('lb') + g('rb'), 'Pick tile'], [g('a'), 'Discard / claim'], [g('x'), 'Pass'], [g('y'), 'Mahjong'], [g('b'), 'Kong'],
  ].map(([k, t]) => `<span>${k}${t}</span>`).join('') : '';
  if (app.state) updateHUD();
}

function padLayer() {
  if (osk.open) return { type: 'osk' };
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (dlg) return { type: 'dialog', root: dlg };
  if (!$('hud').classList.contains('hidden') && !$('menu').classList.contains('hidden')) return { type: 'menu', root: $('menu') };
  if (!$('lobby').classList.contains('hidden')) return { type: 'lobby', root: $('lobby') };
  if (!$('hud').classList.contains('hidden')) return { type: 'table', root: $('hud') };
  return null;
}

function openKeyboard(input) {
  const after = {
    'chat-input': () => { $('chat-form').requestSubmit(); nav.clear(); },
    'code-input': () => nav.focus($('join-btn')),
    'name-input': () => nav.focus($('create-btn')),
  }[input.id];
  // On Steam Deck / Big Picture, Steam's own keyboard pops up over the field.
  const r = input.getBoundingClientRect();
  const steamKb = desktop?.showKeyboard?.({ x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio });
  Promise.resolve(steamKb).then((shown) => {
    if (shown) { input.focus(); return; }
    osk.show(input, { glyphs: GLYPHS[padStyle || 'xbox'], label: input.closest('label')?.querySelector('span')?.textContent || input.placeholder, onDone: after });
  });
}

// Pick the control nearest the bottom-middle of the screen when first entering the HUD.
function hudEntry() {
  const items = nav.items($('hud')).filter((el) => !el.closest('#my-hand'));
  let best = null; let bd = Infinity;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - innerWidth / 2, r.top + r.height / 2 - innerHeight * 0.8);
    if (d < bd) { bd = d; best = el; }
  }
  nav.focus(best);
}

const pad = new PadInput({
  onActive(style) {
    padStyle = style;
    document.body.classList.toggle('pad', !!style);
    if (style) document.body.dataset.pad = style; else delete document.body.dataset.pad;
    if (!style) nav.clear();
    refreshHints();
  },
  onLook(x, y) {
    if (!padStyle) return;
    world.mouse.set(x, -y);
  },
  onRelease() {},
  onPress(name) {
    const L = padLayer();
    if (!L) return;
    const dir = ['up', 'down', 'left', 'right'].includes(name) ? name : null;
    if (L.type === 'osk') { osk.handle(name); return; }

    if (L.type !== 'table') {
      if (dir) nav.move(L.root, dir);
      else if (name === 'a') { nav.ensure(L.root); nav.activate(openKeyboard); }
      else if (name === 'b' || (name === 'menu' && L.type === 'menu')) {
        if (L.type === 'dialog') L.root.close();
        else if (L.type === 'menu') $('menu').classList.add('hidden');
        nav.clear();
      } else if (name === 'menu' && L.type === 'lobby') { nav.focus($('solo-btn')); }
      return;
    }

    // At the table.
    const legal = app.state?.you.legal;
    const focused = nav.current && $('hud').contains(nav.current) && nav.current.isConnected;
    const handLive = !$('hand-bar').classList.contains('hidden');
    if ((name === 'left' || name === 'right') && handLive && !focused) { moveSel(name === 'left' ? -1 : 1); return; }
    if (dir) { if (!focused) hudEntry(); else nav.move(L.root, dir); return; }
    switch (name) {
      case 'lb': moveSel(-1); break;
      case 'rb': moveSel(1); break;
      case 'a':
        if (focused) nav.activate(openKeyboard);
        else if (legal?.type === 'turn' && app.sel !== null) discardTile(app.sel);
        else if (legal && legal.type !== 'turn') { if (!clickAction('win') && !clickAction('pung') && !clickAction('kong')) clickAction('chow'); }
        else if (legal?.type === 'turn') moveSel(1);
        else if (!$('start-btn').classList.contains('hidden') && !$('host-controls').classList.contains('hidden')) $('start-btn').click();
        break;
      case 'b': if (focused) nav.clear(); else clickAction('kong'); break;
      case 'x': clickAction('pass'); break;
      case 'y': clickAction('win'); break;
      case 'view': $('cam-cycle').click(); break;
      case 'menu': $('menu').classList.remove('hidden'); nav.focus(null); nav.ensure($('menu')); break;
      default: break;
    }
  },
});

// Interface size (bigger for Steam Deck / TV).
function applyUiScale(v) {
  document.documentElement.style.setProperty('--ui-zoom', String(v));
  $('uiscale-select').value = String(v);
}
$('uiscale-select').addEventListener('change', (e) => { local.set('hr_uiscale', e.target.value); applyUiScale(Number(e.target.value)); });
applyUiScale(Number(local.get('hr_uiscale')) || 1);

// Expose for debugging in the console.
window.__mahjong = { app, world, view, media, socket };

// ---------------- Steam integration (desktop build only) ----------------
// Tables created in the app are hosted by this PC; a Steam lobby tells friends how to reach it.
function hostSteamLobby(code) {
  if (!HOSTING_HERE || !app.steam?.ok) return;
  const listed = app.room?.settings?.listed ?? $('set-listed').checked;
  desktop.hostTable(code, listed).then(() => publishTable(true)).catch(() => {});
}

// Keep this table's details in its Steam lobby current, for the table browser.
let lastPublished = '';
let publishTimer = null;
function publishTable(now = false) {
  if (!HOSTING_HERE || !app.steam?.ok || !app.code || !app.room) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    const room = app.room; const t = app.state?.table;
    const members = room.members;
    const info = {
      hostName: (members.find((m) => m.pid === room.hostPid)?.name || app.steam.name || 'Host'),
      humans: members.filter((m) => !m.bot && m.connected).length,
      bots: members.filter((m) => m.bot).length,
      seated: t ? t.seats.filter(Boolean).length : members.filter((m) => m.seat >= 0).length,
      seats: 4,
      minFaan: room.settings.minFaan,
      rounds: room.settings.rounds,
      points: room.settings.startingPoints,
      running: room.running ? 1 : 0,
      listed: room.settings.listed ? 1 : 0,
    };
    const key = JSON.stringify(info);
    if (key === lastPublished) return;
    lastPublished = key;
    desktop.updateTable(info).catch(() => {});
  }, now ? 0 : 1500);
}

function goToRemoteTable({ code, server }) {
  session.del('hr_room');
  location.href = `${location.pathname}?server=${encodeURIComponent(server)}&via=steam&room=${encodeURIComponent(code)}&join=1`;
}

if (desktop) {
  document.body.classList.add('is-desktop');
  $('lobby').querySelector('.hint').textContent = 'Enter the code your friend sees at their table.';
  desktop.steamInfo().then((info) => {
    app.steam = info || { ok: false };
    if (!info?.ok) return;
    if (!$('name-input').value.trim()) $('name-input').value = String(info.name || '').slice(0, 16);
    $('steam-invite').classList.remove('hidden');
    $('browse-btn').classList.remove('hidden');
    $('list-row').classList.remove('hidden');
    for (const id of achUnlocked) desktop.unlockAchievement?.(id); // carry over progress made before Steam
    if (info.deck) {
      // Steam Deck: full screen and a slightly larger interface by default.
      desktop.toggleFullscreen(true);
      if (!local.get('hr_uiscale')) { local.set('hr_uiscale', '1.15'); applyUiScale(1.15); }
    }
    if (app.code) hostSteamLobby(app.code);
    tryAutoJoin();
  }).catch(() => { app.steam = { ok: false }; });

  // A Steam friend invited us (or we clicked "Join game"): go to their table.
  desktop.onJoinTable((target) => {
    if (!target?.code || !target.server) return;
    if (app.code) socket.emit('leave', {}, () => {});
    goToRemoteTable(target);
  });

  // The player hosting the table we're at closed the game or lost their connection.
  desktop.onHostLost(() => {
    if (!VIA_STEAM) return;
    session.del('hr_room');
    if (app.code) {
      showBanner('Table closed', 'Lost the connection to the host — they left, or the network dropped.');
      session.set('hr_notice', 'Lost the connection to the host \u2014 they left the game, or the network dropped.');
      setTimeout(() => leaveToLobby(), 3500);
    } else {
      session.set('hr_notice', 'Couldn\u2019t reach the host through Steam. They may have left, or a network is blocking the connection. \u201cOpen log file\u201d below has the details.');
      location.href = location.pathname;
    }
  });
  desktop.onRefused?.(() => {
    session.del('hr_room');
    session.set('hr_notice', 'You can\u2019t join that table — the host removed you.');
    location.href = location.pathname;
  });
  desktop.onNotice((msg) => {
    if (app.code) toast(msg, 5000); else $('lobby-error').textContent = msg;
  });

  $('steam-invite').addEventListener('click', async () => {
    if (!app.code) return;
    if (!app.steam?.ok) { toast('Steam isn\u2019t running, so friends can\u2019t join this table.', 5000); return; }
    const btn = $('steam-invite');
    btn.disabled = true;
    try {
      if (HOSTING_HERE) {
        const lobby = await desktop.hostTable(app.code);
        if (!lobby?.ok) { toast(`Couldn't open the table to Steam friends${lobby?.error ? ` (${lobby.error})` : ''}. Is Steam online?`, 6000); return; }
      }
      const friends = desktop.friends ? await desktop.friends() : null;
      if (Array.isArray(friends)) { showFriendPicker(friends); return; }
      // Fallback: Steam's own overlay invite window, or the help dialog.
      const res = await desktop.invite();
      if (!res?.overlay) showSteamHelp();
      else toast('Opened Steam\u2019s invite window. If you don\u2019t see it, share the table code instead.', 6000);
    } catch (e) {
      toast(`Steam invite failed: ${e?.message || e}`, 6000);
    } finally {
      btn.disabled = false;
    }
  });

  // In-game friends list (doesn't depend on the Steam overlay, which Electron can't show).
  const invited = new Set();
  let friendList = [];
  function avatarCanvas(av) {
    const c = document.createElement('canvas');
    if (!av) { const d = document.createElement('div'); d.className = 'sf-noav'; return d; }
    c.width = av.w; c.height = av.h;
    const bytes = Uint8ClampedArray.from(atob(av.rgba), (ch) => ch.charCodeAt(0));
    c.getContext('2d').putImageData(new ImageData(bytes, av.w, av.h), 0, 0);
    return c;
  }
  function renderFriends() {
    const list = $('sf-list');
    const q = $('sf-search').value.trim().toLowerCase();
    list.textContent = '';
    const shown = friendList.filter((f) => !q || f.name.toLowerCase().includes(q));
    if (!shown.length) {
      const e = document.createElement('div');
      e.className = 'sf-empty';
      e.textContent = friendList.length ? 'No friends match that search.' : 'Your Steam friends list is empty.';
      list.append(e);
      return;
    }
    for (const f of shown) {
      const row = document.createElement('div');
      row.className = `sf-row${f.state === 0 ? ' offline' : ''}`;
      const who = document.createElement('div');
      who.className = 'sf-who';
      const nm = document.createElement('div'); nm.className = 'sf-name'; nm.textContent = f.name;
      const st = document.createElement('div'); st.className = `sf-status${f.state ? ' on' : ''}`; st.textContent = f.status;
      who.append(nm, st);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small gold';
      const mark = () => { b.textContent = 'Invited ✓'; b.classList.add('done'); b.disabled = true; };
      if (invited.has(`${app.code}:${f.id}`)) mark(); else b.textContent = 'Invite';
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Sending…';
        let ok = false;
        try {
          if (HOSTING_HERE) await desktop.hostTable(app.code);
          ok = await desktop.inviteFriend(f.id);
        } catch { ok = false; }
        if (ok) { invited.add(`${app.code}:${f.id}`); mark(); }
        else { b.disabled = false; b.textContent = 'Retry'; toast(`Couldn’t invite ${f.name}. Is Steam online?`, 5000); }
      });
      row.append(avatarCanvas(f.avatar), who, b);
      list.append(row);
    }
  }
  function showFriendPicker(friends) {
    friendList = friends;
    $('sf-search').value = '';
    renderFriends();
    $('steam-friends').showModal();
    $('sf-search').focus();
  }
  $('sf-search').addEventListener('input', renderFriends);
  $('sf-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $('sf-copy').addEventListener('click', () => $('copy-link').click());

  // Shown if the friends list can't be read: explain the other ways in.
  function showSteamHelp() {
    const d = $('steam-help');
    d.querySelector('.sh-link').textContent = app.code;
    d.showModal();
  }
  $('steam-help-copy').addEventListener('click', () => $('copy-link').click());

  $('fullscreen-btn').addEventListener('click', (e) => { e.stopImmediatePropagation(); desktop.toggleFullscreen(); }, true);
  // Quit (the desktop app has no browser chrome to close, especially in full screen).
  const askQuit = () => {
    $('menu').classList.add('hidden');
    const hosting = app.code && HOSTING_HERE && app.room?.members.some((m) => !m.bot && m.pid !== app.pid && m.connected);
    $('quit-note').textContent = hosting ? 'You\u2019re hosting this table — quitting ends it for everyone.' : app.code ? 'You\u2019ll leave the table.' : '';
    const d = $('quit-dialog');
    d.returnValue = '';
    d.showModal();
    if (padStyle) nav.focus(d.querySelector('[data-pad-default]'));
  };
  $('quit-dialog').querySelector('button[value="quit"]').addEventListener('click', () => desktop.quit());
  for (const id of ['quit-btn', 'lobby-quit-btn']) { $(id).classList.remove('hidden'); $(id).addEventListener('click', askQuit); }

  if (desktop.openLog) {
    for (const id of ['log-btn', 'lobby-log-btn']) { $(id).classList.remove('hidden'); $(id).addEventListener('click', () => desktop.openLog()); }
  }
}
