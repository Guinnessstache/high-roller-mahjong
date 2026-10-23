// Hong Kong Mahjong table: wall, deal, turns, claims, kongs, wins, dealer rotation.
// Pure game state — no timers or sockets (rooms.js drives it).

import { randomInt } from 'node:crypto';
import { fullSet, isBonus, isSuited, tileName, KINDS } from './tiles.js';
import { scoreHand, payouts, DEFAULT_RULES } from './scoring.js';

export const MAX_SEATS = 4;
export const WINDS = ['East', 'South', 'West', 'North'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const removeOne = (arr, k) => { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); return i >= 0; };
const countOf = (arr, k) => arr.reduce((n, x) => n + (x === k ? 1 : 0), 0);

export class Table {
  constructor({ rules = {}, unit = 1, rounds = 1, rng = null } = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.unit = unit;
    this.rounds = rounds; // 1 = East round only, 2 = East+South, 4 = full game
    this.rng = rng; // optional deterministic shuffle for tests: (array) => array
    this.seats = new Array(MAX_SEATS).fill(null);
    this.maxSeats = MAX_SEATS;
    this.phase = 'idle'; // idle | turn | claim | robkong | over
    this.handNumber = 0;
    this.gameNumber = 0;
    this.gameActive = false;
    this.gameOver = false;
    this.dealer = 0;
    this.firstDealer = 0;
    this.roundWind = 0;
    this.handsThisGame = 0;
    this.wall = [];
    this.wallFront = 0; // tiles drawn from the front (live end)
    this.wallBack = 0; // tiles drawn from the back (kong / flower replacements)
    this.wallTotal = 0;
    this.toAct = -1;
    this.lastDraw = null; // { tile, replacement }
    this.lastDiscard = null; // { seat, tile }
    this.claims = null; // seat -> { options, response }
    this.pendingKong = null; // add-kong waiting on a rob
    this.discardCount = 0;
    this.anyClaim = false;
    this.lastResults = null;
    this.gameResults = null;
    this.events = [];
  }

  // ---------- seating ----------
  sit(seat, { id, name, points }) {
    if (seat < 0 || seat >= MAX_SEATS || this.seats[seat]) return false;
    this.seats[seat] = { id, name, points, hand: [], melds: [], bonus: [], discards: [], sittingOut: false, inHand: false, ghost: false };
    return true;
  }

  stand(seat) {
    const p = this.seats[seat];
    if (!p) return;
    if (p.inHand && this.inProgress()) { p.ghost = true; p.leaving = true; return; } // auto-played until the hand ends
    this.seats[seat] = null;
  }

  inProgress() { return this.phase !== 'idle' && this.phase !== 'over'; }
  seatedCount() { return this.seats.filter((p) => p && !p.leaving).length; }
  canStart() { return this.seats.every((p) => p && !p.leaving); }

  emit(type, data = {}) { this.events.push({ type, ...data }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  seatWind(seat) { return (seat - this.dealer + MAX_SEATS) % MAX_SEATS; }
  next(seat) { return (seat + 1) % MAX_SEATS; }

  // ---------- game / hand lifecycle ----------
  newGame(startingPoints) {
    this.gameNumber++;
    this.gameActive = true;
    this.gameOver = false;
    this.gameResults = null;
    this.firstDealer = randomInt(MAX_SEATS);
    this.dealer = this.firstDealer;
    this.roundWind = 0;
    this.handsThisGame = 0;
    for (const p of this.seats) if (p) p.points = startingPoints;
    this.emit('newGame', { dealer: this.dealer });
  }

  startHand() {
    if (!this.canStart() || this.inProgress()) return false;
    if (!this.gameActive) return false;
    this.handNumber++;
    this.handsThisGame++;
    this.phase = 'turn';
    this.lastResults = null;
    this.lastDiscard = null;
    this.claims = null;
    this.pendingKong = null;
    this.discardCount = 0;
    this.anyClaim = false;
    this.wall = this.rng ? this.rng(fullSet(this.rules.bonusTiles)) : shuffle(fullSet(this.rules.bonusTiles));
    this.wallTotal = this.wall.length;
    this.wallFront = 0;
    this.wallBack = 0;
    for (const p of this.seats) {
      p.hand = []; p.melds = []; p.bonus = []; p.discards = []; p.inHand = true;
    }
    // Deal: 4,4,4 then 1 each, starting with the dealer; the dealer then takes a 14th.
    const order = [0, 1, 2, 3].map((i) => (this.dealer + i) % MAX_SEATS);
    for (let r = 0; r < 3; r++) for (const s of order) for (let i = 0; i < 4; i++) this.seats[s].hand.push(this.drawFront());
    for (const s of order) this.seats[s].hand.push(this.drawFront());
    const first = this.drawFront();
    this.seats[this.dealer].hand.push(first);
    this.emit('deal', { dealer: this.dealer, handNumber: this.handNumber, roundWind: this.roundWind, wallTotal: this.wallTotal, wf: this.wallFront, wb: this.wallBack });
    // Replace bonus tiles, dealer first.
    for (const s of order) {
      let guard = 0;
      while (this.seats[s].hand.some(isBonus) && guard++ < 16) {
        const b = this.seats[s].hand.find(isBonus);
        removeOne(this.seats[s].hand, b);
        this.seats[s].bonus.push(b);
        const r = this.drawBack();
        if (r === null) { this.drawGame(); return true; }
        this.seats[s].hand.push(r);
        this.emit('bonus', { seat: s, tile: b, src: 'hand', wf: this.wallFront, wb: this.wallBack });
      }
    }
    this.toAct = this.dealer;
    const dealt = this.seats[this.dealer].hand;
    this.lastDraw = { tile: dealt[dealt.length - 1], replacement: false, initial: true }; // the dealer's 14th tile
    return true;
  }

  drawFront() { if (!this.wall.length) return null; this.wallFront++; return this.wall.shift(); }
  drawBack() { if (!this.wall.length) return null; this.wallBack++; return this.wall.pop(); }

  // Draw for `seat` (front or replacement), resolving bonus tiles. Returns false on wall exhaustion.
  drawFor(seat, replacement) {
    const p = this.seats[seat];
    let tile = replacement ? this.drawBack() : this.drawFront();
    let rep = replacement;
    while (tile !== null && isBonus(tile)) {
      p.bonus.push(tile);
      this.emit('bonus', { seat, tile, src: rep ? 'back' : 'front', wf: this.wallFront, wb: this.wallBack });
      tile = this.drawBack();
      rep = true;
    }
    if (tile === null) { this.drawGame(); return false; }
    p.hand.push(tile);
    this.lastDraw = { tile, replacement: rep };
    this.toAct = seat;
    this.phase = 'turn';
    this.emit('draw', { seat, src: rep ? 'back' : 'front', replacement: rep, wf: this.wallFront, wb: this.wallBack, wallLeft: this.wall.length });
    return true;
  }

  // ---------- win checks ----------
  winContext(seat, { winTile, selfDrawn, robbingKong = false, extra = null }) {
    const p = this.seats[seat];
    const concealed = extra === null ? p.hand.slice() : [...p.hand, extra];
    return {
      concealed,
      melds: p.melds.map((m) => ({ type: m.type, tile: m.tile, concealed: m.concealed })),
      winTile,
      selfDrawn,
      seatWind: this.seatWind(seat),
      roundWind: this.roundWind,
      bonus: p.bonus,
      lastTile: this.wall.length === 0 && !robbingKong,
      kongReplacement: selfDrawn && !!this.lastDraw?.replacement && !!this.lastDraw?.afterKong,
      robbingKong,
      heavenly: selfDrawn && seat === this.dealer && this.discardCount === 0 && !this.anyClaim && !!this.lastDraw?.initial,
      earthly: !selfDrawn && !robbingKong && seat !== this.dealer && this.discardCount === 1 && !this.anyClaim && this.lastDiscard?.seat === this.dealer,
      rules: this.rules,
    };
  }

  // { score, ok } — ok means it meets the minimum faan.
  checkWin(seat, opts) {
    const score = scoreHand(this.winContext(seat, opts));
    if (!score) return null;
    return { score, ok: score.faan >= this.rules.minFaan };
  }

  // ---------- legal actions ----------
  legalActions(seat) {
    const p = this.seats[seat];
    if (!p || !p.inHand) return null;
    if (this.phase === 'turn' && this.toAct === seat) {
      const out = { type: 'turn', drawn: this.lastDraw ? this.lastDraw.tile : null, canDiscard: true, kongs: [], win: null };
      if (this.lastDraw) {
        const w = this.checkWin(seat, { winTile: this.lastDraw.tile, selfDrawn: true });
        if (w) out.win = { faan: w.score.faan, ok: w.ok };
        out.kongs = this.kongOptions(seat);
      }
      return out;
    }
    if (this.phase === 'claim' && this.claims?.[seat] && this.claims[seat].response === null) {
      return { type: 'claim', tile: this.lastDiscard.tile, from: this.lastDiscard.seat, ...this.claims[seat].options };
    }
    if (this.phase === 'robkong' && this.claims?.[seat] && this.claims[seat].response === null) {
      return { type: 'robkong', tile: this.pendingKong.tile, from: this.pendingKong.seat, ...this.claims[seat].options };
    }
    return null;
  }

  kongOptions(seat) {
    const p = this.seats[seat];
    const out = [];
    if (this.wall.length === 0) return out;
    for (let k = 0; k < KINDS; k++) {
      if (countOf(p.hand, k) === 4) out.push(k);
      else if (p.hand.includes(k) && p.melds.some((m) => m.type === 'pung' && m.tile === k)) out.push(k);
    }
    return out;
  }

  claimOptionsFor(seat, tile, from) {
    const p = this.seats[seat];
    const opts = { win: null, pung: false, kong: false, chows: [] };
    const w = this.checkWin(seat, { winTile: tile, selfDrawn: false, extra: tile });
    if (w) opts.win = { faan: w.score.faan, ok: w.ok };
    const n = countOf(p.hand, tile);
    if (n >= 2) opts.pung = true;
    if (n >= 3 && this.wall.length > 0) opts.kong = true;
    if (seat === this.next(from) && isSuited(tile)) {
      const r = tile % 9;
      const has = (k) => p.hand.includes(k);
      if (r >= 2 && has(tile - 2) && has(tile - 1)) opts.chows.push([tile - 2, tile - 1]);
      if (r >= 1 && r <= 7 && has(tile - 1) && has(tile + 1)) opts.chows.push([tile - 1, tile + 1]);
      if (r <= 6 && has(tile + 1) && has(tile + 2)) opts.chows.push([tile + 1, tile + 2]);
    }
    const any = (opts.win && opts.win.ok) || opts.pung || opts.kong || opts.chows.length;
    return any ? opts : null;
  }

  // ---------- actions ----------
  act(seat, action, data = {}) {
    const p = this.seats[seat];
    if (!p || !p.inHand) return { ok: false, error: 'Not in this hand' };
    if (this.phase === 'turn') {
      if (this.toAct !== seat) return { ok: false, error: 'Not your turn' };
      if (action === 'discard') return this.discard(seat, Number(data.tile));
      if (action === 'win') return this.selfDrawnWin(seat);
      if (action === 'kong') return this.declareKong(seat, Number(data.tile));
      return { ok: false, error: 'Unknown action' };
    }
    if (this.phase === 'claim' || this.phase === 'robkong') {
      const c = this.claims?.[seat];
      if (!c || c.response !== null) return { ok: false, error: 'Nothing to claim' };
      const o = c.options;
      if (action === 'pass') c.response = { action: 'pass' };
      else if (action === 'win' && o.win?.ok) c.response = { action: 'win' };
      else if (this.phase === 'claim' && action === 'pung' && o.pung) c.response = { action: 'pung' };
      else if (this.phase === 'claim' && action === 'kong' && o.kong) c.response = { action: 'kong' };
      else if (this.phase === 'claim' && action === 'chow') {
        const pick = Array.isArray(data.tiles) ? data.tiles.map(Number).sort((a, b) => a - b) : o.chows[0];
        const match = o.chows.find((ch) => pick && ch[0] === pick[0] && ch[1] === pick[1]);
        if (!match) return { ok: false, error: 'You can’t chow with those tiles' };
        c.response = { action: 'chow', tiles: match };
      } else return { ok: false, error: action === 'win' && o.win ? `Not enough faan (need ${this.rules.minFaan})` : 'You can’t do that' };
      this.tryResolveClaims();
      return { ok: true };
    }
    return { ok: false, error: 'No hand in progress' };
  }

  discard(seat, tile) {
    const p = this.seats[seat];
    if (!p.hand.includes(tile)) return { ok: false, error: 'You don’t have that tile' };
    removeOne(p.hand, tile);
    p.discards.push(tile);
    this.discardCount++;
    this.lastDiscard = { seat, tile };
    this.lastDraw = null;
    this.emit('discard', { seat, tile });
    // Claim window.
    const claims = {};
    let any = false;
    for (let i = 1; i < MAX_SEATS; i++) {
      const s = (seat + i) % MAX_SEATS;
      const o = this.claimOptionsFor(s, tile, seat);
      if (o) { claims[s] = { options: o, response: null }; any = true; }
    }
    if (!any) {
      if (this.wall.length === 0) { this.drawGame(); return { ok: true }; }
      this.drawFor(this.next(seat), false);
      return { ok: true };
    }
    this.claims = claims;
    this.phase = 'claim';
    this.toAct = -1;
    return { ok: true };
  }

  // Seats still deciding on a claim.
  pendingClaimants() {
    if (!this.claims) return [];
    return Object.entries(this.claims).filter(([, c]) => c.response === null).map(([s]) => Number(s));
  }

  // Everyone who hasn't answered passes (timer ran out).
  timeoutClaims() {
    if (!this.claims) return;
    for (const c of Object.values(this.claims)) if (c.response === null) c.response = { action: 'pass' };
    this.tryResolveClaims();
  }

  tryResolveClaims() {
    if (!this.claims) return;
    const from = this.phase === 'robkong' ? this.pendingKong.seat : this.lastDiscard.seat;
    const order = [1, 2, 3].map((i) => (from + i) % MAX_SEATS).filter((s) => this.claims[s]);
    const resp = (s) => this.claims[s].response;
    // Resolve early once nobody undecided could outrank a decided claim.
    const rank = (r) => (!r ? 0 : r.action === 'win' ? 3 : r.action === 'pung' || r.action === 'kong' ? 2 : r.action === 'chow' ? 1 : 0);
    const potential = (s) => {
      const o = this.claims[s].options;
      return o.win?.ok ? 3 : o.pung || o.kong ? 2 : o.chows?.length ? 1 : 0;
    };
    let best = null;
    for (const s of order) { const r = resp(s); if (r && rank(r) > 0 && (!best || rank(r) > rank(resp(best)))) best = s; }
    for (const s of order) {
      if (resp(s) !== null) continue;
      const pot = potential(s);
      if (!best || pot > rank(resp(best))) return; // still waiting on someone who could win the claim
      // Equal win rank: earlier seat in turn order beats later (head bump).
      if (pot === 3 && rank(resp(best)) === 3 && order.indexOf(s) < order.indexOf(best)) return;
    }
    const claims = this.claims;
    this.claims = null;
    if (this.phase === 'robkong') return this.resolveRob(best);
    if (best === null) {
      if (this.wall.length === 0) { this.drawGame(); return; }
      this.drawFor(this.next(from), false);
      return;
    }
    const r = claims[best].response;
    if (r.action === 'win') return this.discardWin(best);
    this.takeDiscard(best, r);
  }

  takeDiscard(seat, r) {
    const p = this.seats[seat];
    const { seat: from, tile } = this.lastDiscard;
    this.seats[from].discards.pop();
    this.anyClaim = true;
    let meld;
    if (r.action === 'chow') {
      removeOne(p.hand, r.tiles[0]); removeOne(p.hand, r.tiles[1]);
      const tiles = [r.tiles[0], r.tiles[1], tile].sort((a, b) => a - b);
      meld = { type: 'chow', tile: tiles[0], tiles, concealed: false, from, claimed: tile };
    } else {
      const n = r.action === 'kong' ? 3 : 2;
      for (let i = 0; i < n; i++) removeOne(p.hand, tile);
      meld = { type: r.action, tile, tiles: new Array(n + 1).fill(tile), concealed: false, from, claimed: tile };
    }
    p.melds.push(meld);
    this.lastDiscard = null;
    this.emit('claim', { seat, from, action: r.action, tile, tiles: meld.tiles });
    if (r.action === 'kong') {
      if (this.drawFor(seat, true)) this.lastDraw.afterKong = true;
      return;
    }
    this.toAct = seat;
    this.phase = 'turn';
    this.lastDraw = null; // must discard, no self-drawn win
  }

  declareKong(seat, tile) {
    const p = this.seats[seat];
    if (!this.lastDraw) return { ok: false, error: 'Discard a tile first' };
    if (!this.kongOptions(seat).includes(tile)) return { ok: false, error: 'You can’t kong that' };
    if (countOf(p.hand, tile) === 4) {
      for (let i = 0; i < 4; i++) removeOne(p.hand, tile);
      p.melds.push({ type: 'kong', tile, tiles: [tile, tile, tile, tile], concealed: true, from: seat });
      this.anyClaim = true;
      this.emit('kong', { seat, tile, concealed: true });
      if (this.drawFor(seat, true)) this.lastDraw.afterKong = true;
      return { ok: true };
    }
    // Adding to an exposed pung: other players may rob it.
    const claims = {};
    let any = false;
    for (let i = 1; i < MAX_SEATS; i++) {
      const s = (seat + i) % MAX_SEATS;
      const w = this.checkWin(s, { winTile: tile, selfDrawn: false, robbingKong: true, extra: tile });
      if (w?.ok) { claims[s] = { options: { win: { faan: w.score.faan, ok: true }, pung: false, kong: false, chows: [] }, response: null }; any = true; }
    }
    removeOne(p.hand, tile);
    this.pendingKong = { seat, tile };
    this.anyClaim = true;
    this.emit('addKong', { seat, tile });
    if (!any) { this.completeAddKong(); return { ok: true }; }
    this.claims = claims;
    this.phase = 'robkong';
    this.toAct = -1;
    return { ok: true };
  }

  completeAddKong() {
    const { seat, tile } = this.pendingKong;
    this.pendingKong = null;
    const p = this.seats[seat];
    const m = p.melds.find((x) => x.type === 'pung' && x.tile === tile);
    m.type = 'kong';
    m.tiles = [tile, tile, tile, tile];
    if (this.drawFor(seat, true)) this.lastDraw.afterKong = true;
  }

  resolveRob(best) {
    if (best === null) return this.completeAddKong();
    const { seat: from, tile } = this.pendingKong;
    this.pendingKong = null;
    this.finishWin(best, { from, tile, selfDrawn: false, robbingKong: true });
  }

  selfDrawnWin(seat) {
    if (!this.lastDraw) return { ok: false, error: 'You can only win on a tile you drew' };
    const w = this.checkWin(seat, { winTile: this.lastDraw.tile, selfDrawn: true });
    if (!w) return { ok: false, error: 'That isn’t a winning hand' };
    if (!w.ok) return { ok: false, error: `Only ${w.score.faan} faan — you need ${this.rules.minFaan}` };
    this.finishWin(seat, { from: null, tile: this.lastDraw.tile, selfDrawn: true });
    return { ok: true };
  }

  discardWin(seat) {
    const { seat: from, tile } = this.lastDiscard;
    this.seats[from].discards.pop();
    this.finishWin(seat, { from, tile, selfDrawn: false });
  }

  finishWin(seat, { from, tile, selfDrawn, robbingKong = false }) {
    const p = this.seats[seat];
    const ctx = this.winContext(seat, { winTile: tile, selfDrawn, robbingKong, extra: selfDrawn ? null : tile });
    const score = scoreHand(ctx);
    if (!selfDrawn) p.hand.push(tile);
    const delta = payouts({ winner: seat, discarder: selfDrawn ? null : from, faan: score.faan, unit: this.unit });
    this.seats.forEach((q, i) => { if (q) q.points += delta[i]; });
    this.lastResults = {
      type: 'win', winner: seat, from: selfDrawn ? null : from, tile, selfDrawn, robbingKong,
      faan: score.faan, items: score.items, limit: score.limit, delta,
      hand: p.hand.slice().sort((a, b) => a - b), melds: p.melds.map((m) => ({ ...m })), bonus: p.bonus.slice(),
    };
    this.phase = 'over';
    this.toAct = -1;
    this.claims = null;
    this.emit('win', {
      seat, from: selfDrawn ? null : from, tile, selfDrawn, robbingKong, faan: score.faan, items: score.items, limit: score.limit, delta,
      name: p.name,
    });
  }

  drawGame() {
    this.lastResults = { type: 'draw', delta: [0, 0, 0, 0] };
    this.phase = 'over';
    this.toAct = -1;
    this.claims = null;
    this.emit('drawGame', {});
  }

  // After the results pause: rotate the deal, maybe end the game.
  endHandCleanup() {
    const r = this.lastResults;
    const dealerKeeps = !r || r.type === 'draw' || r.winner === this.dealer;
    if (!dealerKeeps) {
      this.dealer = this.next(this.dealer);
      if (this.dealer === this.firstDealer) this.roundWind++;
    }
    for (let i = 0; i < MAX_SEATS; i++) {
      const p = this.seats[i];
      if (!p) continue;
      p.inHand = false;
      if (p.leaving) this.seats[i] = null;
    }
    this.phase = 'idle';
    this.lastDiscard = null;
    this.lastDraw = null;
    this.toAct = -1;
    const cap = this.rounds * MAX_SEATS * 4; // guard against endless dealer repeats
    if (this.roundWind >= this.rounds || this.handsThisGame >= cap) this.endGame();
  }

  endGame() {
    this.gameActive = false;
    this.gameOver = true;
    this.gameResults = this.seats.map((p, i) => (p ? { seat: i, id: p.id, name: p.name, points: p.points } : null)).filter(Boolean)
      .sort((a, b) => b.points - a.points);
    this.emit('gameOver', { standings: this.gameResults });
  }

  // ---------- views ----------
  publicState() {
    const over = this.phase === 'over';
    return {
      phase: this.phase,
      handNumber: this.handNumber,
      gameNumber: this.gameNumber,
      gameActive: this.gameActive,
      gameOver: this.gameOver,
      dealer: this.dealer,
      roundWind: this.roundWind,
      rounds: this.rounds,
      toAct: this.toAct,
      wallLeft: this.wall.length,
      wallFront: this.wallFront,
      wallBack: this.wallBack,
      wallTotal: this.wallTotal,
      lastDiscard: this.lastDiscard,
      pendingKong: this.pendingKong,
      claiming: this.phase === 'claim' || this.phase === 'robkong',
      rules: this.rules,
      unit: this.unit,
      results: this.lastResults,
      gameResults: this.gameResults,
      seats: this.seats.map((p, i) => (p ? {
        id: p.id,
        name: p.name,
        points: p.points,
        wind: this.seatWind(i),
        inHand: p.inHand,
        handCount: p.hand.length,
        melds: p.melds.map((m) => ({ type: m.type, tile: m.tile, tiles: m.tiles, concealed: m.concealed, from: m.from, claimed: m.claimed })),
        bonus: p.bonus.slice(),
        discards: p.discards.slice(),
        sittingOut: p.sittingOut,
        ghost: p.ghost,
        hand: over && p.inHand ? p.hand.slice().sort((a, b) => a - b) : null, // revealed at the end
      } : null)),
    };
  }
}

export const describeTile = tileName;
