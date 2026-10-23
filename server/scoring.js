// Hong Kong Mahjong: winning-hand detection, faan scoring, payouts and shanten.
// Shared by the server and the browser (served at /shared/scoring.js) so the
// client can show "you're ready" hints without asking the server.

import {
  KINDS, EAST, isSuited, isHonor, isWind, isDragon, isTerminal, isTerminalOrHonor,
  suitOf, counts, FLOWER0, SEASON0, RED,
} from './tiles.js';

export const DEFAULT_RULES = { minFaan: 3, maxFaan: 10, sevenPairs: false, bonusTiles: true };

// Base table ("half-spicy" style): what a discarder pays at each faan. Self-drawn wins
// are paid by all three opponents at half this each (1.5x total), so self-draws pay more.
export const BASE_TABLE = [2, 4, 8, 16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768];

export function baseValue(faan, unit = 1) {
  const i = Math.max(0, Math.min(BASE_TABLE.length - 1, faan));
  return BASE_TABLE[i] * unit;
}

// ---------- decomposition ----------

// All ways to split concealed tile counts into `needSets` sets (pung/chow) + one pair.
export function decompose(c, needSets) {
  const out = [];
  const cc = c.slice();
  for (let p = 0; p < KINDS; p++) {
    if (cc[p] < 2) continue;
    cc[p] -= 2;
    const sets = [];
    splitSets(cc, 0, needSets, sets, (s) => out.push({ pair: p, sets: s.slice() }));
    cc[p] += 2;
  }
  return out;
}

function splitSets(c, from, need, acc, emit) {
  let i = from;
  while (i < KINDS && c[i] === 0) i++;
  if (i === KINDS) { if (need === 0) emit(acc); return; }
  if (need === 0) return;
  if (c[i] >= 3) {
    c[i] -= 3; acc.push({ type: 'pung', tile: i });
    splitSets(c, i, need - 1, acc, emit);
    acc.pop(); c[i] += 3;
  }
  if (isSuited(i) && i % 9 <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--; acc.push({ type: 'chow', tile: i });
    splitSets(c, i, need - 1, acc, emit);
    acc.pop(); c[i]++; c[i + 1]++; c[i + 2]++;
  }
}

const ORPHANS = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

export function isThirteenOrphans(c) {
  let pair = false;
  for (const k of ORPHANS) {
    if (c[k] === 0) return false;
    if (c[k] === 2) { if (pair) return false; pair = true; } else if (c[k] > 2) return false;
  }
  return pair && c.reduce((a, b) => a + b, 0) === 14;
}

export function isSevenPairs(c) {
  let pairs = 0; let total = 0;
  for (const n of c) { total += n; if (n === 2) pairs++; else if (n !== 0) return false; }
  return total === 14 && pairs === 7;
}

// Is this a complete hand shape (ignoring faan)?
export function isWinningShape(concealed, meldCount, rules = DEFAULT_RULES) {
  const c = counts(concealed);
  if (meldCount === 0 && isThirteenOrphans(c)) return true;
  if (meldCount === 0 && rules.sevenPairs && isSevenPairs(c)) return true;
  return decompose(c, 4 - meldCount).length > 0;
}

// ---------- scoring ----------

/*
 ctx = {
   concealed: kinds[]  (concealed tiles, including the winning tile)
   melds: [{ type: 'chow'|'pung'|'kong', tile, concealed }]   (tile = lowest kind)
   winTile, selfDrawn, seatWind (0-3), roundWind (0-3), bonus: kinds[],
   lastTile, kongReplacement, robbingKong, heavenly, earthly,
   rules: { minFaan, maxFaan, sevenPairs, bonusTiles }
 }
 Returns the best { faan, items: [{ name, faan }], limit, pattern } or null if not a winning shape.
*/
export function scoreHand(ctx) {
  const rules = { ...DEFAULT_RULES, ...(ctx.rules || {}) };
  const melds = ctx.melds || [];
  const c = counts(ctx.concealed);
  const candidates = [];

  if (melds.length === 0 && isThirteenOrphans(c)) {
    candidates.push(finish(ctx, rules, [{ name: 'Thirteen Orphans', limit: true }], 'thirteenOrphans'));
  }
  if (melds.length === 0 && rules.sevenPairs && isSevenPairs(c)) {
    candidates.push(scoreSevenPairs(ctx, rules, c));
  }
  for (const d of decompose(c, 4 - melds.length)) {
    // Which concealed group did the winning tile complete? (Matters for concealed pungs on a discard.)
    const groups = [{ kind: 'pair', tile: d.pair }, ...d.sets.map((s) => ({ kind: s.type, tile: s.tile }))];
    const winGroups = groups.filter((g) => (g.kind === 'chow' ? ctx.winTile >= g.tile && ctx.winTile <= g.tile + 2 : g.tile === ctx.winTile));
    for (const wg of winGroups.length ? winGroups : [null]) {
      candidates.push(scoreStandard(ctx, rules, d, wg));
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.faan - a.faan || b.items.length - a.items.length);
  return candidates[0];
}

function bonusItems(ctx, rules) {
  const items = [];
  if (!rules.bonusTiles) return items;
  const bonus = ctx.bonus || [];
  if (!bonus.length) { items.push({ name: 'No Flowers', faan: 1 }); return items; }
  const flowers = bonus.filter((k) => k >= FLOWER0 && k < SEASON0);
  const seasons = bonus.filter((k) => k >= SEASON0);
  const seatFlower = FLOWER0 + ctx.seatWind;
  const seatSeason = SEASON0 + ctx.seatWind;
  if (flowers.length === 4) items.push({ name: 'All Four Flowers', faan: 2 });
  else if (flowers.includes(seatFlower)) items.push({ name: 'Seat Flower', faan: 1 });
  if (seasons.length === 4) items.push({ name: 'All Four Seasons', faan: 2 });
  else if (seasons.includes(seatSeason)) items.push({ name: 'Seat Season', faan: 1 });
  return items;
}

function situationItems(ctx) {
  const items = [];
  if (ctx.selfDrawn) items.push({ name: 'Self-Drawn', faan: 1 });
  if (ctx.lastTile) items.push({ name: ctx.selfDrawn ? 'Last Tile Draw' : 'Last Discard', faan: 1 });
  if (ctx.kongReplacement) items.push({ name: 'Win on a Kong', faan: 1 });
  if (ctx.robbingKong) items.push({ name: 'Robbing the Kong', faan: 1 });
  return items;
}

function scoreSevenPairs(ctx, rules, c) {
  const items = [{ name: 'Seven Pairs', faan: 4 }];
  const kinds = [];
  c.forEach((n, k) => { if (n) kinds.push(k); });
  addSuitItems(items, kinds);
  if (kinds.every(isHonor)) return finish(ctx, rules, [{ name: 'All Honors', limit: true }], 'sevenPairs');
  items.push({ name: 'Concealed Hand', faan: 1 });
  items.push(...situationItems(ctx), ...bonusItems(ctx, rules));
  return finish(ctx, rules, items, 'sevenPairs');
}

function addSuitItems(items, kinds) {
  const suits = new Set(kinds.filter(isSuited).map(suitOf));
  const honors = kinds.some(isHonor);
  if (suits.size === 1 && !honors) items.push({ name: 'Pure One Suit', faan: 7 });
  else if (suits.size === 1 && honors) items.push({ name: 'Mixed One Suit', faan: 3 });
}

function scoreStandard(ctx, rules, d, winGroup) {
  const melds = ctx.melds || [];
  const sets = [
    ...d.sets.map((s, i) => ({ ...s, concealed: true, kong: false, idx: i })),
    ...melds.map((m) => ({ type: m.type === 'chow' ? 'chow' : 'pung', tile: m.tile, concealed: !!m.concealed, kong: m.type === 'kong' })),
  ];
  // A pung completed by someone else's discard counts as exposed.
  if (!ctx.selfDrawn && winGroup && winGroup.kind === 'pung') {
    const s = sets.find((x) => x.type === 'pung' && x.concealed && !x.kong && x.tile === winGroup.tile && x.idx !== undefined);
    if (s) s.concealed = false;
  }
  const pair = d.pair;
  const pungs = sets.filter((s) => s.type === 'pung');
  const chows = sets.filter((s) => s.type === 'chow');
  const kinds = [pair];
  for (const s of sets) { if (s.type === 'chow') kinds.push(s.tile, s.tile + 1, s.tile + 2); else kinds.push(s.tile); }
  const fullyConcealed = melds.every((m) => m.concealed);

  const limits = [];
  if (ctx.heavenly) limits.push({ name: 'Heavenly Hand', limit: true });
  if (ctx.earthly) limits.push({ name: 'Earthly Hand', limit: true });
  const windPungs = pungs.filter((s) => isWind(s.tile)).length;
  if (windPungs === 4) limits.push({ name: 'Great Four Winds', limit: true });
  else if (windPungs === 3 && isWind(pair)) limits.push({ name: 'Small Four Winds', limit: true });
  if (kinds.every(isHonor)) limits.push({ name: 'All Honors', limit: true });
  if (kinds.every(isTerminal)) limits.push({ name: 'All Terminals', limit: true });
  if (pungs.length === 4 && pungs.every((s) => s.concealed)) limits.push({ name: 'Four Concealed Pungs', limit: true });
  if (sets.filter((s) => s.kong).length === 4) limits.push({ name: 'Four Kongs', limit: true });
  if (melds.length === 0 && isNineGates(counts(ctx.concealed))) limits.push({ name: 'Nine Gates', limit: true });
  if (limits.length) return finish(ctx, rules, limits, 'standard', d);

  const items = [];
  if (fullyConcealed) items.push({ name: 'Concealed Hand', faan: 1 });
  if (chows.length === 4) items.push({ name: 'All Chows', faan: 1 });
  if (pungs.length === 4) items.push({ name: 'All Pungs', faan: 3 });
  addSuitItems(items, kinds);
  if (kinds.every(isTerminalOrHonor) && kinds.some(isHonor) && kinds.some(isTerminal)) items.push({ name: 'Mixed Terminals', faan: 1 });

  const dragonPungs = pungs.filter((s) => isDragon(s.tile)).length;
  if (dragonPungs === 3) items.push({ name: 'Great Three Dragons', faan: 8 });
  else if (dragonPungs === 2 && isDragon(pair)) items.push({ name: 'Small Three Dragons', faan: 5 });
  else for (const s of pungs) if (isDragon(s.tile)) items.push({ name: `${['Red', 'Green', 'White'][s.tile - RED]} Dragon Pung`, faan: 1 });

  for (const s of pungs) {
    if (!isWind(s.tile)) continue;
    const w = s.tile - EAST;
    if (w === ctx.seatWind) items.push({ name: 'Seat Wind', faan: 1 });
    if (w === ctx.roundWind) items.push({ name: 'Round Wind', faan: 1 });
  }
  items.push(...situationItems(ctx), ...bonusItems(ctx, rules));
  return finish(ctx, rules, items, 'standard', d);
}

function isNineGates(c) {
  for (let s = 0; s < 3; s++) {
    const b = s * 9;
    let total = 0;
    for (let i = 0; i < 9; i++) total += c[b + i];
    if (total !== 14) continue;
    const need = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    if (need.every((n, i) => c[b + i] >= n)) return true;
  }
  return false;
}

function finish(ctx, rules, items, pattern, d = null) {
  const limit = items.some((i) => i.limit);
  const shown = limit ? items.filter((i) => i.limit).map((i) => ({ name: i.name, faan: rules.maxFaan })) : items;
  const raw = limit ? rules.maxFaan : shown.reduce((a, i) => a + i.faan, 0);
  return {
    faan: Math.min(rules.maxFaan, raw),
    rawFaan: raw,
    items: shown,
    limit,
    pattern,
    pair: d ? d.pair : null,
    sets: d ? d.sets : null,
  };
}

// ---------- payouts ----------

// Returns per-seat deltas (index = seat). `discarder` is null for self-drawn.
export function payouts({ winner, discarder, faan, unit = 1, seats = 4 }) {
  const delta = new Array(seats).fill(0);
  const v = baseValue(faan, unit);
  if (discarder === null || discarder === undefined) {
    const each = Math.ceil(v / 2);
    for (let s = 0; s < seats; s++) if (s !== winner) { delta[s] -= each; delta[winner] += each; }
  } else {
    delta[discarder] -= v;
    delta[winner] += v;
  }
  return delta;
}

// ---------- shanten (for bots and the "ready" hint) ----------

// Minimum tiles away from ready (0 = ready/tenpai, -1 = complete).
export function shanten(concealed, meldCount = 0, rules = DEFAULT_RULES) {
  const c = counts(concealed);
  let best = standardShanten(c, meldCount);
  if (meldCount === 0) {
    best = Math.min(best, orphansShanten(c));
    if (rules.sevenPairs) best = Math.min(best, sevenPairsShanten(c));
  }
  return best;
}

function orphansShanten(c) {
  let kinds = 0; let pair = 0;
  for (const k of ORPHANS) { if (c[k]) kinds++; if (c[k] >= 2) pair = 1; }
  return 13 - kinds - pair;
}

function sevenPairsShanten(c) {
  let pairs = 0; let kinds = 0;
  for (const n of c) { if (n) kinds++; if (n >= 2) pairs++; }
  return 6 - pairs + Math.max(0, 7 - kinds);
}

export function standardShanten(c, meldCount = 0) {
  const cc = c.slice();
  const need = 4 - meldCount;
  let best = 2 * need;
  const search = (i, sets, partials, pair) => {
    while (i < KINDS && cc[i] === 0) i++;
    if (i >= KINDS) {
      let p = partials;
      if (sets + p > need) p = need - sets;
      const s = 2 * (need - sets) - p - pair;
      if (s < best) best = s;
      return;
    }
    // Sets first.
    if (cc[i] >= 3) { cc[i] -= 3; search(i, sets + 1, partials, pair); cc[i] += 3; }
    if (isSuited(i) && i % 9 <= 6 && cc[i + 1] && cc[i + 2]) {
      cc[i]--; cc[i + 1]--; cc[i + 2]--; search(i, sets + 1, partials, pair); cc[i]++; cc[i + 1]++; cc[i + 2]++;
    }
    // Pair (head) once.
    if (!pair && cc[i] >= 2) { cc[i] -= 2; search(i, sets, partials, 1); cc[i] += 2; }
    // Partials.
    if (cc[i] >= 2) { cc[i] -= 2; search(i, sets, partials + 1, pair); cc[i] += 2; }
    if (isSuited(i) && i % 9 <= 7 && cc[i + 1]) { cc[i]--; cc[i + 1]--; search(i, sets, partials + 1, pair); cc[i]++; cc[i + 1]++; }
    if (isSuited(i) && i % 9 <= 6 && cc[i + 2]) { cc[i]--; cc[i + 2]--; search(i, sets, partials + 1, pair); cc[i]++; cc[i + 2]++; }
    // Isolated.
    cc[i]--; search(i, sets, partials, pair); cc[i]++;
  };
  search(0, 0, 0, 0);
  return best; // -1 = complete, 0 = ready
}

// Tiles that would complete this 13-tile (or 13-3n) hand, by kind.
export function waits(concealed, meldCount = 0, rules = DEFAULT_RULES) {
  const out = [];
  for (let k = 0; k < KINDS; k++) {
    if (isWinningShape([...concealed, k], meldCount, rules)) out.push(k);
  }
  return out;
}
