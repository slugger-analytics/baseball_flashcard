'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeBucketRatings, getVisiblePitches, bucketKey } = require('../pitch_logic.js');

// Helper: build a pitchZone-shaped object.
function pz(pitch, zone, outcome, pitcherThrows = 'R') {
  return { pitch, zone, outcome, pitcherThrows, position: [50, 50] };
}

test('computeBucketRatings buckets by pitch×zone and counts outcomes', () => {
  const pitches = [
    pz('SL', 'Low-In', 'hit'),
    pz('SL', 'Low-In', 'out'),
    pz('SL', 'Low-In', 'whiff'),
    pz('FB', 'High-Out', 'ball'),
  ];
  const { buckets, baselines } = computeBucketRatings(pitches, { bucketMinPitches: 1 });
  const sl = buckets[bucketKey({ pitch: 'SL', zone: 'Low-In' })];
  assert.strictEqual(sl.total, 3);
  assert.strictEqual(sl.hit, 1);
  assert.strictEqual(sl.out, 1);
  assert.strictEqual(sl.whiff, 1);
  // Pitcher-win baseline over these four in-zone pitches: the out and the whiff
  // are wins, the hit and the ball are losses -> 2/4.
  assert.ok(Math.abs(baselines.zone - 0.5) < 1e-9);
  assert.strictEqual(sl.win, 2);
  assert.strictEqual(sl.loss, 1);
});

test('computeBucketRatings marks under-sample buckets eliminated', () => {
  const pitches = [pz('SL', 'Low-In', 'hit'), pz('SL', 'Low-In', 'out')];
  const { buckets } = computeBucketRatings(pitches, { bucketMinPitches: 3 });
  assert.strictEqual(buckets[bucketKey({ pitch: 'SL', zone: 'Low-In' })].eliminated, true);
});

test('getVisiblePitches drops eliminated buckets and hidden pitch types', () => {
  const batter = {
    pitchZones: [
      pz('SL', 'Low-In', 'hit'),
      pz('SL', 'Low-In', 'out'),
      pz('SL', 'Low-In', 'whiff'),
      pz('CH', 'Mid-Mid', 'ball'), // lone CH → under min sample → eliminated
    ],
  };
  const { pitches } = getVisiblePitches(batter, { bucketMinPitches: 3, hiddenPitchTypes: [] });
  assert.strictEqual(pitches.length, 3);
  assert.ok(pitches.every(p => p.pitch === 'SL'));

  const hidden = getVisiblePitches(batter, { bucketMinPitches: 1, hiddenPitchTypes: ['SL'] });
  assert.ok(hidden.pitches.every(p => p.pitch !== 'SL'));
});
