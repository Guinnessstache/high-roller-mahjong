// End-to-end: a real server, one human client vs three auto-fill bots, playing a whole hand
// by always discarding the drawn tile and passing claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { startServer } from '../server/index.js';
import { rooms } from '../server/rooms.js';

process.env.MJ_BOT_SPEED = '20';

test('a human plays a hand against bots over Socket.IO', { timeout: 240000 }, async () => {
  const srv = await startServer({ port: 0, quiet: true });
  const c = io(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'] });
  const call = (ev, d = {}) => new Promise((r) => c.emit(ev, d, r));
  let state = null;
  let results = null;
  c.on('state', (s) => { state = s; });
  c.on('events', (ev) => { for (const e of ev) if (e.type === 'win' || e.type === 'drawGame') results = e; });
  await new Promise((r) => c.on('connect', r));
  const res = await call('create', { name: 'Tester', key: 'k'.repeat(20), settings: { actionTime: 8, claimTime: 4 } });
  assert.ok(res.ok, res.error);
  const st = await call('start');
  assert.ok(st.ok, st.error);
  const started = Date.now();
  let acted = 0;
  // Play: whenever it's our turn discard the drawn tile; pass every claim (unless we can win).
  while (!results && Date.now() - started < 220000) {
    await new Promise((r) => setTimeout(r, 50));
    const l = state?.you.legal;
    if (!l) continue;
    if (l.win?.ok) await call('act', { action: 'win' });
    else if (l.type === 'turn') {
      const tile = state.you.drawn ?? state.you.hand[state.you.hand.length - 1];
      const r = await call('act', { action: 'discard', tile });
      assert.ok(r.ok, r.error);
      acted++;
    } else await call('act', { action: 'pass' });
  }
  assert.ok(results, 'hand finished');
  assert.ok(acted > 0, 'we got turns');
  const pts = state.table.seats.reduce((a, s) => a + s.points, 0);
  assert.equal(pts, 4 * 5000);
  c.close();
  for (const r of rooms.values()) r.destroy();
  await srv.close();
});
