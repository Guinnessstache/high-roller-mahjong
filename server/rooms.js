// Room / lobby layer: join codes, seating, pacing, timers, chat, WebRTC signaling.

import { randomBytes, randomInt } from 'node:crypto';
import { Table, MAX_SEATS } from './mahjong.js';
import { handAwards, gameAwards } from './awards.js';
import { BOT_LEVELS, LEVEL_LABEL, makeBotProfile, pickBotName, decide, thinkTime, botLine } from './bots.js';

const SEAT_ORDER = [0, 2, 1, 3]; // the seat facing the camera first, then across

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_LEN = 5;
const DISCONNECT_REMOVE_MS = 3 * 60 * 1000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

export const rooms = new Map();

function makeCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < CODE_LEN; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('Could not allocate room code');
}

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return n || 'Player';
}

export function normalizeSettings(s = {}) {
  return {
    startingPoints: clampInt(s.startingPoints, 100, 10_000_000, 5000),
    unit: clampInt(s.unit, 1, 100_000, 10),
    minFaan: clampInt(s.minFaan, 0, 8, 3),
    maxFaan: [8, 10, 13].includes(Number(s.maxFaan)) ? Number(s.maxFaan) : 10,
    rounds: [1, 2, 4].includes(Number(s.rounds)) ? Number(s.rounds) : 1,
    bonusTiles: s.bonusTiles !== false,
    sevenPairs: !!s.sevenPairs,
    actionTime: clampInt(s.actionTime, 8, 90, 20),
    claimTime: clampInt(s.claimTime, 4, 30, 8),
    // Keep the table filled with computer players up to this many seated players (0 = off).
    fillBots: clampInt(s.fillBots, 0, MAX_SEATS, MAX_SEATS),
    botLevel: BOT_LEVELS.includes(s.botLevel) ? s.botLevel : 'medium',
    // Shown in the Steam table browser (the desktop app lists it; the server just remembers it).
    listed: !!s.listed,
  };
}

const tableOptions = (s) => ({
  unit: s.unit,
  rounds: s.rounds,
  rules: { minFaan: s.minFaan, maxFaan: s.maxFaan, bonusTiles: s.bonusTiles, sevenPairs: s.sevenPairs },
});

export class Room {
  constructor(io, settings) {
    this.io = io;
    this.code = makeCode();
    this.settings = normalizeSettings(settings);
    this.table = new Table(tableOptions(this.settings));
    this.members = new Map(); // key -> member
    this.hostKey = null;
    this.running = false;
    this.timers = { turn: null, next: null, bot: new Map() };
    this.deadline = 0;
    this.turnTotal = 0;
    this.chat = [];
    this.banned = new Set(); // client keys and Steam IDs the host kicked
    this.emptySince = Date.now();
    rooms.set(this.code, this);
  }

  // ---------- membership ----------
  memberBySocket(socketId) {
    for (const m of this.members.values()) if (m.socketId === socketId) return m;
    return null;
  }
  memberByPid(pid) {
    for (const m of this.members.values()) if (m.pid === pid) return m;
    return null;
  }
  memberBySeat(seat) {
    for (const m of this.members.values()) if (m.seat === seat) return m;
    return null;
  }

  isBanned(key, steamId) { return this.banned.has(key) || (!!steamId && this.banned.has(`steam:${steamId}`)); }

  join(socket, key, name, steamId) {
    let m = this.members.get(key);
    if (m) {
      // Reconnect.
      if (m.socketId && m.socketId !== socket.id) this.io.sockets.sockets.get(m.socketId)?.disconnect(true);
      m.socketId = socket.id;
      m.connected = true;
      if (name) m.name = cleanName(name);
      clearTimeout(m.removeTimer);
      const p = m.seat >= 0 ? this.table.seats[m.seat] : null;
      if (p) { p.name = m.name; if (p.autoAfterTimeout) { p.sittingOut = false; p.autoAfterTimeout = false; } }
    } else {
      m = {
        key,
        pid: randomBytes(6).toString('hex'),
        name: cleanName(name),
        socketId: socket.id,
        connected: true,
        seat: -1,
        media: { cam: false, mic: false },
        color: this.members.size % 8,
        steamId: steamId ? String(steamId).slice(0, 24) : null,
      };
      this.members.set(key, m);
      if (!this.hostKey) this.hostKey = key;
      let free = this.freeSeat();
      if (free < 0 && this.makeRoomForHuman(m)) free = -2; // took over a bot's seat
      if (free >= 0) this.sit(m, free, true);
      else if (free === -1) m.wantsSeat = true; // seated as soon as a bot's seat frees up (end of hand)
      this.systemChat(`${m.name} joined the table.`);
    }
    if (this.pausedEmpty) { this.pausedEmpty = false; this.running = true; this.systemChat('Welcome back — resuming.'); }
    socket.join(this.code);
    this.emptySince = 0;
    this.broadcastRoom();
    this.sendState(m);
    socket.emit('chatHistory', this.chat.slice(-50));
    this.rebalanceBots();
    this.maybeStartHand();
    return m;
  }

  sit(m, seat, quiet = false) {
    if (m.seat === seat) return null;
    if (this.table.inProgress() && m.seat >= 0) return 'You can’t change seats during a hand';
    if (m.seat >= 0) this.stand(m, true);
    const t = this.table;
    if (!t.sit(seat, { id: m.pid, name: m.name, points: m.points ?? this.settings.startingPoints })) return 'Seat taken';
    if (t.gameActive && m.points === undefined) t.seats[seat].points = this.settings.startingPoints;
    m.seat = seat;
    m.wantsSeat = false;
    if (!quiet) this.systemChat(`${m.name} sat down.`);
    this.afterChange();
    this.maybeStartHand();
    return null;
  }

  stand(m, quiet = false) {
    if (m.seat < 0) return;
    const t = this.table;
    const p = t.seats[m.seat];
    if (p) {
      m.points = p.points;
      t.stand(m.seat); // mid-hand: auto-played until the hand ends, then the seat frees up
      if (t.seats[m.seat]) { t.seats[m.seat].id = `left:${m.pid}`; t.seats[m.seat].sittingOut = true; }
    }
    m.seat = -1;
    if (!quiet) this.systemChat(`${m.name} stood up.`);
    this.afterChange();
  }

  leave(m) {
    this.stand(m, true);
    this.members.delete(m.key);
    this.clearBotTimer(m.pid);
    this.systemChat(m.bot ? `\u{1F916} ${m.name} left the table.` : `${m.name} left.`);
    this.io.to(this.code).emit('peerLeft', { pid: m.pid });
    if (this.hostKey === m.key) {
      const humans = [...this.members.values()].filter((x) => !x.bot);
      const next = humans.find((x) => x.connected) || humans[0];
      this.hostKey = next ? next.key : null;
      if (next) this.systemChat(`${next.name} is now the host.`);
    }
    if (!m.bot) this.rebalanceBots();
    this.broadcastRoom();
    this.checkEmpty();
  }

  disconnect(m) {
    m.connected = false;
    m.socketId = null;
    m.media = { cam: false, mic: false };
    this.io.to(this.code).emit('peerLeft', { pid: m.pid });
    m.removeTimer = setTimeout(() => {
      if (!m.connected && this.members.get(m.key) === m) this.leave(m);
    }, DISCONNECT_REMOVE_MS);
    m.removeTimer.unref?.();
    // Play their tiles automatically while they're gone.
    const p = m.seat >= 0 ? this.table.seats[m.seat] : null;
    if (p) { p.sittingOut = true; p.autoAfterTimeout = true; this.windowKey = null; this.schedule(); }
    this.broadcastRoom();
    if (!this.humansConnected() && this.running) { this.running = false; this.pausedEmpty = true; }
    this.checkEmpty();
  }

  humansConnected() { return [...this.members.values()].some((m) => m.connected && !m.bot); }
  checkEmpty() { if (!this.humansConnected() && !this.emptySince) this.emptySince = Date.now(); }
  isHost(m) { return m.key === this.hostKey; }

  // ---------- computer players ----------
  freeSeat() {
    const i = SEAT_ORDER.find((s) => !this.table.seats[s]);
    return i === undefined ? -1 : i;
  }

  seatedCount() { return this.table.seats.filter((p) => p && !p.leaving).length; }
  bots() { return [...this.members.values()].filter((m) => m.bot); }
  betweenHands() { return !this.table.inProgress(); }

  addBot(level, { auto = false } = {}) {
    const seat = this.freeSeat();
    if (seat < 0) return 'The table is full';
    level = BOT_LEVELS.includes(level) ? level : 'medium';
    const taken = new Set([...this.members.values()].map((x) => x.name));
    const pid = randomBytes(6).toString('hex');
    const m = {
      key: `bot:${pid}`, pid, name: pickBotName(taken), socketId: null, connected: true, seat: -1,
      media: { cam: false, mic: false }, color: this.members.size % 8,
      bot: { level, auto, profile: makeBotProfile(level) },
    };
    this.members.set(m.key, m);
    const err = this.sit(m, seat, true);
    if (err) { this.members.delete(m.key); return err; }
    this.systemChat(`\u{1F916} ${m.name} (${LEVEL_LABEL[level]} bot) sat down.`);
    this.broadcastRoom();
    return null;
  }

  removeBot(m) {
    if (!m?.bot) return 'Not a bot';
    this.leave(m); // auto-played to the end of the hand
    return null;
  }

  // A real player takes over an auto-fill bot's seat (and its points), between hands.
  makeRoomForHuman(human) {
    if (!this.betweenHands()) return false;
    const b = this.bots().filter((x) => x.bot.auto && x.seat >= 0).pop();
    if (!b) return false;
    const seat = b.seat;
    const p = this.table.seats[seat];
    const points = p ? p.points : undefined;
    this.leave(b);
    human.points = points;
    this.sit(human, seat, true);
    return true;
  }

  // Keep the table at `fillBots` seated players using auto bots.
  rebalanceBots() {
    const target = this.settings.fillBots;
    if (!this.betweenHands()) return; // settle after the hand
    for (const m of this.members.values()) {
      if (m.bot || !m.wantsSeat || m.seat >= 0 || !m.connected) continue;
      const free = this.freeSeat();
      if (free >= 0) this.sit(m, free, true);
      else if (!this.makeRoomForHuman(m)) break;
    }
    const autos = () => this.bots().filter((b) => b.bot.auto);
    let guard = 0;
    while (target && this.seatedCount() < target && this.freeSeat() >= 0 && guard++ < MAX_SEATS) {
      if (this.addBot(this.settings.botLevel, { auto: true })) break;
    }
    while (this.seatedCount() > Math.max(target, 0) && autos().length && guard++ < MAX_SEATS * 2) {
      this.leave(autos().pop());
    }
  }

  kick(m, pid) {
    if (!this.isHost(m)) return 'Only the host can remove players';
    const target = this.memberByPid(pid);
    if (!target) return 'That player already left';
    if (target === m) return 'You can’t remove yourself';
    if (target.bot) return this.removeBot(target);
    this.banned.add(target.key);
    if (target.steamId) this.banned.add(`steam:${target.steamId}`);
    this.toSocket(target, 'kicked', {});
    const sock = target.socketId && this.io.sockets.sockets.get(target.socketId);
    this.leave(target);
    this.systemChat(`${target.name} was removed by the host.`);
    if (sock) setTimeout(() => sock.disconnect(true), 300);
    return null;
  }

  setListed(m, on) {
    if (!this.isHost(m)) return 'Only the host can change this';
    this.settings = { ...this.settings, listed: !!on };
    this.systemChat(on ? 'This table is now listed in Browse tables.' : 'This table is no longer listed publicly.');
    this.broadcastRoom();
    return null;
  }

  hostAddBot(m, level) {
    if (!this.isHost(m)) return 'Only the host can add bots';
    if (!this.betweenHands()) return 'Add bots between hands';
    const err = this.addBot(level);
    if (!err) this.maybeStartHand();
    return err;
  }

  hostRemoveBot(m, pid) {
    if (!this.isHost(m)) return 'Only the host can remove bots';
    const b = this.memberByPid(pid);
    if (!b?.bot) return 'No such bot';
    return this.removeBot(b);
  }

  hostBotFill(m, count, level) {
    if (!this.isHost(m)) return 'Only the host can change bot settings';
    this.settings = normalizeSettings({ ...this.settings, fillBots: count, botLevel: level });
    const { fillBots, botLevel } = this.settings;
    this.systemChat(fillBots ? `Bots will keep the table at ${fillBots} players (${LEVEL_LABEL[botLevel]}).` : 'Auto-fill bots turned off.');
    this.rebalanceBots();
    this.broadcastRoom();
    this.maybeStartHand();
    return null;
  }

  // ---------- game flow ----------
  start(m) {
    if (!this.isHost(m)) return 'Only the host can start the game';
    this.rebalanceBots();
    if (!this.table.canStart()) return 'Mahjong needs 4 players — add bots (Bots…) or wait for friends';
    this.running = true;
    this.systemChat('The host started the game. Good luck!');
    this.broadcastRoom();
    this.maybeStartHand();
    return null;
  }

  pause(m) {
    if (!this.isHost(m)) return 'Only the host can pause';
    this.running = false;
    this.systemChat('The game will pause after this hand.');
    this.broadcastRoom();
    return null;
  }

  // New rules apply from the next game.
  updateSettings(m, s) {
    if (!this.isHost(m)) return 'Only the host can change settings';
    const next = normalizeSettings({ ...this.settings, ...s });
    next.fillBots = this.settings.fillBots;
    next.botLevel = this.settings.botLevel;
    next.listed = this.settings.listed;
    this.settings = next;
    const t = this.table;
    t.unit = next.unit;
    if (!t.gameActive) Object.assign(t, tableOptions(next), { rules: { ...t.rules, ...tableOptions(next).rules } });
    else this.pendingRules = true;
    this.systemChat(`Table rules: min ${next.minFaan} faan, max ${next.maxFaan}, ${['', 'East round', 'East + South', '', 'full game'][next.rounds]}${t.gameActive ? ' (from the next game)' : ''}.`);
    this.broadcastRoom();
    return null;
  }

  newGameIfNeeded() {
    const t = this.table;
    if (t.gameActive) return;
    if (this.pendingRules) {
      const o = tableOptions(this.settings);
      t.rules = { ...t.rules, ...o.rules };
      t.rounds = o.rounds;
      t.unit = o.unit;
      this.pendingRules = false;
    }
    t.newGame(this.settings.startingPoints);
    for (const mm of this.members.values()) mm.points = undefined;
    this.systemChat(`New game — everyone starts with ${this.settings.startingPoints.toLocaleString()} points.`);
  }

  maybeStartHand() {
    if (!this.running || this.timers.next) return;
    const t = this.table;
    if (t.inProgress()) return;
    if (!t.canStart()) return;
    this.timers.next = setTimeout(() => {
      this.timers.next = null;
      if (!this.running || t.inProgress() || !t.canStart()) return;
      for (const m of this.members.values()) if (m.seat >= 0 && t.seats[m.seat]) t.seats[m.seat].name = m.name;
      this.newGameIfNeeded();
      if (t.startHand()) this.afterChange();
    }, 1500);
  }

  act(m, action, data) {
    if (m.seat < 0) return 'You are not seated';
    const p = this.table.seats[m.seat];
    if (p?.sittingOut && !p.ghost) { p.sittingOut = false; p.autoAfterTimeout = false; }
    if (p) p.timeouts = 0;
    const r = this.table.act(m.seat, action, data || {});
    if (!r.ok) return r.error;
    this.afterChange();
    return null;
  }

  setSittingOut(m, value) {
    if (m.seat < 0) return 'Not seated';
    const p = this.table.seats[m.seat];
    p.sittingOut = !!value;
    p.autoAfterTimeout = false;
    p.timeouts = 0;
    this.windowKey = null; // re-plan who acts now (autopilot on or off)
    this.afterChange();
    return null;
  }

  // ---------- pacing ----------
  // Run after every mutation: flush events, schedule timers, send state.
  afterChange() {
    const t = this.table;
    const events = t.drainEvents();
    if (events.length) this.io.to(this.code).emit('events', events);
    for (const e of events) this.reactToEvent(e);
    this.schedule();
    this.sendStateAll();
  }

  reactToEvent(e) {
    if (e.type === 'win') {
      const m = this.memberBySeat(e.seat);
      if (m?.bot && Math.random() < (e.faan >= 7 ? 0.7 : 0.3)) this.pushChat({ pid: m.pid, name: m.name, text: botLine(e.faan >= 7 ? 'big' : 'win') });
      else if (e.from !== null) {
        const d = this.memberBySeat(e.from);
        if (d?.bot && Math.random() < 0.25) this.pushChat({ pid: d.pid, name: d.name, text: botLine('dealin') });
      }
    }
  }

  clearBotTimer(pid) {
    const tm = this.timers.bot.get(pid);
    if (tm) { clearTimeout(tm); this.timers.bot.delete(pid); }
  }

  // Who must act now, and timers for them.
  schedule() {
    const t = this.table;
    if (t.phase === 'over') {
      clearTimeout(this.timers.turn);
      this.timers.turn = null;
      this.deadline = 0;
      if (!this.timers.next) this.scheduleHandEnd();
      return;
    }
    if (!t.inProgress()) return;
    const actors = t.phase === 'turn' ? [t.toAct] : t.pendingClaimants();
    const key = `${t.handNumber}:${t.phase}:${t.toAct}:${t.discardCount}:${t.wallLeft ?? t.wall.length}:${t.pendingKong ? 'k' : ''}`;
    const newWindow = key !== this.windowKey;
    this.windowKey = key;
    // Bots and auto-played seats.
    for (const seat of actors) {
      const p = t.seats[seat];
      const m = this.memberBySeat(seat);
      const auto = !m || p?.ghost || p?.sittingOut || !m.connected;
      const id = m?.pid || `seat${seat}`;
      if ((m?.bot || auto) && newWindow) {
        this.clearBotTimer(id);
        const hand = t.handNumber;
        const phase = t.phase;
        const firstTurn = t.phase === 'turn' && t.discardCount === 0;
        let delay = m?.bot ? thinkTime(t, seat, m.bot.profile) : 600;
        if (firstTurn) delay += 2500; // let the deal animation play
        this.timers.bot.set(id, setTimeout(() => {
          this.timers.bot.delete(id);
          if (t.handNumber !== hand || t.phase !== phase) return;
          this.autoAct(seat, m?.bot ? m.bot.profile : null);
        }, delay));
      }
    }
    if (!newWindow) return;
    // Turn / claim clock for humans.
    clearTimeout(this.timers.turn);
    const humanActors = actors.filter((s) => { const m = this.memberBySeat(s); return m && !m.bot && m.connected && !t.seats[s].sittingOut; });
    if (!humanActors.length) { this.deadline = 0; return; }
    let ms = (t.phase === 'turn' ? this.settings.actionTime : this.settings.claimTime) * 1000;
    if (t.phase === 'turn' && t.discardCount === 0) ms += 3000;
    this.deadline = Date.now() + ms;
    this.turnTotal = ms;
    const hand = t.handNumber;
    const k = key;
    this.timers.turn = setTimeout(() => {
      this.timers.turn = null;
      if (t.handNumber !== hand || this.windowKey !== k) return;
      if (t.phase === 'turn') {
        const seat = t.toAct;
        const p = t.seats[seat];
        p.timeouts = (p.timeouts || 0) + 1;
        if (p.timeouts >= 2) {
          p.sittingOut = true;
          p.autoAfterTimeout = true;
          const m = this.memberBySeat(seat);
          if (m) this.toSocket(m, 'toast', 'You timed out twice, so your tiles are being played for you. Press “I’m back” to take over.');
        }
        this.autoAct(seat, null);
      } else {
        t.timeoutClaims();
        this.afterChange();
      }
    }, ms);
  }

  // Bot decision, or a simple autopilot for players who are away (discard the drawn tile, pass claims).
  autoAct(seat, profile) {
    const t = this.table;
    const legal = t.legalActions(seat);
    if (!legal) return;
    let d = null;
    if (profile) { try { d = decide(t, seat, profile); } catch (e) { console.error('[bot]', e); } }
    if (!d) {
      if (legal.type === 'turn') {
        if (legal.win?.ok) d = { action: 'win' };
        else {
          const hand = t.seats[seat].hand;
          d = { action: 'discard', data: { tile: legal.drawn !== null && hand.includes(legal.drawn) ? legal.drawn : hand[hand.length - 1] } };
        }
      } else d = { action: 'pass' };
    }
    let r = t.act(seat, d.action, d.data || {});
    if (!r.ok) {
      const hand = t.seats[seat].hand;
      r = legal.type === 'turn' ? t.act(seat, 'discard', { tile: hand[hand.length - 1] }) : t.act(seat, 'pass');
    }
    this.afterChange();
  }

  scheduleHandEnd() {
    const t = this.table;
    const r = t.lastResults;
    this.sendAwards();
    const delay = r?.type === 'win' ? 9000 : 4500;
    this.timers.next = setTimeout(() => {
      this.timers.next = null;
      t.endHandCleanup();
      for (const m of this.members.values()) if (m.seat >= 0 && !t.seats[m.seat]) m.seat = -1;
      const ev = t.drainEvents();
      if (ev.length) this.io.to(this.code).emit('events', ev);
      if (t.gameOver) {
        this.sendGameAwards();
        const top = t.gameResults[0];
        this.systemChat(`Game over — ${top.name} wins with ${top.points.toLocaleString()} points!`);
        this.sendStateAll();
        this.timers.next = setTimeout(() => {
          this.timers.next = null;
          this.table.gameOver = false;
          this.rebalanceBots();
          this.sendStateAll();
          this.maybeStartHand();
        }, 15000);
        return;
      }
      this.rebalanceBots();
      this.sendStateAll();
      this.broadcastRoom();
      this.maybeStartHand();
    }, delay);
  }

  sendAwards() {
    let awards;
    try { awards = handAwards(this.table, { isHuman: (s) => { const m = this.memberBySeat(s); return !!m && !m.bot; } }); } catch (e) { console.error('[awards]', e); return; }
    for (const [seat, a] of awards) {
      const m = this.memberBySeat(seat);
      if (!m || m.bot) continue;
      this.toSocket(m, 'awards', { ids: [...a.ids], stats: a.stats });
    }
  }

  sendGameAwards() {
    let awards;
    try { awards = gameAwards(this.table, { botLevel: (s) => this.memberBySeat(s)?.bot?.level || null }); } catch (e) { console.error('[awards]', e); return; }
    for (const [seat, a] of awards) {
      const m = this.memberBySeat(seat);
      if (!m || m.bot) continue;
      this.toSocket(m, 'awards', { ids: [...a.ids], stats: a.stats });
    }
  }

  // ---------- chat / media / signaling ----------
  systemChat(text) { this.pushChat({ system: true, text }); }

  pushChat(msg) {
    msg.ts = Date.now();
    this.chat.push(msg);
    if (this.chat.length > 200) this.chat.shift();
    this.io.to(this.code).emit('chat', msg);
  }

  userChat(m, text) {
    text = String(text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 240);
    if (!text) return;
    const now = Date.now();
    if (m.lastChat && now - m.lastChat < 400) return;
    m.lastChat = now;
    this.pushChat({ pid: m.pid, name: m.name, text });
  }

  setMedia(m, media) {
    m.media = { cam: !!media?.cam, mic: !!media?.mic };
    this.broadcastRoom();
  }

  relaySignal(m, to, data) {
    const target = this.memberByPid(to);
    if (!target || !target.socketId) return;
    this.io.to(target.socketId).emit('rtc', { from: m.pid, data });
  }

  toSocket(m, ev, payload) {
    if (m.socketId) this.io.to(m.socketId).emit(ev, payload);
  }

  // ---------- broadcasting ----------
  roomInfo() {
    const host = this.members.get(this.hostKey);
    return {
      code: this.code,
      hostPid: host ? host.pid : null,
      running: this.running,
      settings: this.settings,
      members: [...this.members.values()].map((m) => ({
        pid: m.pid, name: m.name, seat: m.seat, connected: m.connected, media: m.media, color: m.color,
        bot: m.bot ? m.bot.level : null,
        botAuto: m.bot ? !!m.bot.auto : false,
      })),
    };
  }

  broadcastRoom() { this.io.to(this.code).emit('room', this.roomInfo()); }

  sendState(m) {
    if (!m.socketId) return;
    const t = this.table;
    const p = m.seat >= 0 ? t.seats[m.seat] : null;
    this.io.to(m.socketId).emit('state', {
      table: t.publicState(),
      deadline: this.deadline,
      turnTotal: this.turnTotal || 0,
      serverNow: Date.now(),
      you: {
        pid: m.pid,
        seat: m.seat,
        isHost: this.isHost(m),
        hand: p && p.inHand ? p.hand.slice() : [],
        drawn: p && t.phase === 'turn' && t.toAct === m.seat && t.lastDraw ? t.lastDraw.tile : null,
        legal: p && !p.sittingOut ? t.legalActions(m.seat) : null,
        sittingOut: p ? p.sittingOut : false,
      },
    });
  }

  sendStateAll() { for (const m of this.members.values()) this.sendState(m); }

  destroy() {
    clearTimeout(this.timers.turn);
    clearTimeout(this.timers.next);
    for (const tm of this.timers.bot.values()) clearTimeout(tm);
    for (const m of this.members.values()) clearTimeout(m.removeTimer);
    rooms.delete(this.code);
  }
}

// Sweep abandoned rooms.
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.emptySince && now - r.emptySince > EMPTY_ROOM_TTL_MS) r.destroy();
  }
}, 60 * 1000).unref();
