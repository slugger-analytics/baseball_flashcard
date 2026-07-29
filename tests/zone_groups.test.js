'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  PITCH_GROUP_TAXONOMY,
  getPitchGroup,
  getZoneFromLocation,
  computeZoneGroupAnnotations,
  MIN_ZONE_GROUP_PITCHES,
  MIN_ZONE_GROUP_SWINGS,
  ZONE_GROUP_EDGE,
} = require('../lib/stats.js');

// ── getPitchGroup ────────────────────────────────────────────────────────────
test('getPitchGroup maps every taxonomy member to its group', () => {
  assert.strictEqual(getPitchGroup('Four-Seam'), 'Fastballs');
  assert.strictEqual(getPitchGroup('Sinker'), 'Fastballs');
  assert.strictEqual(getPitchGroup('Cutter'), 'Fastballs');
  assert.strictEqual(getPitchGroup('Slider'), 'Breaking');
  assert.strictEqual(getPitchGroup('Curveball'), 'Breaking');
  assert.strictEqual(getPitchGroup('Changeup'), 'Offspeed');
  assert.strictEqual(getPitchGroup('Splitter'), 'Offspeed');
});

test('getPitchGroup handles the ChangeUp casing variant', () => {
  assert.strictEqual(getPitchGroup('ChangeUp'), 'Offspeed');
});

test('getPitchGroup returns null for ungrouped / unknown / empty types', () => {
  // These live in NO group by design (kept out of filterByPitchGroup too).
  assert.strictEqual(getPitchGroup('Fastball'), null);
  assert.strictEqual(getPitchGroup('TwoSeamFastball'), null);
  assert.strictEqual(getPitchGroup('Knuckleball'), null);
  assert.strictEqual(getPitchGroup('Undefined'), null);
  assert.strictEqual(getPitchGroup(''), null);
  assert.strictEqual(getPitchGroup(undefined), null);
  assert.strictEqual(getPitchGroup(null), null);
});

test('PITCH_GROUP_TAXONOMY matches the filterByPitchGroup membership verbatim', () => {
  assert.deepStrictEqual(PITCH_GROUP_TAXONOMY.Fastballs, ['Four-Seam', 'Sinker', 'Cutter']);
  assert.deepStrictEqual(PITCH_GROUP_TAXONOMY.Breaking, ['Slider', 'Curveball']);
  assert.deepStrictEqual(PITCH_GROUP_TAXONOMY.Offspeed, ['Changeup', 'ChangeUp', 'Splitter']);
});

// ── getZoneFromLocation (regression lock, both hands) ────────────────────────
test('getZoneFromLocation pins RHB coordinate→sector cases', () => {
  // positive plate_loc_side = catcher's left = where a RHB stands = INSIDE for RHB.
  assert.strictEqual(getZoneFromLocation(0.5, 3.5, 'RHB'), 'High-In');
  assert.strictEqual(getZoneFromLocation(-0.5, 1.5, 'RHB'), 'Low-Out');
  assert.strictEqual(getZoneFromLocation(0.0, 2.5, 'RHB'), 'Mid-Mid');
  // boundaries are exclusive: 0.33 side and 3.0/2.0 height fall in the middle band.
  assert.strictEqual(getZoneFromLocation(0.33, 3.0, 'RHB'), 'Mid-Mid');
  assert.strictEqual(getZoneFromLocation(0.5, 2.0, 'RHB'), 'Mid-In');
});

test('getZoneFromLocation mirrors the sign convention for LHB', () => {
  // negative plate_loc_side is INSIDE for a LHB (mirror of RHB).
  assert.strictEqual(getZoneFromLocation(-0.5, 3.5, 'LHB'), 'High-In');
  assert.strictEqual(getZoneFromLocation(0.5, 1.5, 'LHB'), 'Low-Out');
  assert.strictEqual(getZoneFromLocation(0.0, 2.5, 'LHB'), 'Mid-Mid');
});

// ── constants ────────────────────────────────────────────────────────────────
test('zone-group gate constants are the documented values', () => {
  assert.strictEqual(MIN_ZONE_GROUP_PITCHES, 8);
  assert.strictEqual(MIN_ZONE_GROUP_SWINGS, 4);
  assert.strictEqual(ZONE_GROUP_EDGE, 0.25);
});

// ── computeZoneGroupAnnotations ──────────────────────────────────────────────
// overall = zone-level counters; groups = per-(zone×group) cells.
function mkZone(overall, groups) {
  return { pitches: 0, swings: 0, whiffs: 0, weakContact: 0, hardHits: 0, contact: 0, ...overall, groups };
}
function mkCell(cell) {
  return { pitches: 0, swings: 0, whiffs: 0, weakContact: 0, hardHits: 0, contact: 0, ...cell };
}

test('computeZoneGroupAnnotations: cell under 8 pitches does not annotate', () => {
  const za = {
    'Low-Out': mkZone({ swings: 10, whiffs: 5 }, {
      Breaking: mkCell({ pitches: 7, swings: 4, whiffs: 4 }), // rate 1.0 but n<8
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.ok(!('vg' in za['Low-Out']));
  assert.ok(!('groups' in za['Low-Out']));
});

test('computeZoneGroupAnnotations: n=8, swings=4, 2x zone rate → vg + vgN', () => {
  const za = {
    'Low-Out': mkZone({ swings: 8, whiffs: 2 }, { // zoneVulnRate = 0.25
      Breaking: mkCell({ pitches: 8, swings: 4, whiffs: 2 }), // cellRate 0.5 = 2x
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.strictEqual(za['Low-Out'].vg, 'Breaking');
  assert.strictEqual(za['Low-Out'].vgN, 8);
  assert.ok(!('groups' in za['Low-Out']));
});

test('computeZoneGroupAnnotations: only +20% over the zone rate stays below the gate', () => {
  const za = {
    'Low-Out': mkZone({ swings: 10, whiffs: 5 }, { // zoneVulnRate = 0.5; gate = 0.625
      Breaking: mkCell({ pitches: 8, swings: 5, whiffs: 3 }), // cellRate 0.6 (< 0.625)
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.ok(!('vg' in za['Low-Out']));
});

test('computeZoneGroupAnnotations: fewer than 4 swings does not annotate', () => {
  const za = {
    'Low-Out': mkZone({ swings: 8, whiffs: 2 }, {
      Breaking: mkCell({ pitches: 8, swings: 3, whiffs: 3 }), // rate 1.0 but swings<4
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.ok(!('vg' in za['Low-Out']));
});

test('computeZoneGroupAnnotations: hot needs cell contact >= 3', () => {
  const za = {
    'High-In': mkZone({ swings: 6, contact: 10, hardHits: 2 }, { // zoneHotRate = 0.2
      Breaking: mkCell({ pitches: 8, swings: 4, contact: 2, hardHits: 2 }), // rate 1.0 but contact<3
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.ok(!('hg' in za['High-In']));
  assert.ok(!('groups' in za['High-In']));
});

test('computeZoneGroupAnnotations: hot cell 2x zone rate with contact>=3 → hg + hgN', () => {
  const za = {
    'High-In': mkZone({ swings: 8, contact: 10, hardHits: 2 }, { // zoneHotRate = 0.2
      Fastballs: mkCell({ pitches: 8, swings: 4, contact: 4, hardHits: 2 }), // rate 0.5 = 2.5x
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.strictEqual(za['High-In'].hg, 'Fastballs');
  assert.strictEqual(za['High-In'].hgN, 8);
  assert.ok(!('vg' in za['High-In'])); // no vulnerability signal present
});

test('computeZoneGroupAnnotations: groups are always deleted, even when nothing qualifies', () => {
  const za = {
    'Mid-Mid': mkZone({ swings: 10, whiffs: 1 }, {
      Fastballs: mkCell({ pitches: 3, swings: 1, whiffs: 0 }), // too small
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.ok(!('groups' in za['Mid-Mid']));
  assert.ok(!('vg' in za['Mid-Mid']));
  assert.ok(!('hg' in za['Mid-Mid']));
});

test('computeZoneGroupAnnotations: a zero-swing zone does not crash', () => {
  const za = {
    'High-Mid': mkZone({ swings: 0 }, {
      Breaking: mkCell({ pitches: 8, swings: 0 }),
    }),
  };
  assert.doesNotThrow(() => computeZoneGroupAnnotations(za));
  assert.ok(!('vg' in za['High-Mid']));
  assert.ok(!('hg' in za['High-Mid']));
  assert.ok(!('groups' in za['High-Mid']));
});

test('computeZoneGroupAnnotations: two qualifying groups → the higher rate wins', () => {
  const za = {
    'Low-Out': mkZone({ swings: 16, whiffs: 4 }, { // zoneVulnRate = 0.25
      Fastballs: mkCell({ pitches: 8, swings: 8, whiffs: 4 }), // rate 0.5
      Breaking: mkCell({ pitches: 8, swings: 8, whiffs: 6 }),  // rate 0.75 (higher)
    }),
  };
  computeZoneGroupAnnotations(za);
  assert.strictEqual(za['Low-Out'].vg, 'Breaking');
  assert.strictEqual(za['Low-Out'].vgN, 8);
});

test('computeZoneGroupAnnotations: a zone with no groups is left untouched', () => {
  const za = { 'Mid-Out': mkZone({ swings: 5, whiffs: 2 }, undefined) };
  delete za['Mid-Out'].groups;
  computeZoneGroupAnnotations(za);
  assert.ok(!('vg' in za['Mid-Out']));
  assert.ok(!('groups' in za['Mid-Out']));
});
