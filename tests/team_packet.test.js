'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  teamsFromBattersIndex, rosterForTeam, orderProfilesForPrint, bulkPrintSettings,
} = require('../pitch_logic.js');

const INDEX = [
  { name: 'Adams, Al', ids: ['1'], team: 'York', bats: 'Right' },
  { name: 'Baker, Bo', ids: ['2'], team: 'Lancaster', bats: 'Left' },
  { name: 'Cole, Cy', ids: ['3'], team: 'York', bats: 'Switch' },
  { name: 'Dean, Di', ids: ['4'], team: '', bats: 'Right' },
  { name: 'Ellis, Ed', ids: ['5'], team: 'Lancaster', bats: 'Left' },
  { name: 'Frost, Fi', ids: ['6'], bats: 'Right' }, // no team key at all
];

// ── teamsFromBattersIndex ────────────────────────────────────────────────────
test('teamsFromBattersIndex returns sorted unique non-empty teams + teamless count', () => {
  const { teams, teamlessCount } = teamsFromBattersIndex(INDEX);
  assert.deepStrictEqual(teams, ['Lancaster', 'York']);
  assert.strictEqual(teamlessCount, 2); // '' and the missing team
});

test('teamsFromBattersIndex handles an empty index', () => {
  assert.deepStrictEqual(teamsFromBattersIndex([]), { teams: [], teamlessCount: 0 });
});

// ── rosterForTeam ────────────────────────────────────────────────────────────
test('rosterForTeam returns exactly the batters on that team', () => {
  const roster = rosterForTeam(INDEX, 'York');
  assert.deepStrictEqual(roster.map(b => b.name), ['Adams, Al', 'Cole, Cy']);
});

test('rosterForTeam returns [] for an unknown team', () => {
  assert.deepStrictEqual(rosterForTeam(INDEX, 'Nowhere'), []);
});

// ── orderProfilesForPrint ────────────────────────────────────────────────────
test('orderProfilesForPrint flattens all team keys, sorts by totalPitches desc, stable on ties', () => {
  const teamsData = {
    A: [
      { batter: 'a1', stats: { totalPitches: 10 } },
      { batter: 'a2', stats: { totalPitches: 30 } },
    ],
    B: [
      { batter: 'b1', stats: { totalPitches: 30 } },
      { batter: 'b2', stats: { totalPitches: 5 } },
    ],
  };
  const ordered = orderProfilesForPrint(teamsData);
  // 30s first, ties keep flatten order (a2 before b1); then 10, then 5.
  assert.deepStrictEqual(ordered.map(p => p.batter), ['a2', 'b1', 'a1', 'b2']);
});

test('orderProfilesForPrint tolerates missing stats and empty input', () => {
  assert.deepStrictEqual(orderProfilesForPrint({}), []);
  const ordered = orderProfilesForPrint({ T: [{ batter: 'x' }, { batter: 'y', stats: { totalPitches: 4 } }] });
  assert.deepStrictEqual(ordered.map(p => p.batter), ['y', 'x']); // y(4) beats x(0)
});

// ── bulkPrintSettings ────────────────────────────────────────────────────────
test('bulkPrintSettings resets exactly the 5 scoped keys and preserves the rest', () => {
  const current = {
    pitcherHandFilter: 'L', hiddenPitchTypes: ['SL'], circleColorMode: 'green',
    maxCirclesPerBucket: 'All', swingsOnly: true,
    pitchCircleSize: 38, bucketMinPitches: 3, maxPitchesDisplayed: 4, vulnerableZoneThreshold: 60,
  };
  const next = bulkPrintSettings(current);
  assert.strictEqual(next.pitcherHandFilter, 'All');
  assert.deepStrictEqual(next.hiddenPitchTypes, []);
  assert.strictEqual(next.circleColorMode, 'both');
  assert.strictEqual(next.maxCirclesPerBucket, 1);
  assert.strictEqual(next.swingsOnly, false);
  // preserved
  assert.strictEqual(next.pitchCircleSize, 38);
  assert.strictEqual(next.bucketMinPitches, 3);
  assert.strictEqual(next.maxPitchesDisplayed, 4);
  assert.strictEqual(next.vulnerableZoneThreshold, 60);
});

test('bulkPrintSettings does not mutate its input', () => {
  const current = { pitcherHandFilter: 'L', hiddenPitchTypes: ['SL'], circleColorMode: 'green', maxCirclesPerBucket: 'All', swingsOnly: true };
  const snapshot = JSON.parse(JSON.stringify(current));
  bulkPrintSettings(current);
  assert.deepStrictEqual(current, snapshot);
});
