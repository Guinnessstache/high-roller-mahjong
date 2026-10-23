// Works out which achievements each seat earned in the hand (or game) that just finished.
// The game on each player's PC does the actual unlocking (on their own Steam account).

/**
 * @param {import('./mahjong.js').Table} table  finished hand (phase 'over', before cleanup)
 * @param {{ isHuman: (seat:number)=>boolean }} ctx
 * @returns {Map<number, { ids: Set<string>, stats: { hands: number, wins: number } }>}
 */
export function handAwards(table, ctx) {
  const out = new Map();
  const get = (s) => {
    if (!out.has(s)) out.set(s, { ids: new Set(), stats: { hands: 0, wins: 0 } });
    return out.get(s);
  };
  const r = table.lastResults;
  if (!r) return out;
  const seats = table.seats.map((p, i) => (p && p.inHand ? i : -1)).filter((i) => i >= 0);
  const humans = seats.filter((s) => ctx.isHuman(s)).length;
  for (const s of seats) {
    const a = get(s);
    a.stats.hands = 1;
    a.ids.add('FIRST_HAND');
    if (humans >= 2 && ctx.isHuman(s)) a.ids.add('FRIENDLY_GAME');
  }
  if (r.type !== 'win') return out;
  const a = get(r.winner);
  a.stats.wins = 1;
  a.ids.add('FIRST_WIN');
  const names = new Set(r.items.map((i) => i.name));
  if (r.selfDrawn) a.ids.add('SELF_DRAWN');
  if (r.melds.every((m) => m.concealed)) a.ids.add('CONCEALED_WIN');
  if (names.has('Win on a Kong')) a.ids.add('KONG_WIN');
  if (r.robbingKong) a.ids.add('ROB_KONG');
  if (names.has('All Pungs')) a.ids.add('ALL_PUNGS');
  if (names.has('Mixed One Suit')) a.ids.add('MIXED_SUIT');
  if (names.has('Pure One Suit')) a.ids.add('PURE_SUIT');
  if (names.has('Small Three Dragons') || names.has('Great Three Dragons')) a.ids.add('DRAGONS');
  if (r.limit) a.ids.add('LIMIT_HAND');
  if (names.has('Thirteen Orphans')) a.ids.add('THIRTEEN_ORPHANS');
  if (names.has('Heavenly Hand')) a.ids.add('HEAVENLY');
  return out;
}

/** End of a game: the leader gets GAME_WIN (and HARD_WIN against three Hard bots). */
export function gameAwards(table, ctx) {
  const out = new Map();
  const st = table.gameResults;
  if (!st?.length) return out;
  const top = st[0];
  if (st[1] && st[1].points === top.points) return out; // shared first place doesn't count
  const ids = new Set(['GAME_WIN']);
  const others = [0, 1, 2, 3].filter((s) => s !== top.seat);
  if (others.every((s) => ctx.botLevel(s) === 'hard')) ids.add('HARD_WIN');
  out.set(top.seat, { ids, stats: { hands: 0, wins: 0 } });
  return out;
}
