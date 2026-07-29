'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { getVisiblePitches, bucketKey } = require('../pitch_logic.js');

// Buckets are (pitch family x zone): the first arg names the ZONE, so each
// fixture bucket stays distinct.
function pz(zone, outcome) {
  return { pitch: '4S', zone, outcome, pitcherThrows: 'R', position: [50, 50] };
}

test('swingsOnly restricts the population to swings (called strikes, balls and other dropped)', () => {
  const batter = { pitchZones: [pz('SS', 'strike'), pz('SS', 'ball'), pz('SS', 'other'), pz('SS', 'whiff'), pz('SS', 'foul'), pz('SS', 'hit')] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both', maxCirclesPerBucket: 'All' };

  assert.strictEqual(getVisiblePitches(batter, { ...base, swingsOnly: false }).populationCount, 6);
  assert.strictEqual(getVisiblePitches(batter, { ...base, swingsOnly: true }).populationCount, 3);
});

test('swingsOnly recomputes the baseline, which can flip a rating', () => {
  // AA: 8 whiffs + 24 balls. Over ALL pitches those balls are losses for the
  //     pitcher, so AA looks bad. Drop the takes and AA is pure whiff — the best
  //     bucket on the card. The rating must follow the population.
  // BB: 16 whiffs + 16 hits, unaffected by the swings filter, so it sets the
  //     background both ways.
  const AA = [];
  for (let i = 0; i < 8; i++) AA.push(pz('AA', 'whiff'));
  for (let i = 0; i < 24; i++) AA.push(pz('AA', 'ball'));
  const BB = [];
  for (let i = 0; i < 16; i++) BB.push(pz('BB', 'whiff'));
  for (let i = 0; i < 16; i++) BB.push(pz('BB', 'hit'));
  const batter = { pitchZones: [...AA, ...BB] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both', maxCirclesPerBucket: 'All' };
  const kAA = bucketKey({ pitch: '4S', zone: 'AA' });
  const kBB = bucketKey({ pitch: '4S', zone: 'BB' });

  const all = getVisiblePitches(batter, { ...base, swingsOnly: false });
  const sw = getVisiblePitches(batter, { ...base, swingsOnly: true });

  // All pitches: baseline 24 wins / 64 decisive = 0.375.
  assert.ok(Math.abs(all.bucketCtx.baselines.zone - 0.375) < 1e-9);
  assert.strictEqual(all.bucketCtx.buckets[kAA].rating, 'red');
  assert.strictEqual(all.bucketCtx.buckets[kBB].rating, 'green');

  // Swings only: the 24 balls leave, baseline rises to 24/40 = 0.600, and both flip.
  assert.ok(Math.abs(sw.bucketCtx.baselines.zone - 0.6) < 1e-9);
  assert.strictEqual(sw.bucketCtx.buckets[kAA].rating, 'green');
  assert.strictEqual(sw.bucketCtx.buckets[kBB].rating, 'red');
});

test('a ball counts against the pitcher — the bug that made chase zones green', () => {
  // Two chase buckets, same pitch count. He chases one and takes the other.
  const chased = [];
  for (let i = 0; i < 20; i++) chased.push(pz('Chase Low-Out', i < 12 ? 'whiff' : 'ball'));
  const taken = [];
  for (let i = 0; i < 20; i++) taken.push(pz('Chase High-Out', i < 2 ? 'whiff' : 'ball'));
  const batter = { pitchZones: [...chased, ...taken] };
  const base = { bucketMinPitches: 1, hiddenPitchTypes: [], pitcherHandFilter: 'All', circleColorMode: 'both', maxCirclesPerBucket: 'All' };

  const { bucketCtx } = getVisiblePitches(batter, base);
  const lo = bucketCtx.buckets[bucketKey({ pitch: '4S', zone: 'Chase Low-Out' })];
  const hi = bucketCtx.buckets[bucketKey({ pitch: '4S', zone: 'Chase High-Out' })];

  // Both have zero hits. Under the old hits/pitches metric both scored a perfect
  // 0.000 and rated green. Now the one he simply takes is a loss for the pitcher.
  assert.strictEqual(lo.hit, 0);
  assert.strictEqual(hi.hit, 0);
  assert.strictEqual(lo.rating, 'green', 'he chases here — go get him');
  assert.strictEqual(hi.rating, 'red', 'he just takes it for a ball');
  assert.strictEqual(hi.loss, 18);
});

test('chase splits into edge and deep, so corners are judged against corners', () => {
  const { zoneRegime } = require('../pitch_logic.js');
  // One axis outside -> just off the plate.
  ['Chase Mid-Out', 'Chase Mid-In', 'Chase High-Mid', 'Chase Low-Mid']
    .forEach(z => assert.strictEqual(zoneRegime(z), 'edge', z));
  // Both axes outside -> a diagonal corner, nowhere near the plate.
  ['Chase High-In', 'Chase High-Out', 'Chase Low-In', 'Chase Low-Out']
    .forEach(z => assert.strictEqual(zoneRegime(z), 'deep', z));
  ['Mid-Mid', 'High-In', 'Low-Out'].forEach(z => assert.strictEqual(zoneRegime(z), 'zone', z));
});

test('"everything is a ball out there" is not batter-specific, so it stays gray', () => {
  const { getVisiblePitches: gvp, bucketKey: bk } = require('../pitch_logic.js');
  const mk = (zone, n, wins) => Array.from({ length: n }, (_, i) =>
    ({ pitch: '4S', zone, outcome: i < wins ? 'whiff' : 'ball', pitcherThrows: 'R', position: [50, 50] }));
  const base = { bucketMinPitches: 3, hiddenPitchTypes: [], pitcherHandFilter: 'All',
                 circleColorMode: 'both', maxCirclesPerBucket: 'All', ratingSensitivity: 3 };
  const CORNERS = ['Chase High-Out', 'Chase High-In', 'Chase Low-Out', 'Chase Low-In'];

  // A batter who lays off the diagonal corners at roughly the league pattern —
  // i.e. every batter. 40 pitches each at the league win rate for that corner
  // (3.5% / 9.6% / 12.4% / 14.3%). Nothing here is news, so nothing earns colour.
  const typical = { pitchZones: [
    ...mk('Chase High-Out', 40, 1), ...mk('Chase High-In', 40, 4),
    ...mk('Chase Low-Out', 40, 5), ...mk('Chase Low-In', 40, 6),
  ] };
  const t = gvp(typical, base).bucketCtx.buckets;
  CORNERS.forEach(z => assert.strictEqual(
    t[bk({ pitch: '4S', zone: z })].rating, 'neutral',
    `${z} should be gray — laying off out there is universal, not scouting`));

  // But a batter who genuinely expands up-and-away still lights up: same fixture,
  // High-Out lifted from 1 win in 40 to 16.
  const expands = { pitchZones: [
    ...mk('Chase High-Out', 40, 16), ...mk('Chase High-In', 40, 4),
    ...mk('Chase Low-Out', 40, 5), ...mk('Chase Low-In', 40, 6),
  ] };
  const e = gvp(expands, base).bucketCtx.buckets;
  assert.strictEqual(e[bk({ pitch: '4S', zone: 'Chase High-Out' })].rating, 'green',
    'a real outlier must still surface');
});

test('the zone offset corrects for how hard a spot is league-wide', () => {
  const { expectedWinRate, ZONE_LEAGUE_OFFSET } = require('../pitch_logic.js');
  // Chase High-Out is the deadest spot on the plate; Chase Mid-In the most chased.
  assert.ok(ZONE_LEAGUE_OFFSET['Chase High-Out'] < 0);
  assert.ok(ZONE_LEAGUE_OFFSET['Chase Mid-In'] > 0);
  assert.ok(expectedWinRate('Chase High-Out', 0.105) < 0.105, 'expect less out there');
  assert.ok(expectedWinRate('Chase Mid-In', 0.327) > 0.327, 'expect more just off the plate');
  // Unknown zones fall back to the plain regime baseline, and it stays a probability.
  assert.strictEqual(expectedWinRate('Nonsense', 0.5), 0.5);
  assert.ok(expectedWinRate('Chase High-Out', 0.01) > 0);
  assert.strictEqual(expectedWinRate('Mid-Mid', null), null);
});
