'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { firstPitchTally, firstPitchMetric, firstPitchLabel, poolLeagueFirstPitch } = require('../lib/stats.js');

function p(pitch_call, balls = 0, strikes = 0, extra = {}) {
  return { pitch_call, balls, strikes, ...extra };
}

test('firstPitchTally + metric over the spec fixture (PA′=4, numerator=2, metric=50%)', () => {
  const pitches = ['InPlay', 'BallCalled', 'StrikeCalled', 'HitByPitch', 'BallinDirt', 'StrikeSwinging'].map(c => p(c));
  const tally = firstPitchTally(pitches);
  assert.strictEqual(tally.zeroZero, 6);
  assert.strictEqual(tally.hbp, 1);
  assert.strictEqual(tally.other, 1); // BallinDirt
  const paPrime = tally.swung + tally.taken;
  assert.strictEqual(paPrime, 4);
  assert.strictEqual(tally.swung, 2); // numerator = SWUNG count
  assert.ok(Math.abs(firstPitchMetric(tally) - 0.5) < 1e-9);
});

test('only 0-0 pitches count; multi-game same inning/pa both counted (routes around paKey)', () => {
  const pitches = [
    p('InPlay', 0, 0, { date: '2026-05-01', inning: 1, pa_of_inning: 1 }),
    p('StrikeSwinging', 0, 0, { date: '2026-05-08', inning: 1, pa_of_inning: 1 }), // same inning/pa, later date
    p('BallCalled', 1, 0),  // not 0-0 → ignored
    p('StrikeCalled', 0, 2), // not 0-0 → ignored
  ];
  const tally = firstPitchTally(pitches);
  assert.strictEqual(tally.zeroZero, 2);
  assert.strictEqual(tally.swung, 2);
  assert.strictEqual(tally.taken, 0);
});

test('poolLeagueFirstPitch pools across batters (not a mean of batters)', () => {
  const b1 = [p('InPlay'), p('BallCalled')];
  const b2 = [p('StrikeSwinging'), p('StrikeCalled')];
  const b3 = [p('FoulBall'), p('BallCalled')];
  const pool = poolLeagueFirstPitch([...b1, ...b2, ...b3]);
  assert.strictEqual(pool.tally.swung, 3);
  assert.strictEqual(pool.tally.taken, 3);
  assert.ok(Math.abs(pool.metric - 0.5) < 1e-9);
});

test('firstPitchLabel league-relative thresholds are inclusive (AVE=40%)', () => {
  assert.strictEqual(firstPitchLabel(0.50, 0.40), 'Aggressive'); // ≥ 40%×1.25 = 50%
  assert.strictEqual(firstPitchLabel(0.30, 0.40), 'Patient');    // ≤ 40%×0.75 = 30%
  assert.strictEqual(firstPitchLabel(0.45, 0.40), 'Neutral');
  assert.strictEqual(firstPitchLabel(0.50, null), 'Neutral');    // league pending → Neutral
});
