'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  FINISH_MIN_SAMPLE, FINISH_MIN_MODAL, FINISH_MIN_SHARE,
  finishingToken, finishBand, outPitchFinishLocation,
} = require('../lib/stats.js');

const SEQ = ['4S', 'SL'].join(' → '); // pins the separator used by the server's joins

function outs(zone, n, shortSequence = SEQ) {
  return Array.from({ length: n }, () => ({ shortSequence, zone }));
}

test('gate constants are pinned (drift would re-introduce a noise caption)', () => {
  assert.strictEqual(FINISH_MIN_SAMPLE, 15);
  assert.strictEqual(FINISH_MIN_MODAL, 6);
  assert.strictEqual(FINISH_MIN_SHARE, 0.35);
});

test('finishBand folds the Chase prefix into the in-zone band', () => {
  assert.strictEqual(finishBand('Chase Low-Out'), 'Low-Out');
  assert.strictEqual(finishBand('Low-Out'), 'Low-Out');
  assert.strictEqual(finishBand('Mid-Mid'), 'Mid-Mid');
  for (const value of [null, undefined, '', 123]) {
    assert.strictEqual(finishBand(value), null);
  }
  for (const vertical of ['High', 'Mid', 'Low']) {
    for (const horizontal of ['In', 'Mid', 'Out']) {
      const label = `${vertical}-${horizontal}`;
      assert.strictEqual(finishBand(label), label);
      assert.strictEqual(finishBand(`Chase ${label}`), label);
    }
  }
});

test('finishingToken takes the last pitch of a sequence', () => {
  assert.strictEqual(finishingToken(SEQ), 'SL');
  assert.strictEqual(finishingToken('SL'), 'SL');
  assert.strictEqual(finishingToken(['4S', 'CH', 'CB'].join(' → ')), 'CB');
});

test('outPitchFinishLocation is null-safe on bad input', () => {
  assert.strictEqual(outPitchFinishLocation(null, 'SL'), null);
  assert.strictEqual(outPitchFinishLocation(undefined, 'SL'), null);
  assert.strictEqual(outPitchFinishLocation([], 'SL'), null);
  assert.strictEqual(outPitchFinishLocation(outs('Low-Out', 20), null), null);
  assert.strictEqual(outPitchFinishLocation(outs('Low-Out', 20), ''), null);
});

test('14 located finishes stay below the sample gate even at a 100% share', () => {
  assert.strictEqual(outPitchFinishLocation(outs('Low-Out', 14), 'SL'), null);
});

test('15 located finishes with a modal 6 clear all three thresholds inclusively', () => {
  const pool = [
    ...outs('Low-Out', 4), ...outs('Chase Low-Out', 2),
    ...outs('High-In', 3), ...outs('Mid-Mid', 3), ...outs('Low-In', 3),
  ];
  assert.deepStrictEqual(outPitchFinishLocation(pool, 'SL'),
    { pitch: 'SL', band: 'Low-Out', count: 6, total: 15, chase: 2, dominant: true });
});

test('enough sample but a modal 5 reports "no dominant spot" rather than null', () => {
  const pool = [...outs('Low-Out', 5), ...outs('High-In', 4), ...outs('Mid-Mid', 3), ...outs('Low-In', 3)];
  const result = outPitchFinishLocation(pool, 'SL');
  assert.strictEqual(result.dominant, false);
  assert.strictEqual(result.count, 5);
  assert.strictEqual(result.total, 15);
});

test('the share gate bites even when the count gate passes', () => {
  const pool = [...outs('Low-Out', 6), ...outs('High-In', 5), ...outs('Mid-Mid', 5), ...outs('Low-In', 4)];
  const result = outPitchFinishLocation(pool, 'SL');
  assert.strictEqual(result.total, 20);
  assert.strictEqual(result.count, 6); // 6/20 = 30% < 35%
  assert.strictEqual(result.dominant, false);
});

test('6 of 17 (35.3%) is dominant', () => {
  const pool = [...outs('Low-Out', 6), ...outs('High-In', 5), ...outs('Mid-Mid', 6)];
  const result = outPitchFinishLocation(pool, 'SL');
  assert.strictEqual(result.band, 'Low-Out');
  assert.strictEqual(result.dominant, true);
});

test('unlocated finishes leave both the pool and the denominator', () => {
  const pool = [
    ...outs('Low-Out', 8), ...outs('High-In', 7),
    ...outs(null, 3), ...outs(undefined, 2), ...outs('', 1),
  ];
  assert.strictEqual(outPitchFinishLocation(pool, 'SL').total, 15);
});

test('finishes on a different pitch type are excluded', () => {
  const pool = [
    ...outs('Low-Out', 8), ...outs('High-In', 7),
    ...outs('Low-Out', 8, ['CB', 'CB'].join(' → ')),
  ];
  const result = outPitchFinishLocation(pool, 'SL');
  assert.strictEqual(result.total, 15);
  assert.strictEqual(result.pitch, 'SL');
});

test('a modal tie breaks by first appearance and is stable across calls', () => {
  const pool = [...outs('High-In', 5), ...outs('Low-Out', 5), ...outs('Mid-Mid', 5)];
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(outPitchFinishLocation(pool, 'SL').band, 'High-In');
  }
});

test('malformed records are skipped instead of throwing', () => {
  const pool = [
    null, { shortSequence: 42, zone: 'Low-Out' }, { shortSequence: SEQ },
    ...outs('Low-Out', 15),
  ];
  const result = outPitchFinishLocation(pool, 'SL');
  assert.strictEqual(result.total, 15);
  assert.strictEqual(result.count, 15);
});
