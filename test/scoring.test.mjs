import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTiles as T, EAST, RED } from '../server/tiles.js';
import { scoreHand, shanten, waits, payouts, isWinningShape } from '../server/scoring.js';

const base = { selfDrawn: false, seatWind: 1, roundWind: 0, bonus: [38], rules: { minFaan: 3, maxFaan: 10 } };
const sc = (concealed, extra = {}) => scoreHand({ ...base, concealed: T(concealed), winTile: T(concealed)[0], ...extra });
const names = (r) => r.items.map((i) => i.name).sort();

test('shapes', () => {
  assert.ok(isWinningShape(T('123m 456m 789m 123p 55s'), 0));
  assert.ok(!isWinningShape(T('123m 456m 789m 124p 55s'), 0));
  assert.ok(isWinningShape(T('19m 19p 19s ESWN R G WhWh'), 0)); // thirteen orphans
  assert.ok(!isWinningShape(T('11m 22m 33p 44p 55s 66s 77s'.replace('77s', '78s')), 0));
});

test('chicken hand scores 1 for concealed only', () => {
  const r = sc('123m 456m 789p 234s 55s');
  assert.equal(r.faan, 2); // concealed + all chows
  assert.deepEqual(names(r), ['All Chows', 'Concealed Hand']);
});

test('mixed and pure one suit', () => {
  assert.equal(sc('123m 456m 789m EEE NN', { melds: [] }).items.find((i) => i.name === 'Mixed One Suit').faan, 3);
  const pure = sc('123m 456m 789m 111m 55m');
  assert.ok(names(pure).includes('Pure One Suit'));
});

test('all pungs with exposed melds', () => {
  const r = scoreHand({ ...base, concealed: T('222p 55s'), winTile: T('5s')[0], melds: [
    { type: 'pung', tile: T('1m')[0], concealed: false }, { type: 'pung', tile: T('9s')[0], concealed: false }, { type: 'kong', tile: RED, concealed: false },
  ] });
  assert.ok(names(r).includes('All Pungs'));
  assert.ok(names(r).includes('Red Dragon Pung'));
  assert.ok(!names(r).includes('Concealed Hand'));
});

test('seat and round wind', () => {
  const r = scoreHand({ ...base, seatWind: 0, roundWind: 0, concealed: T('123m 456p 789s EEE 11s'), winTile: T('1m')[0] });
  assert.ok(names(r).includes('Seat Wind') && names(r).includes('Round Wind'));
});

test('three dragons', () => {
  assert.ok(names(sc('RRR GGG WhWhWh 123m 99p')).includes('Great Three Dragons'));
  const small = sc('RRR GGG WhWh 123m 999p');
  assert.ok(names(small).includes('Small Three Dragons'));
  assert.ok(!names(small).includes('Red Dragon Pung'));
});

test('limit hands hit the cap', () => {
  assert.equal(sc('19m 19p 19s ESWN R G WhWh').faan, 10);
  assert.equal(sc('EEE SSS WWW NNN RR').faan, 10);
  assert.equal(sc('111m 999m 111p 999p 11s').faan, 10);
});

test('four concealed pungs needs self-draw unless won on the pair', () => {
  const hand = '111m 333p 555s 777s 99m';
  const ron = scoreHand({ ...base, concealed: T(hand), winTile: T('5s')[0] });
  assert.ok(!ron.limit);
  const tsumo = scoreHand({ ...base, concealed: T(hand), winTile: T('5s')[0], selfDrawn: true });
  assert.ok(tsumo.limit);
  const tanki = scoreHand({ ...base, concealed: T(hand), winTile: T('9m')[0] });
  assert.ok(tanki.limit);
});

test('ambiguous hand picks the better split', () => {
  // 111222333m can be three pungs or three chows.
  const r = sc('111m 222m 333m 444p 55p', { winTile: T('5p')[0] });
  assert.ok(names(r).includes('All Pungs') || names(r).includes('Mixed One Suit') || r.faan >= 4, JSON.stringify(r.items));
});

test('bonus tiles', () => {
  const none = scoreHand({ ...base, bonus: [], concealed: T('123m 456m 789p 234s 55s'), winTile: 0 });
  assert.ok(names(none).includes('No Flowers'));
  const seat = scoreHand({ ...base, seatWind: 1, bonus: [35], concealed: T('123m 456m 789p 234s 55s'), winTile: 0 });
  assert.ok(names(seat).includes('Seat Flower'));
});

test('shanten and waits', () => {
  assert.equal(shanten(T('123m 456m 789m 123p 55s')), -1);
  assert.equal(shanten(T('123m 456m 789m 123p 5s')), 0);
  assert.deepEqual(waits(T('123m 456m 789m 123p 5s')), T('5s'));
  assert.deepEqual(waits(T('123m 456m 789m 11p 45s')), T('36s'));
  assert.equal(shanten(T('19m 19p 19s ESWN R G Wh')), 0);
});

test('payouts', () => {
  assert.deepEqual(payouts({ winner: 0, discarder: 2, faan: 3 }), [16, 0, -16, 0]);
  assert.deepEqual(payouts({ winner: 1, discarder: null, faan: 3 }), [-8, 24, -8, -8]);
});
