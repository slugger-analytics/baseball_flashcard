'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches } = require('../pitch_logic.js');

// Buckets are (pitch family x zone): distinct buckets come from distinct zones.
// `wins` pitches go the pitcher's way (whiff), the rest the batter's (hit).
function bucket(zone, total, wins) {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch: '4S', zone, outcome: i < wins ? 'whiff' : 'hit', pitcherThrows: 'R', position: [50, 50], seq: i });
  }
  return arr;
}

test('maxCirclesPerBucket=1 keeps exactly the chronologically-first pitch in a bucket', () => {
  const batter = { pitchZones: bucket('z', 5, 2) }; // one bucket, 5 pitches
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
      ...bucket('R1', 8, 0), // red  (strong)
      ...bucket('R2', 8, 2), // red  (mild)
      ...bucket('G1', 8, 8), // green (strong)
      ...bucket('G2', 8, 6), // green (mild)
    ],
  };
  const { pitches } = getVisiblePitches(batter, {
    bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All',
    circleColorMode: 'both', maxCirclesPerBucket: 1,
  });
  assert.strictEqual(pitches.length, 4);
  assert.deepStrictEqual(pitches.map(p => p.zone), ['R1', 'G1', 'R2', 'G2']);
  assert.deepStrictEqual(pitches.map(p => p.rating), ['red', 'green', 'red', 'green']);
});
