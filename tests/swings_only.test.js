'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches, bucketKey } = require('../pitch_logic.js');

function pz(pitch, outcome) {
  return { pitch, zone: 'z', outcome, pitcherThrows: 'R', position: [50, 50] };
}

test('swingsOnly restricts the population to swings (takes and other dropped)', () => {
  const batter = { pitchZones: [pz('SS', 'take'), pz('SS', 'take'), pz('SS', 'whiff'), pz('SS', 'foul'), pz('SS', 'hit')] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both', maxCirclesPerBucket: 'All' };

  assert.strictEqual(getVisiblePitches(batter, { ...base, swingsOnly: false }).populationCount, 5);
  assert.strictEqual(getVisiblePitches(batter, { ...base, swingsOnly: true }).populationCount, 3);
});

test('a bucket green over all pitches can flip red over swings; overallRate recomputes', () => {
  // AA: 2 hits + 8 takes (low all-rate → green; swings-only removes takes → all-hit → red)
  // BB: 4 hits + 4 outs (no takes) sets the swing-population background.
  const AA = [];
  for (let i = 0; i < 2; i++) AA.push(pz('AA', 'hit'));
  for (let i = 0; i < 8; i++) AA.push(pz('AA', 'take'));
  const BB = [];
  for (let i = 0; i < 4; i++) BB.push(pz('BB', 'hit'));
  for (let i = 0; i < 4; i++) BB.push(pz('BB', 'out'));
  const batter = { pitchZones: [...AA, ...BB] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both', maxCirclesPerBucket: 'All' };
  const kAA = bucketKey({ pitch: 'AA', zone: 'z' });

  const all = getVisiblePitches(batter, { ...base, swingsOnly: false });
  const sw = getVisiblePitches(batter, { ...base, swingsOnly: true });

  assert.strictEqual(all.bucketCtx.buckets[kAA].rating, 'green');
  assert.strictEqual(sw.bucketCtx.buckets[kAA].rating, 'red');
  // overallRate is recomputed on the swing-only population (0.333 → 0.6).
  assert.ok(Math.abs(all.bucketCtx.overallRate - 6 / 18) < 1e-9);
  assert.ok(Math.abs(sw.bucketCtx.overallRate - 6 / 10) < 1e-9);
});
