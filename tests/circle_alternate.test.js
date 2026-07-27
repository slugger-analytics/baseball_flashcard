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

// Integration fixture: overallRate engineered to 0.5.
function bucket(pitch, total, hits) {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch, zone: 'z', outcome: i < hits ? 'hit' : 'out', pitcherThrows: 'R', position: [50, 50], seq: i });
  }
  return arr;
}
const BATTER = {
  pitchZones: [
    ...bucket('R1', 4, 4), // rate 1.00 → red,  extremity 1.0
    ...bucket('R2', 4, 3), // rate 0.75 → red,  extremity 0.5
    ...bucket('G1', 4, 0), // rate 0.00 → green, extremity 1.0
    ...bucket('G2', 4, 1), // rate 0.25 → green, extremity 0.5
  ],
};
const BASE = { bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All', maxCirclesPerBucket: 'All' };

test("'both' mode alternates red/green and keeps same-bucket chronological order", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'both' });
  assert.strictEqual(pitches.length, 16);
  // Strictly alternating red, green, red, green...
  pitches.forEach((p, i) => assert.strictEqual(p.rating, i % 2 === 0 ? 'red' : 'green'));
  // Red subsequence ordered by extremity (R1 before R2); same-bucket chronological (seq 0..3)
  const reds = pitches.filter(p => p.rating === 'red');
  assert.deepStrictEqual(reds.map(p => p.pitch), ['R1', 'R1', 'R1', 'R1', 'R2', 'R2', 'R2', 'R2']);
  assert.deepStrictEqual(reds.slice(0, 4).map(p => p.seq), [0, 1, 2, 3]);
});

test("'red' mode ordering is plain extremity order (unchanged)", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'red' });
  assert.strictEqual(pitches.length, 8);
  assert.deepStrictEqual(pitches.map(p => p.pitch), ['R1', 'R1', 'R1', 'R1', 'R2', 'R2', 'R2', 'R2']);
});
