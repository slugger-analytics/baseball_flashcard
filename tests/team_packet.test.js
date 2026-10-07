'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { orderProfilesForPrint, bulkPrintSettings } = require('../public/js/pitch_logic.js');

const profile = (batter, handedness, totalPitches) =>
  ({ batter, handedness, stats: { totalPitches } });

test('profiles print most-seen first, across every team key', () => {
  // A card response is keyed by team, and a traded player appears under both.
  const ordered = orderProfilesForPrint({
    'Hagerstown Flying Boxcars': [profile('Abreu, Osvaldo', 'RHB', 255)],
    'Staten Island Ferry Hawks': [profile('Abreu, Osvaldo', 'RHB', 695)],
  });
  assert.deepStrictEqual(ordered.map(p => p.stats.totalPitches), [695, 255]);
});

test('a switch hitter prints both sides, stronger side leading', () => {
  // Switch hitters are keyed by name AND side, so one batter yields two cards.
  const ordered = orderProfilesForPrint({
    'York Revolution': [
      profile('Otosaka, Tomo', 'RHB', 120),
      profile('Otosaka, Tomo', 'LHB', 480),
    ],
  });
  assert.deepStrictEqual(ordered.map(p => p.handedness), ['LHB', 'RHB']);
  assert.strictEqual(ordered.length, 2, 'both sides print');
});

test('equal pitch counts keep their incoming order (stable sort)', () => {
  const ordered = orderProfilesForPrint({
    T: [profile('A', 'RHB', 100), profile('B', 'RHB', 100), profile('C', 'RHB', 100)],
  });
  assert.deepStrictEqual(ordered.map(p => p.batter), ['A', 'B', 'C']);
});

test('orderProfilesForPrint tolerates empty and malformed responses', () => {
  assert.deepStrictEqual(orderProfilesForPrint({}), []);
  assert.deepStrictEqual(orderProfilesForPrint(null), []);
  assert.deepStrictEqual(orderProfilesForPrint(undefined), []);
  // A profile with no stats sorts last rather than throwing.
  const ordered = orderProfilesForPrint({ T: [{ batter: 'NoStats' }, profile('Has', 'RHB', 5)] });
  assert.deepStrictEqual(ordered.map(p => p.batter), ['Has', 'NoStats']);
});

test('bulk print neutralises the batter-scoped filters', () => {
  // A hand filter or hidden pitch type left over from browsing ONE hitter would
  // otherwise silently apply to all fifteen cards in the packet.
  const live = {
    pitcherHandFilter: 'L', hiddenPitchTypes: ['SL', 'CB'], circleColorMode: 'green',
    maxCirclesPerBucket: 'All', swingsOnly: true,
  };
  const packet = bulkPrintSettings(live);
  assert.strictEqual(packet.pitcherHandFilter, 'All');
  assert.deepStrictEqual(packet.hiddenPitchTypes, []);
  assert.strictEqual(packet.circleColorMode, 'both');
  assert.strictEqual(packet.maxCirclesPerBucket, 1);
  assert.strictEqual(packet.swingsOnly, false);
});

test('bulk print preserves purely visual preferences', () => {
  // Circle size, how many are shown and colour sensitivity are the user's reading
  // preference, not a filter — resetting them would fight the user.
  const packet = bulkPrintSettings({
    pitchCircleSize: 44, maxPitchesDisplayed: 8, ratingSensitivity: 5,
    bucketMinPitches: 6, pitcherHandFilter: 'R',
  });
  assert.strictEqual(packet.pitchCircleSize, 44);
  assert.strictEqual(packet.maxPitchesDisplayed, 8);
  assert.strictEqual(packet.ratingSensitivity, 5);
  assert.strictEqual(packet.bucketMinPitches, 6);
});

test('bulkPrintSettings does not mutate the live settings object', () => {
  // printTeamPacket swaps CURRENT_SETTINGS and restores it in a finally; if this
  // mutated in place, the user's filters would be silently lost after printing.
  const live = { pitcherHandFilter: 'L', hiddenPitchTypes: ['SL'], swingsOnly: true };
  const snapshot = JSON.parse(JSON.stringify(live));
  bulkPrintSettings(live);
  assert.deepStrictEqual(live, snapshot);
});
