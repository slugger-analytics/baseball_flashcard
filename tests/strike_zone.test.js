'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  STRIKE_ZONE, ZONE_PCT, plateToPercent, getZoneFromLocation, isChaseZone,
} = require('../pitch_logic.js');

const HW = STRIKE_ZONE.HALF_WIDTH;
const MID_H = (STRIKE_ZONE.TOP + STRIKE_ZONE.BOTTOM) / 2;

test('the drawn zone rectangle lands exactly where an on-the-edge pitch plots', () => {
  // This is the invariant the old code violated: labels split at ±0.33 ft / 2.0–3.0 ft
  // while the overlay drew a flat 33%/66% grid, so a circle could sit in the middle
  // cell and still be bucketed High-In. Both now derive from STRIKE_ZONE.
  const [leftX] = plateToPercent(-HW, MID_H);
  const [rightX] = plateToPercent(HW, MID_H);
  const [, topY] = plateToPercent(0, STRIKE_ZONE.TOP);
  const [, bottomY] = plateToPercent(0, STRIKE_ZONE.BOTTOM);

  assert.ok(Math.abs(leftX - ZONE_PCT.left) < 0.05, `${leftX} vs ${ZONE_PCT.left}`);
  assert.ok(Math.abs(rightX - ZONE_PCT.right) < 0.05, `${rightX} vs ${ZONE_PCT.right}`);
  assert.ok(Math.abs(topY - ZONE_PCT.top) < 0.05, `${topY} vs ${ZONE_PCT.top}`);
  assert.ok(Math.abs(bottomY - ZONE_PCT.bottom) < 0.05, `${bottomY} vs ${ZONE_PCT.bottom}`);
});

test('a pitch down the middle plots dead centre', () => {
  const [x, y] = plateToPercent(0, MID_H);
  assert.strictEqual(x, 50);
  assert.strictEqual(y, 50);
});

test('plateToPercent clamps wild pitches to the canvas instead of letting them escape', () => {
  const [farLeft, farLow] = plateToPercent(-12, -4);
  const [farRight, farHigh] = plateToPercent(12, 40);
  assert.strictEqual(farLeft, 0);
  assert.strictEqual(farLow, 100);
  assert.strictEqual(farRight, 100);
  assert.strictEqual(farHigh, 0);
});

test('in-zone pitches get the 9 box labels, split into equal thirds', () => {
  // Positive plate_loc_side = catcher's left = where a RHB stands = "In" for a RHB.
  assert.strictEqual(getZoneFromLocation(0, MID_H, 'RHB'), 'Mid-Mid');
  assert.strictEqual(getZoneFromLocation(0.6, MID_H, 'RHB'), 'Mid-In');
  assert.strictEqual(getZoneFromLocation(-0.6, MID_H, 'RHB'), 'Mid-Out');
  assert.strictEqual(getZoneFromLocation(0, 3.3, 'RHB'), 'High-Mid');
  assert.strictEqual(getZoneFromLocation(0, 1.7, 'RHB'), 'Low-Mid');
  assert.strictEqual(getZoneFromLocation(0.6, 3.3, 'RHB'), 'High-In');
  assert.strictEqual(getZoneFromLocation(-0.6, 1.7, 'RHB'), 'Low-Out');
});

test('In/Out mirrors for a left-handed batter', () => {
  assert.strictEqual(getZoneFromLocation(0.6, MID_H, 'LHB'), 'Mid-Out');
  assert.strictEqual(getZoneFromLocation(-0.6, MID_H, 'LHB'), 'Mid-In');
  assert.strictEqual(getZoneFromLocation(-0.6, 3.3, 'LHB'), 'High-In');
});

test('pitches outside the zone get separate Chase buckets, named by how they missed', () => {
  assert.strictEqual(getZoneFromLocation(-1.4, MID_H, 'RHB'), 'Chase Mid-Out');
  assert.strictEqual(getZoneFromLocation(1.4, MID_H, 'RHB'), 'Chase Mid-In');
  assert.strictEqual(getZoneFromLocation(0, 4.0, 'RHB'), 'Chase High-Mid');
  assert.strictEqual(getZoneFromLocation(0, 1.0, 'RHB'), 'Chase Low-Mid');
  assert.strictEqual(getZoneFromLocation(-1.4, 4.0, 'RHB'), 'Chase High-Out');
  assert.strictEqual(getZoneFromLocation(1.4, 1.0, 'LHB'), 'Chase Low-Out');
});

test('a sweep of the plate produces exactly the 9 in-zone boxes and 8 chase regions', () => {
  const sides = [-1.6, -1.0, -0.83, -0.5, 0, 0.5, 0.83, 1.0, 1.6];
  const heights = [1.0, 1.5, 1.9, 2.5, 3.1, 3.5, 4.0];
  const inZone = new Set();
  const chase = new Set();
  for (const s of sides) {
    for (const h of heights) {
      const z = getZoneFromLocation(s, h, 'RHB');
      (isChaseZone(z) ? chase : inZone).add(z);
    }
  }
  assert.deepStrictEqual([...inZone].sort(), [
    'High-In', 'High-Mid', 'High-Out',
    'Low-In', 'Low-Mid', 'Low-Out',
    'Mid-In', 'Mid-Mid', 'Mid-Out',
  ]);
  assert.deepStrictEqual([...chase].sort(), [
    'Chase High-In', 'Chase High-Mid', 'Chase High-Out',
    'Chase Low-In', 'Chase Low-Mid', 'Chase Low-Out',
    'Chase Mid-In', 'Chase Mid-Out',
  ]);
  // 'Chase Mid-Mid' is unreachable by construction: both axes inside the zone
  // extents IS the strike zone.
  assert.ok(!chase.has('Chase Mid-Mid'));
});

test('the zone boundary is inclusive — a pitch clipping the edge is a strike, not a chase', () => {
  assert.ok(!isChaseZone(getZoneFromLocation(HW, MID_H, 'RHB')));
  assert.ok(!isChaseZone(getZoneFromLocation(-HW, MID_H, 'RHB')));
  assert.ok(!isChaseZone(getZoneFromLocation(0, STRIKE_ZONE.TOP, 'RHB')));
  assert.ok(!isChaseZone(getZoneFromLocation(0, STRIKE_ZONE.BOTTOM, 'RHB')));
  // Just past it is a chase.
  assert.ok(isChaseZone(getZoneFromLocation(HW + 0.01, MID_H, 'RHB')));
  assert.ok(isChaseZone(getZoneFromLocation(0, STRIKE_ZONE.TOP + 0.01, 'RHB')));
});
