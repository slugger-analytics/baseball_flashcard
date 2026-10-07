'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  annotateZoneGroups, ZONE_GROUP_MIN_PITCHES, ZONE_GROUP_MIN_SWINGS,
  ZONE_GROUP_MIN_CONTACT, ZONE_GROUP_EDGE,
} = require('../public/js/pitch_logic.js');

/** A zone with per-family cells, shaped as the server accumulates them. */
const zone = (totals, groups) => ({
  pitches: 0, swings: 0, whiffs: 0, weakContact: 0, contact: 0, hardHits: 0,
  ...totals, groups,
});
const cell = (o) => ({ pitches: 0, swings: 0, whiffs: 0, weakContact: 0, contact: 0, hardHits: 0, ...o });

test('a family whose whiff+weak rate clears the zone by the edge is named', () => {
  // Zone: 20 swings, 6 whiffs + 2 weak = 40%. Breaking: 8 swings, 6 whiffs = 75%.
  const za = { 'Low-Out': zone(
    { swings: 20, whiffs: 6, weakContact: 2 },
    { FB: cell({ pitches: 20, swings: 12, whiffs: 0, weakContact: 2 }),
      BB: cell({ pitches: 10, swings: 8, whiffs: 6 }) }
  ) };
  annotateZoneGroups(za);
  assert.strictEqual(za['Low-Out'].vg, 'BB');
  assert.strictEqual(za['Low-Out'].vgN, 10, 'reports the family pitch count, not swings');
});

test('a family whose hard-hit rate clears the zone by the edge is named', () => {
  // Zone: 20 contact, 5 hard = 25%. Fastballs: 10 contact, 5 hard = 50%.
  const za = { 'Mid-Mid': zone(
    { contact: 20, hardHits: 5 },
    { FB: cell({ pitches: 18, contact: 10, hardHits: 5 }),
      BB: cell({ pitches: 12, contact: 10, hardHits: 0 }) }
  ) };
  annotateZoneGroups(za);
  assert.strictEqual(za['Mid-Mid'].hg, 'FB');
  assert.strictEqual(za['Mid-Mid'].hgN, 18);
});

test('an evenly-spread zone gets no annotation rather than a best-of-three', () => {
  // Naming a family here would invent a pattern that is not in the data.
  const za = { 'High-In': zone(
    { swings: 20, whiffs: 6, contact: 20, hardHits: 4 },
    { FB: cell({ pitches: 15, swings: 10, whiffs: 3, contact: 10, hardHits: 2 }),
      BB: cell({ pitches: 15, swings: 10, whiffs: 3, contact: 10, hardHits: 2 }) }
  ) };
  annotateZoneGroups(za);
  assert.strictEqual(za['High-In'].vg, undefined);
  assert.strictEqual(za['High-In'].hg, undefined);
});

test('a family below the pitch floor is ignored however extreme its rate', () => {
  // 100% whiff on 7 pitches is noise; splitting a zone three ways cuts the sample
  // three ways, so the floor is deliberately stricter than the zone-level gate.
  const thin = ZONE_GROUP_MIN_PITCHES - 1;
  const za = { 'Low-In': zone(
    { swings: 20, whiffs: 4 },
    { BB: cell({ pitches: thin, swings: thin, whiffs: thin }) }
  ) };
  annotateZoneGroups(za);
  assert.strictEqual(za['Low-In'].vg, undefined);
});

test('swing and contact floors are enforced independently', () => {
  // Enough pitches, but too few swings to quote a whiff rate — and too few balls
  // in play to quote a hard-hit rate.
  const za = { 'Mid-Out': zone(
    { swings: 20, whiffs: 4, contact: 20, hardHits: 4 },
    { BB: cell({
        pitches: 30,
        swings: ZONE_GROUP_MIN_SWINGS - 1, whiffs: ZONE_GROUP_MIN_SWINGS - 1,
        contact: ZONE_GROUP_MIN_CONTACT - 1, hardHits: ZONE_GROUP_MIN_CONTACT - 1,
      }) }
  ) };
  annotateZoneGroups(za);
  assert.strictEqual(za['Mid-Out'].vg, undefined, 'swing floor holds');
  assert.strictEqual(za['Mid-Out'].hg, undefined, 'contact floor holds');
});

test('a rate merely at the zone average does not qualify; the edge must be cleared', () => {
  const za = { A: zone({ swings: 20, whiffs: 8 },
    { BB: cell({ pitches: 10, swings: 10, whiffs: 4 }) }) };          // 40% vs 40%
  annotateZoneGroups(za);
  assert.strictEqual(za.A.vg, undefined);

  // Exactly at the edge (40% * 1.25 = 50%) qualifies — the gate is inclusive.
  const atEdge = { A: zone({ swings: 20, whiffs: 8 },
    { BB: cell({ pitches: 10, swings: 10, whiffs: 5 }) }) };
  annotateZoneGroups(atEdge);
  assert.strictEqual(atEdge.A.vg, 'BB');
  assert.ok(Math.abs(ZONE_GROUP_EDGE - 0.25) < 1e-9);
});

test('the per-family cells are always stripped — they must never reach the wire', () => {
  // zoneAnalysis ships on the wire; 17 zones x 3 families of counters would bloat
  // a response that already has to fit the ALB's 1 MB limit.
  const za = {
    annotated: zone({ swings: 20, whiffs: 2 }, { BB: cell({ pitches: 10, swings: 8, whiffs: 8 }) }),
    unannotated: zone({ swings: 20, whiffs: 8 }, { FB: cell({ pitches: 2, swings: 1 }) }),
  };
  annotateZoneGroups(za);
  assert.ok(!('groups' in za.annotated), 'stripped when annotated');
  assert.ok(!('groups' in za.unannotated), 'stripped even when nothing qualified');
});

test('annotateZoneGroups tolerates empty, null and group-less input', () => {
  assert.strictEqual(annotateZoneGroups(null), null);
  assert.strictEqual(annotateZoneGroups(undefined), undefined);
  assert.deepStrictEqual(annotateZoneGroups({}), {});
  // A zone with no groups key (e.g. decoded from an older cached payload).
  const legacy = { 'Mid-Mid': { pitches: 5, swings: 3 } };
  assert.deepStrictEqual(annotateZoneGroups(legacy), legacy);
});

test('a zone with no swings or no contact cannot produce a rate', () => {
  const za = { A: zone({ swings: 0, contact: 0 },
    { BB: cell({ pitches: 20, swings: 0, contact: 0 }) }) };
  annotateZoneGroups(za);
  assert.strictEqual(za.A.vg, undefined);
  assert.strictEqual(za.A.hg, undefined);
});
