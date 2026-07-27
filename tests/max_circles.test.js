'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches } = require('../pitch_logic.js');

function bucket(pitch, total, hits) {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch, zone: 'z', outcome: i < hits ? 'hit' : 'out', pitcherThrows: 'R', position: [50, 50], seq: i });
  }
  return arr;
}

test('maxCirclesPerBucket=1 keeps exactly the chronologically-first pitch in a bucket', () => {
  const batter = { pitchZones: bucket('SL', 5, 2) }; // one bucket, 5 pitches
  const base = { bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both' };

  const capped = getVisiblePitches(batter, { ...base, maxCirclesPerBucket: 1 }).pitches;
  assert.strictEqual(capped.length, 1);
  assert.strictEqual(capped[0].seq, 0); // first-revealed = chronologically first

  const all = getVisiblePitches(batter, { ...base, maxCirclesPerBucket: 'All' }).pitches;
  assert.strictEqual(all.length, 5);
});

test('cap preserves the alternating R,G,R,G shape (one per bucket)', () => {
  const batter = {
    pitchZones: [
      ...bucket('R1', 4, 4), // red
      ...bucket('R2', 4, 3), // red
      ...bucket('G1', 4, 0), // green
      ...bucket('G2', 4, 1), // green
    ],
  };
  const { pitches } = getVisiblePitches(batter, {
    bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All',
    circleColorMode: 'both', maxCirclesPerBucket: 1,
  });
  assert.strictEqual(pitches.length, 4);
  assert.deepStrictEqual(pitches.map(p => p.pitch), ['R1', 'G1', 'R2', 'G2']);
  assert.deepStrictEqual(pitches.map(p => p.rating), ['red', 'green', 'red', 'green']);
});
