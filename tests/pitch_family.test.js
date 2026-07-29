'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  pitchFamily, bucketKey, computeBucketRatings, computeArsenal,
  formatComposition, ARSENAL_MIN_SWINGS,
} = require('../pitch_logic.js');

function pz(pitch, zone, outcome, pitcherThrows = 'R') {
  return { pitch, zone, outcome, pitcherThrows, position: [50, 50] };
}

test('pitch types map to the three families, unknown falls back to fastball', () => {
  ['4S', '2S', 'Si', 'FC', 'FB'].forEach(t => assert.strictEqual(pitchFamily(t), 'FB', t));
  ['SL', 'CB'].forEach(t => assert.strictEqual(pitchFamily(t), 'BB', t));
  ['CH', 'SP', 'KN'].forEach(t => assert.strictEqual(pitchFamily(t), 'OS', t));
  // getPitchAbbreviation defaults unrecognised types to 'FB'; stay consistent.
  assert.strictEqual(pitchFamily('???'), 'FB');
});

test('bucketKey groups by family, so a four-seam and a sinker share a bucket', () => {
  assert.strictEqual(bucketKey(pz('4S', 'Low-In', 'out')), bucketKey(pz('Si', 'Low-In', 'out')));
  // ...but a slider in the same zone does not.
  assert.notStrictEqual(bucketKey(pz('4S', 'Low-In', 'out')), bucketKey(pz('SL', 'Low-In', 'out')));
  // ...and the same family in a different zone does not.
  assert.notStrictEqual(bucketKey(pz('4S', 'Low-In', 'out')), bucketKey(pz('4S', 'High-In', 'out')));
});

test('a family bucket records the composition that produced it', () => {
  const pitches = [
    pz('4S', 'Low-In', 'whiff'), pz('4S', 'Low-In', 'out'), pz('4S', 'Low-In', 'ball'),
    pz('Si', 'Low-In', 'hit'), pz('Si', 'Low-In', 'foul'),
    pz('SL', 'Low-In', 'whiff'),
  ];
  const { buckets } = computeBucketRatings(pitches, { bucketMinPitches: 1 });
  const fb = buckets[bucketKey(pz('4S', 'Low-In', 'out'))];
  assert.strictEqual(fb.total, 5, 'four-seams and sinkers pooled');
  assert.strictEqual(fb.family, 'FB');
  assert.strictEqual(fb.label, 'Fastball');
  assert.deepStrictEqual(fb.types, { '4S': 3, 'Si': 2 });
  // the slider is its own bucket
  assert.strictEqual(buckets[bucketKey(pz('SL', 'Low-In', 'whiff'))].total, 1);
});

test('composition renders commonest-first as counts', () => {
  assert.strictEqual(formatComposition({ Si: 16, '4S': 28 }), '28 4S · 16 Si');
  assert.strictEqual(formatComposition({}), '');
});

// ── arsenal ────────────────────────────────────────────────────────────────
function swings(pitch, zone, n, whiffs) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(pz(pitch, zone, i < whiffs ? 'whiff' : 'foul'));
  return arr;
}

test('arsenal reports per-type whiff rate pooled across zones, grouped by family', () => {
  const batter = { pitchZones: [
    ...swings('4S', 'Low-In', 20, 4),    // spread across two zones on purpose:
    ...swings('4S', 'High-Out', 20, 4),  // the arsenal must pool them
    ...swings('SL', 'Low-Out', 40, 20),
  ] };
  const { families } = computeArsenal(batter, { pitcherHandFilter: 'All' });
  const fb = families.find(f => f.family === 'FB');
  const bb = families.find(f => f.family === 'BB');

  assert.strictEqual(fb.swings, 40, 'pooled across both zones');
  assert.ok(Math.abs(fb.whiffRate - 0.2) < 1e-9);
  assert.ok(Math.abs(bb.whiffRate - 0.5) < 1e-9);
  assert.strictEqual(fb.types.length, 1);
  assert.strictEqual(fb.types[0].pitch, '4S');
  // A confidence interval accompanies every quoted rate.
  assert.ok(fb.ci > 0 && fb.ci < 1);
});

test('arsenal withholds a rate below the swing minimum but keeps the count', () => {
  const thin = ARSENAL_MIN_SWINGS - 1;
  const batter = { pitchZones: swings('CH', 'Mid-Mid', thin, 5) };
  const { families } = computeArsenal(batter, { pitcherHandFilter: 'All' });
  const os = families.find(f => f.family === 'OS');
  assert.strictEqual(os.swings, thin);
  assert.strictEqual(os.whiffRate, null, 'too few swings to quote a rate');
  assert.strictEqual(os.ci, null);

  const ok = computeArsenal({ pitchZones: swings('CH', 'Mid-Mid', ARSENAL_MIN_SWINGS, 5) },
    { pitcherHandFilter: 'All' }).families.find(f => f.family === 'OS');
  assert.ok(ok.whiffRate !== null, 'at the minimum the rate appears');
});

test('arsenal honours the pitcher-hand filter', () => {
  const batter = { pitchZones: [
    ...swings('4S', 'Low-In', 20, 2).map(p => ({ ...p, pitcherThrows: 'R' })),
    ...swings('4S', 'Low-In', 20, 18).map(p => ({ ...p, pitcherThrows: 'L' })),
  ] };
  const all = computeArsenal(batter, { pitcherHandFilter: 'All' }).families[0];
  const vsR = computeArsenal(batter, { pitcherHandFilter: 'R' }).families[0];
  const vsL = computeArsenal(batter, { pitcherHandFilter: 'L' }).families[0];
  assert.strictEqual(all.swings, 40);
  assert.ok(Math.abs(vsR.whiffRate - 0.1) < 1e-9);
  assert.ok(Math.abs(vsL.whiffRate - 0.9) < 1e-9);
});

test('arsenal counts only swings, not takes', () => {
  const batter = { pitchZones: [
    ...swings('4S', 'Low-In', 20, 5),
    ...Array.from({ length: 50 }, () => pz('4S', 'Low-In', 'ball')),
  ] };
  const fb = computeArsenal(batter, { pitcherHandFilter: 'All' }).families[0];
  assert.strictEqual(fb.swings, 20, 'balls are not swings');
  assert.strictEqual(fb.pitches, 70, 'but they still count as pitches seen');
  assert.ok(Math.abs(fb.whiffRate - 0.25) < 1e-9);
});

// ── colour sensitivity ─────────────────────────────────────────────────────
test('ratingSensitivity trades gray for colour without touching the estimates', () => {
  const { getVisiblePitches: gvp } = require('../pitch_logic.js');
  // A bucket sitting between the strict and loose edges: coloured at level 5,
  // gray at level 1. Baseline engineered to 0.500 (60 wins / 120 decisive), so
  // bucket A's delta is (31 - 30) / (60 + 54) = 0.88 pts — comfortably inside
  // the strict edge (2.2 pts) and comfortably outside the loose one (0.44).
  const mk = (zone, n, wins) => Array.from({ length: n }, (_, i) =>
    ({ pitch: '4S', zone, outcome: i < wins ? 'whiff' : 'hit', pitcherThrows: 'R', position: [50, 50] }));
  const batter = { pitchZones: [...mk('A', 60, 31), ...mk('B', 60, 29)] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All',
                 circleColorMode: 'both', maxCirclesPerBucket: 'All' };

  const at = lvl => {
    const { bucketCtx } = gvp(batter, { ...base, ratingSensitivity: lvl });
    return bucketCtx.buckets['FB|A'];
  };
  const strict = at(1), loose = at(5);

  // The underlying estimate is identical — only the threshold moved.
  assert.ok(Math.abs(strict.shrunkRate - loose.shrunkRate) < 1e-12);
  assert.ok(Math.abs(strict.delta - loose.delta) < 1e-12);
  assert.strictEqual(strict.rating, 'neutral', 'too small a gap to colour when strict');
  assert.strictEqual(loose.rating, 'green', 'same gap earns colour when loose');
});

test('sensitivity defaults to level 3 when unset', () => {
  const { sensitivityMultiplier, SENSITIVITY_MULTIPLIER, DEFAULT_SENSITIVITY } = require('../pitch_logic.js');
  assert.strictEqual(sensitivityMultiplier({}), SENSITIVITY_MULTIPLIER[DEFAULT_SENSITIVITY]);
  assert.strictEqual(sensitivityMultiplier({ ratingSensitivity: 99 }), SENSITIVITY_MULTIPLIER[DEFAULT_SENSITIVITY]);
  // Strictly decreasing: a higher level always means a looser edge.
  const levels = [1, 2, 3, 4, 5].map(l => sensitivityMultiplier({ ratingSensitivity: l }));
  levels.forEach((v, i) => { if (i) assert.ok(v < levels[i - 1], 'multiplier must decrease'); });
});
