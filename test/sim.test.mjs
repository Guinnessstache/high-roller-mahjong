import test from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../server/mahjong.js';
import { makeBotProfile, decide } from '../server/bots.js';

// Drive a table with bots until the game ends. Returns stats.
export function playGame({ levels = ['medium', 'medium', 'medium', 'medium'], rules = {}, rounds = 1, check = true } = {}) {
  const t = new Table({ rules, rounds, unit: 1 });
  levels.forEach((l, i) => t.sit(i, { id: `b${i}`, name: `B${i}`, points: 0 }));
  const profiles = levels.map((l) => makeBotProfile(l));
  t.newGame(1000);
  const stats = { hands: 0, wins: [0, 0, 0, 0], selfDrawn: 0, draws: 0, faan: [], items: {} };
  while (!t.gameOver) {
    assert.ok(t.startHand());
    let guard = 0;
    while (t.phase !== 'over') {
      if (++guard > 2000) throw new Error('hand did not finish');
      if (t.phase === 'turn') {
        const s = t.toAct;
        const d = decide(t, s, profiles[s]);
        const r = t.act(s, d.action, d.data || {});
        assert.ok(r.ok, `${d.action} failed: ${r.error}`);
      } else {
        for (const s of t.pendingClaimants()) {
          if (t.phase !== 'claim' && t.phase !== 'robkong') break;
          if (!t.claims || !t.claims[s]) continue;
          const d = decide(t, s, profiles[s]);
          const r = t.act(s, d.action, d.data || {});
          assert.ok(r.ok, `${d.action} failed: ${r.error}`);
        }
      }
      if (check) {
        // Every tile accounted for.
        let n = t.wall.length + (t.pendingKong ? 1 : 0);
        for (const p of t.seats) n += p.hand.length + p.bonus.length + p.discards.length + p.melds.reduce((a, m) => a + m.tiles.length, 0);
        assert.equal(n, t.wallTotal);
      }
    }
    t.drainEvents();
    const r = t.lastResults;
    stats.hands++;
    if (r.type === 'draw') stats.draws++;
    else {
      stats.wins[r.winner]++;
      if (r.selfDrawn) stats.selfDrawn++;
      stats.faan.push(r.faan);
      for (const i of r.items) stats.items[i.name] = (stats.items[i.name] || 0) + 1;
      assert.ok(r.faan >= t.rules.minFaan);
    }
    assert.equal(t.seats.reduce((a, p) => a + p.points, 0), 4000);
    t.endHandCleanup();
  }
  return stats;
}

test('bot games run to completion with consistent tiles and points', () => {
  for (let g = 0; g < 6; g++) playGame({ levels: ['easy', 'medium', 'hard', 'medium'] });
  playGame({ rules: { minFaan: 0, bonusTiles: false } });
  playGame({ rules: { sevenPairs: true, minFaan: 1 } });
});
