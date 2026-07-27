'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches } = require('../pitch_logic.js');

// Build `total` pitches for one (pitch×zone) bucket, `hits` of them outcome 'hit'.
function bucket(pitch, total, hits) {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch, zone: 'z', outcome: i < hits ? 'hit' : 'out', pitcherThrows: 'R', position: [50, 50] });
  }
  return arr;
}

// overallRate engineered to 13/26 = 0.5 → green ≤ 0.375, red ≥ 0.625, else gray.
const POPULATION = [
  ...bucket('R1', 4, 4), // rate 1.00 → red
  ...bucket('R2', 4, 3), // rate 0.75 → red
  ...bucket('G1', 4, 0), // rate 0.00 → green
  ...bucket('G2', 4, 1), // rate 0.25 → green
  ...bucket('GY', 4, 2), // rate 0.50 → gray
  ...bucket('EL', 2, 1), // rate 0.50 but under min sample → eliminated
  ...bucket('XX', 4, 2), // gray, but hidden pitch type
];
const BATTER = { pitchZones: POPULATION };
const BASE = { bucketMinPitches: 3, hiddenPitchTypes: ['XX'], pitcherHandFilter: 'All', maxCirclesPerBucket: 'All' };

const isGray = p => p.rating !== 'red' && p.rating !== 'green';

test("circleColorMode 'both' shows red+green first, grays last; excludes hidden/eliminated", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'both' });
  assert.strictEqual(pitches.length, 20); // 8 red + 8 green + 4 gray
  assert.ok(!pitches.some(p => p.pitch === 'XX'), 'hidden pitch type excluded');
  assert.ok(!pitches.some(p => p.pitch === 'EL'), 'eliminated bucket excluded');
  const firstGray = pitches.findIndex(isGray);
  const lastNonGray = pitches.reduce((acc, p, i) => (isGray(p) ? acc : i), -1);
  assert.ok(firstGray > lastNonGray, 'all grays ordered after all red/green');
});

test("circleColorMode 'green' shows only green", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'green' });
  assert.strictEqual(pitches.length, 8);
  assert.ok(pitches.every(p => p.rating === 'green'));
  assert.ok(!pitches.some(p => p.pitch === 'XX' || p.pitch === 'EL'));
});

test("circleColorMode 'red' shows only red", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'red' });
  assert.strictEqual(pitches.length, 8);
  assert.ok(pitches.every(p => p.rating === 'red'));
});

test('legacy showOnly* keys migrate to a color mode', () => {
  const green = getVisiblePitches(BATTER, { ...BASE, showOnlyGoodPitches: true }).pitches;
  assert.ok(green.length === 8 && green.every(p => p.rating === 'green'));
  const red = getVisiblePitches(BATTER, { ...BASE, showOnlyBadPitches: true }).pitches;
  assert.ok(red.length === 8 && red.every(p => p.rating === 'red'));
});
