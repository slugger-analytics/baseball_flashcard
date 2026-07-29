'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches, interleave } = require('../pitch_logic.js');

const R = (e, seq) => ({ rating: 'red', extremity: e, seq });
const G = (e, seq) => ({ rating: 'green', extremity: e, seq });

test('interleave alternates one red, one green, starting with red', () => {
  const out = interleave([R(0.9), R(0.5)], [G(0.8), G(0.4)]);
  assert.deepStrictEqual(
    out.map(p => [p.rating, p.extremity]),
    [['red', 0.9], ['green', 0.8], ['red', 0.5], ['green', 0.4]]
  );
});

test('interleave appends the remainder when one color exhausts', () => {
  const out = interleave([R(0.9), R(0.6), R(0.3)], [G(0.8)]);
  assert.deepStrictEqual(out.map(p => p.rating), ['red', 'green', 'red', 'red']);
});

// Integration fixture: pitcher-win baseline engineered to 0.5 (16 wins / 32).
// Buckets are (pitch family x zone), so distinct buckets come from distinct
// ZONES here — varying the pitch type would collapse them into one family.
// `wins` pitches go the pitcher's way (whiff), the rest the batter's (hit).
function bucket(zone, total, wins) {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch: '4S', zone, outcome: i < wins ? 'whiff' : 'hit', pitcherThrows: 'R', position: [50, 50], seq: i });
  }
  return arr;
}
const BATTER = {
  pitchZones: [
    ...bucket('R1', 8, 0), // delta -0.065 → red,   extremity 2.9
    ...bucket('R2', 8, 2), // delta -0.032 → red,   extremity 1.5
    ...bucket('G1', 8, 8), // delta +0.065 → green, extremity 2.9
    ...bucket('G2', 8, 6), // delta +0.032 → green, extremity 1.5
  ],
};
const BASE = { bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All', maxCirclesPerBucket: 'All' };

test("'both' mode alternates red/green and keeps same-bucket chronological order", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'both' });
  assert.strictEqual(pitches.length, 32);
  // Strictly alternating red, green, red, green...
  pitches.forEach((p, i) => assert.strictEqual(p.rating, i % 2 === 0 ? 'red' : 'green'));
  // Red subsequence ordered by extremity (R1 before R2); same-bucket chronological (seq 0..3)
  const reds = pitches.filter(p => p.rating === 'red');
  assert.deepStrictEqual(reds.map(p => p.zone),
    [...Array(8).fill('R1'), ...Array(8).fill('R2')]);
  assert.deepStrictEqual(reds.slice(0, 8).map(p => p.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("'red' mode ordering is plain extremity order (unchanged)", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'red' });
  assert.strictEqual(pitches.length, 16);
  assert.deepStrictEqual(pitches.map(p => p.zone),
    [...Array(8).fill('R1'), ...Array(8).fill('R2')]);
});
