// Computer opponents for Hong Kong Mahjong. Pure decision logic: given the table and a seat,
// return an action.
//
// How a bot thinks:
//  1. Shanten: how many tiles it is from a ready hand, and how many live tiles would improve it
//     ("ukeire"). Fewer steps and more outs are better.
//  2. Faan plan: a win needs the table's minimum faan, so Medium/Hard bots steer toward a
//     scoring hand — a one-suit flush, honor pungs, all pungs, or staying concealed — and
//     won't open their hand with claims that kill their only way to score.
//  3. Defense (Hard): late in the hand, when someone looks close, it prefers tiles that are
//     already out on the table.
// Every bot gets a small random personality so two Medium bots don't play identically.

import { KINDS, isSuited, isHonor, isDragon, isWind, suitOf, counts, EAST, FLOWER0, SEASON0 } from './tiles.js';
import { shanten, waits, scoreHand } from './scoring.js';

export const BOT_LEVELS = ['easy', 'medium', 'hard'];
export const LEVEL_LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

const NAMES = [
  'Auntie Mei', 'Uncle Wing', 'Lucky Chan', 'Madame Ho', 'Big Kwok', 'Jade', 'Mr. Lau', 'Golden Lily',
  'Tony Fung', 'Grandma Siu', 'Eddie', 'Pearl', 'Kenny Tam', 'Ruby', 'Mr. Ng', 'Stanley',
  'Auntie Fong', 'Benny Wu', 'Crystal', 'Mr. Cheung', 'Peony', 'Vincent', 'Lotus', 'Old Master Li',
];

export function pickBotName(taken, rng = Math.random) {
  const free = NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(rng() * free.length)];
  for (let i = 2; ; i++) { const n = `Bot ${i}`; if (!taken.has(n)) return n; }
}

const PROFILES = {
  // Chases the fastest hand, ignores faan, claims almost everything, never defends.
  easy: { plan: 0, defense: 0, visible: false, claimSlack: -2, mistakes: 0.18, think: [700, 1600] },
  // Tile-efficient with a faan plan.
  medium: { plan: 1, defense: 0, visible: false, claimSlack: 0, mistakes: 0.03, think: [800, 2000] },
  // Counts visible tiles, plans for faan, defends late.
  hard: { plan: 1, defense: 1, visible: true, claimSlack: 0.5, mistakes: 0, think: [900, 2400] },
};

export function makeBotProfile(level, rng = Math.random) {
  const base = PROFILES[level] || PROFILES.medium;
  return { level: PROFILES[level] ? level : 'medium', ...base, flushLean: 0.8 + rng() * 0.5, pungLean: 0.8 + rng() * 0.5 };
}

export function thinkTime(table, seat, profile, rng = Math.random) {
  const [a, b] = profile.think;
  const legal = table.legalActions(seat);
  const quick = legal && legal.type !== 'turn' ? 0.6 : 1;
  const speed = Number(process.env.MJ_BOT_SPEED) || 1; // tests run bots faster
  return Math.round(((a + rng() * (b - a)) * quick) / speed);
}

// ---------------- evaluation ----------------

// Tiles not visible to this seat (for counting outs).
function liveCounts(table, seat, useVisible) {
  const live = new Array(KINDS).fill(4);
  const me = table.seats[seat];
  for (const t of me.hand) if (t < KINDS) live[t]--;
  if (!useVisible) return live;
  for (const p of table.seats) {
    if (!p) continue;
    for (const t of p.discards) live[t]--;
    for (const m of p.melds) for (const t of m.tiles) live[t]--;
  }
  return live.map((n) => Math.max(0, n));
}

function ukeire(hand, meldCount, base, live, rules) {
  let n = 0;
  for (let k = 0; k < KINDS; k++) {
    if (!live[k]) continue;
    hand.push(k);
    if (shanten(hand, meldCount, rules) < base) n += live[k];
    hand.pop();
  }
  return n;
}

// Rough faan this hand could reach, and so how far short of the minimum it is.
function faanPotential(table, seat, hand, melds, profile) {
  const t = table;
  const p = t.seats[seat];
  const rules = t.rules;
  const seatWind = t.seatWind(seat);
  const c = counts(hand);
  for (const m of melds) for (const k of m.tiles) c[k]++;
  let fixed = 0;
  if (rules.bonusTiles) {
    if (!p.bonus.length) fixed += 1;
    const f = p.bonus.filter((k) => k < SEASON0);
    const s = p.bonus.filter((k) => k >= SEASON0);
    fixed += f.length === 4 ? 2 : f.includes(FLOWER0 + seatWind) ? 1 : 0;
    fixed += s.length === 4 ? 2 : s.includes(SEASON0 + seatWind) ? 1 : 0;
  }
  const concealed = melds.every((m) => m.concealed);
  if (concealed) fixed += 1;
  // Value honors: dragons, seat wind, round wind.
  let honors = 0;
  for (let k = 27; k < KINDS; k++) {
    let v = 0;
    if (isDragon(k)) v = 1;
    if (isWind(k)) v = (k - EAST === seatWind ? 1 : 0) + (k - EAST === t.roundWind ? 1 : 0);
    if (!v) continue;
    if (c[k] >= 3) honors += v;
    else if (c[k] === 2) honors += v * 0.45;
  }
  // One-suit flush.
  const suitCount = [0, 0, 0];
  let honorTiles = 0;
  for (let k = 0; k < KINDS; k++) { if (k < 27) suitCount[Math.floor(k / 9)] += c[k]; else honorTiles += c[k]; }
  const dom = suitCount.indexOf(Math.max(...suitCount));
  const off = suitCount.reduce((a, n, i) => a + (i === dom ? 0 : n), 0);
  const meldOff = melds.some((m) => isSuited(m.tile) && Math.floor(m.tile / 9) !== dom);
  const flush = meldOff ? 0 : off === 0 ? (honorTiles ? 3 : 7) : 3 * Math.max(0, 1 - off / 5.5) * profile.flushLean;
  // All pungs.
  let pairs = 0;
  for (let k = 0; k < KINDS; k++) if (c[k] >= 2) pairs++;
  const chowMeld = melds.some((m) => m.type === 'chow');
  const pung = chowMeld ? 0 : pairs >= 5 ? 3 : pairs >= 4 ? 2 : pairs >= 3 ? 0.8 : 0;
  return fixed + honors + Math.max(flush, pung * profile.pungLean) + 0.4; // + a little for self-draw / luck
}

// Danger of discarding k (Hard only): tiles already out are safer late in the hand.
function danger(table, seat, k) {
  const t = table;
  let threat = 0;
  for (let s = 0; s < 4; s++) {
    if (s === seat || !t.seats[s]) continue;
    const q = t.seats[s];
    const open = q.melds.filter((m) => !m.concealed).length;
    threat = Math.max(threat, open >= 3 ? 1 : open === 2 ? 0.5 : q.discards.length > 10 ? 0.35 : 0);
  }
  if (!threat) return 0;
  const seen = t.seats.reduce((n, q) => n + (q ? q.discards.filter((x) => x === k).length : 0), 0);
  let d = seen >= 2 ? 0.1 : seen === 1 ? 0.45 : 1;
  if (isHonor(k) && seen === 0) d = 1.2;
  return d * threat * (t.wall.length < 30 ? 1.6 : 0.6);
}

// Real faan of a ready hand's waits: how many live outs actually pay the minimum.
function readyValue(table, seat, hand, melds, live) {
  const t = table;
  const p = t.seats[seat];
  const rules = t.rules;
  let outs = 0;
  for (const w of waits(hand, melds.length, rules)) {
    if (!live[w]) continue;
    const ctx = {
      concealed: [...hand, w], melds: melds.map((m) => ({ type: m.type, tile: m.tile, concealed: m.concealed })),
      winTile: w, seatWind: t.seatWind(seat), roundWind: t.roundWind, bonus: p.bonus, rules,
    };
    const ron = scoreHand({ ...ctx, selfDrawn: false });
    const tsumo = ron && ron.faan >= rules.minFaan ? ron : scoreHand({ ...ctx, selfDrawn: true });
    if (ron && ron.faan >= rules.minFaan) outs += live[w];
    else if (tsumo && tsumo.faan >= rules.minFaan) outs += live[w] * 0.3;
  }
  return outs;
}

// Score a 13-tile (13 - 3n) position. Higher is better.
function evaluate(table, seat, hand, melds, profile, live) {
  const rules = table.rules;
  const sh = shanten(hand, melds.length, rules);
  let score = -sh * 10;
  if (sh === 0 && profile.plan) {
    const outs = readyValue(table, seat, hand, melds, live);
    // A ready hand that can't pay the minimum is worth about as much as being two steps away.
    score += outs > 0 ? 4 + outs * 0.5 : -18;
    return { score, shanten: sh };
  }
  if (sh <= 2) score += ukeire(hand, melds.length, sh, live, rules) * 0.25;
  else score += isolatedPenalty(hand);
  if (profile.plan) {
    const pot = faanPotential(table, seat, hand, melds, profile);
    const short = Math.max(0, rules.minFaan - pot);
    score -= short * 7;
  }
  return { score, shanten: sh };
}

function isolatedPenalty(hand) {
  const c = counts(hand);
  let s = 0;
  for (let k = 0; k < KINDS; k++) {
    if (!c[k]) continue;
    if (c[k] >= 2) { s += 0.5; continue; }
    if (isSuited(k)) {
      const r = k % 9;
      const near = [-2, -1, 1, 2].some((d) => r + d >= 0 && r + d <= 8 && c[k + d]);
      s += near ? 0.3 : r === 0 || r === 8 ? -0.3 : -0.1;
    } else s -= 0.4;
  }
  return s;
}

function bestDiscard(table, seat, hand, melds, profile, rng) {
  const live = liveCounts(table, seat, profile.visible);
  const tried = new Map();
  for (const k of new Set(hand)) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(k), 1);
    let { score } = evaluate(table, seat, rest, melds, profile, live);
    if (profile.defense) score -= danger(table, seat, k) * 6;
    tried.set(k, score);
  }
  let best = null; let bestScore = -Infinity;
  for (const [k, s] of tried) if (s > bestScore || (s === bestScore && isHonor(k))) { best = k; bestScore = s; }
  if (profile.mistakes && rng() < profile.mistakes) {
    const keys = [...tried.keys()].sort((a, b) => tried.get(b) - tried.get(a));
    best = keys[Math.min(keys.length - 1, 1 + Math.floor(rng() * 2))];
    bestScore = tried.get(best);
  }
  return { tile: best, score: bestScore };
}

// ---------------- decisions ----------------

export function decide(table, seat, profile, rng = Math.random) {
  const legal = table.legalActions(seat);
  if (!legal) return null;
  const p = table.seats[seat];
  if (legal.type === 'turn') {
    if (legal.win?.ok) return { action: 'win' };
    for (const k of legal.kongs) {
      const n = p.hand.filter((x) => x === k).length;
      if (n === 1) return { action: 'kong', data: { tile: k } }; // add to an exposed pung: a free extra draw
      const one = p.hand.slice(); one.splice(one.indexOf(k), 1);
      const before = shanten(one, p.melds.length, table.rules);
      const after = shanten(p.hand.filter((x) => x !== k), p.melds.length + 1, table.rules);
      if (profile.level === 'easy' || after <= before) return { action: 'kong', data: { tile: k } };
    }
    const { tile } = bestDiscard(table, seat, p.hand, p.melds, profile, rng);
    return { action: 'discard', data: { tile } };
  }
  if (legal.type === 'robkong') return { action: legal.win?.ok ? 'win' : 'pass' };
  // Claim window.
  if (legal.win?.ok) return { action: 'win' };
  const tile = legal.tile;
  const live = liveCounts(table, seat, profile.visible);
  const now = evaluate(table, seat, p.hand, p.melds, profile, live).score;
  let best = { action: 'pass', score: now + profile.claimSlack + 0.5 };
  const tryMeld = (action, remove, meld) => {
    const hand = p.hand.slice();
    for (const r of remove) hand.splice(hand.indexOf(r), 1);
    const melds = [...p.melds, meld];
    if (action === 'kong') {
      // A kong draws a replacement: judge the 13-3n hand as-is.
      const s = evaluate(table, seat, hand, melds, profile, live).score + 1;
      if (s > best.score) best = { action, score: s };
      return;
    }
    const d = bestDiscard(table, seat, hand, melds, profile, () => 1);
    if (d.score > best.score) best = { action, score: d.score, tiles: meld.claimTiles };
  };
  if (legal.kong) tryMeld('kong', [tile, tile, tile], { type: 'kong', tile, tiles: [tile, tile, tile, tile], concealed: false });
  if (legal.pung) tryMeld('pung', [tile, tile], { type: 'pung', tile, tiles: [tile, tile, tile], concealed: false });
  for (const ch of legal.chows || []) {
    const tiles = [ch[0], ch[1], tile].sort((a, b) => a - b);
    tryMeld('chow', ch, { type: 'chow', tile: tiles[0], tiles, concealed: false, claimTiles: ch });
  }
  if (profile.level === 'easy' && best.action === 'pass' && (legal.pung || legal.chows?.length) && rng() < 0.35) {
    return legal.pung ? { action: 'pung' } : { action: 'chow', data: { tiles: legal.chows[0] } };
  }
  return best.action === 'chow' ? { action: 'chow', data: { tiles: best.tiles } } : { action: best.action };
}

// ---------------- table talk ----------------
const LINES = {
  win: ['Sik wu! \u{1F004}', 'Mahjong!', 'Thank you, thank you.', 'The tiles love me today.', 'Pay up, friends!', 'Heh. Lucky draw.'],
  big: ['That one’s going on the wall at home.', 'Did you see that hand?!', 'Big money!'],
  dealin: ['Aiya…', 'I should’ve kept that one.', 'Ugh, my fault.'],
  drawGame: ['Nobody? Shuffle up.', 'A draw. Again!'],
};
export function botLine(kind, rng = Math.random) {
  const l = LINES[kind] || LINES.win;
  return l[Math.floor(rng() * l.length)];
}
