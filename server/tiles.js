// Tile set shared by the server and the browser (served at /shared/tiles.js).
//
// A tile "kind" is a number:
//   0-8   Characters 1-9 (萬)      9-17  Dots 1-9 (筒)      18-26 Bamboo 1-9 (索)
//   27-30 Winds East, South, West, North
//   31-33 Dragons Red (中), Green (發), White (白)
//   34-37 Flowers Plum, Orchid, Chrysanthemum, Bamboo (bonus, one each)
//   38-41 Seasons Spring, Summer, Autumn, Winter (bonus, one each)

export const KINDS = 34; // playable (non-bonus) kinds
export const EAST = 27, SOUTH = 28, WEST = 29, NORTH = 30;
export const RED = 31, GREEN = 32, WHITE = 33;
export const FLOWER0 = 34, SEASON0 = 38;

export const SUITS = ['m', 'p', 's'];
export const SUIT_NAME = { m: 'Characters', p: 'Dots', s: 'Bamboo' };
export const WIND_NAME = ['East', 'South', 'West', 'North'];
export const DRAGON_NAME = ['Red', 'Green', 'White'];
export const FLOWER_NAME = ['Plum', 'Orchid', 'Chrysanthemum', 'Bamboo'];
export const SEASON_NAME = ['Spring', 'Summer', 'Autumn', 'Winter'];

export const isSuited = (k) => k < 27;
export const isHonor = (k) => k >= 27 && k < 34;
export const isWind = (k) => k >= 27 && k <= 30;
export const isDragon = (k) => k >= 31 && k <= 33;
export const isBonus = (k) => k >= 34;
export const isTerminal = (k) => k < 27 && (k % 9 === 0 || k % 9 === 8);
export const isTerminalOrHonor = (k) => isTerminal(k) || isHonor(k);
export const suitOf = (k) => (k < 27 ? SUITS[Math.floor(k / 9)] : null);
export const rankOf = (k) => (k < 27 ? (k % 9) + 1 : 0);

export function tileName(k) {
  if (k < 27) return `${rankOf(k)} ${SUIT_NAME[suitOf(k)]}`;
  if (isWind(k)) return `${WIND_NAME[k - 27]} Wind`;
  if (isDragon(k)) return `${DRAGON_NAME[k - 31]} Dragon`;
  if (k < 38) return `${FLOWER_NAME[k - 34]} (Flower ${k - 33})`;
  return `${SEASON_NAME[k - 38]} (Season ${k - 37})`;
}

// Short code: 1m..9m, 1p..9p, 1s..9s, E S W N, R G Wh, f1..f4, s1..s4 — handy in tests and logs.
export function tileCode(k) {
  if (k < 27) return `${rankOf(k)}${suitOf(k)}`;
  if (isWind(k)) return 'ESWN'[k - 27];
  if (isDragon(k)) return ['R', 'G', 'Wh'][k - 31];
  if (k < 38) return `f${k - 33}`;
  return `x${k - 37}`;
}

export function parseTiles(str) {
  // "123m 456p 77s EEE R" -> kinds. Digit runs bind to the suit letter that follows them.
  const out = [];
  const re = /([1-9]+)([mps])|(Wh|E|S|W|N|R|G)|f([1-4])|x([1-4])/g;
  let m;
  while ((m = re.exec(str))) {
    if (m[1]) for (const d of m[1]) out.push(SUITS.indexOf(m[2]) * 9 + Number(d) - 1);
    else if (m[3]) out.push({ E: EAST, S: SOUTH, W: WEST, N: NORTH, R: RED, G: GREEN, Wh: WHITE }[m[3]]);
    else if (m[4]) out.push(FLOWER0 + Number(m[4]) - 1);
    else if (m[5]) out.push(SEASON0 + Number(m[5]) - 1);
  }
  return out;
}

export const sortTiles = (a) => a.slice().sort((x, y) => x - y);

export function fullSet(withBonus = true) {
  const tiles = [];
  for (let k = 0; k < KINDS; k++) for (let c = 0; c < 4; c++) tiles.push(k);
  if (withBonus) for (let k = FLOWER0; k < FLOWER0 + 8; k++) tiles.push(k);
  return tiles;
}

export function counts(tiles) {
  const c = new Array(KINDS).fill(0);
  for (const t of tiles) if (t < KINDS) c[t]++;
  return c;
}
