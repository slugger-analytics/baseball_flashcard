'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  computeBucketRatings, getVisiblePitches, bucketKey,
  bandMissDescription, getZoneFromLocation,
} = require('../pitch_logic.js');

const { finishBand } = require('../lib/stats.js');

test('bandMissDescription names the miss direction implied by the band', () => {
  // Outer/inner thirds: the pitch really was off the plate.
  for (const band of ['High-In', 'High-Out', 'Mid-In', 'Mid-Out', 'Low-In', 'Low-Out']) {
    assert.strictEqual(bandMissDescription(band), 'off plate', band);
  }
  // Middle column: |plate_loc_side| was inside the zone's half-width, so the pitch
  // was OVER the plate and missed vertically. Calling these "off plate" inverts the
  // coaching instruction.
  assert.strictEqual(bandMissDescription('High-Mid'), 'above the zone');
  assert.strictEqual(bandMissDescription('Low-Mid'), 'below the zone');
  // Unreachable for a chase pitch (both axes inside the edges = a strike), answered
  // for totality only.
  assert.strictEqual(bandMissDescription('Mid-Mid'), 'off plate');
  for (const bad of [null, undefined, 42, '']) {
    assert.strictEqual(bandMissDescription(bad), 'off plate');
  }
});

test('a chase pitch over the plate is described as a vertical miss, not off plate', () => {
  // This is the case that was wrong in production: dead centre horizontally, above
  // the top of the zone.
  const zone = getZoneFromLocation(0.0, 4.0, 'RHB');
  assert.strictEqual(zone, 'Chase High-Mid');
  assert.strictEqual(bandMissDescription(finishBand(zone)), 'above the zone');

  const low = getZoneFromLocation(0.0, 0.9, 'RHB');
  assert.strictEqual(low, 'Chase Low-Mid');
  assert.strictEqual(bandMissDescription(finishBand(low)), 'below the zone');

  // A genuinely off-plate chase still reads "off plate".
  const away = getZoneFromLocation(-1.4, 1.8, 'RHB');
  assert.strictEqual(away, 'Chase Mid-Out');
  assert.strictEqual(bandMissDescription(finishBand(away)), 'off plate');
});

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
