'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches } = require('../pitch_logic.js');

// Build `total` pitches for one (family x zone) bucket, `wins` of them going the
// pitcher's way (whiff) and the rest the batter's (hit).
//
// Distinct buckets come from distinct ZONES — varying pitch type would collapse
// them, since bucketing is by family. `pitch` still varies so the hidden-pitch-type
// filter has something real to bite on.
function bucket(zone, total, wins, pitch = '4S') {
  const arr = [];
  for (let i = 0; i < total; i++) {
    arr.push({ pitch, zone, outcome: i < wins ? 'whiff' : 'hit', pitcherThrows: 'R', position: [50, 50] });
  }
  return arr;
}

// All zones here are in-zone, so one baseline applies: 25 wins / 50 decisive = 0.500.
// Shrinkage k=54, edge 0.022. delta = (wins - n*baseline) / (n + 54):
//   8 of 8 -> +0.065   6 of 8 -> +0.032   4 of 8 -> 0.000   2 of 8 -> -0.032   0 of 8 -> -0.065
// so 8/0 are the strong pair, 6/2 the mild pair, and 4 is dead on his average.
const POPULATION = [
  ...bucket('R1', 8, 0), // -0.065 -> red   (extremity 2.9)
  ...bucket('R2', 8, 2), // -0.032 -> red   (extremity 1.5)
  ...bucket('G1', 8, 8), // +0.065 -> green (extremity 2.9)
  ...bucket('G2', 8, 6), // +0.032 -> green (extremity 1.5)
  ...bucket('GY', 8, 4), //  0.000 -> gray
  ...bucket('EL', 2, 1), // under min sample -> eliminated
  ...bucket('XX', 8, 4, 'CH'), // gray, but its pitch type is hidden
];
const BATTER = { pitchZones: POPULATION };
const BASE = { bucketMinPitches: 3, hiddenPitchTypes: ['CH'], pitcherHandFilter: 'All', maxCirclesPerBucket: 'All' };

const isGray = p => p.rating !== 'red' && p.rating !== 'green';

test("circleColorMode 'both' shows red+green first, grays last; excludes hidden/eliminated", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'both' });
  assert.strictEqual(pitches.length, 40); // 16 red + 16 green + 8 gray
  assert.ok(!pitches.some(p => p.zone === 'XX'), 'hidden pitch type excluded');
  assert.ok(!pitches.some(p => p.zone === 'EL'), 'eliminated bucket excluded');
  const firstGray = pitches.findIndex(isGray);
  const lastNonGray = pitches.reduce((acc, p, i) => (isGray(p) ? acc : i), -1);
  assert.ok(firstGray > lastNonGray, 'all grays ordered after all red/green');
});

test("circleColorMode 'green' shows only green", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'green' });
  assert.strictEqual(pitches.length, 16);
  assert.ok(pitches.every(p => p.rating === 'green'));
  assert.ok(!pitches.some(p => p.zone === 'XX' || p.zone === 'EL'));
});

test("circleColorMode 'red' shows only red", () => {
  const { pitches } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'red' });
  assert.strictEqual(pitches.length, 16);
  assert.ok(pitches.every(p => p.rating === 'red'));
});

test('legacy showOnly* keys migrate to a color mode', () => {
  const green = getVisiblePitches(BATTER, { ...BASE, showOnlyGoodPitches: true }).pitches;
  assert.ok(green.length === 16 && green.every(p => p.rating === 'green'));
  const red = getVisiblePitches(BATTER, { ...BASE, showOnlyBadPitches: true }).pitches;
  assert.ok(red.length === 16 && red.every(p => p.rating === 'red'));
});

test('green means the PITCHER does well there, not the batter', () => {
  const { pitches, bucketCtx } = getVisiblePitches(BATTER, { ...BASE, circleColorMode: 'both' });
  const byZone = z => pitches.find(p => p.zone === z);
  // G1 is the all-whiff bucket; R1 is the all-hit bucket.
  assert.strictEqual(byZone('G1').rating, 'green');
  assert.strictEqual(byZone('R1').rating, 'red');
  const g1 = bucketCtx.buckets[`FB|G1`];
  assert.strictEqual(g1.win, 8);
  assert.strictEqual(g1.loss, 0);
  assert.ok(g1.shrunkRate > g1.baseline);
});
