'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildCanonicalNameMap, dedupeBatters, mergeBats } = require('../lib/players.js');

const BATES_UPPER = { player_id: 'A', player_name: 'Bates, Austin', is_hitter: true, player_batting_handedness: 'Right', team_name: 'York Revolution' };
const BATES_LOWER = { player_id: 'B', player_name: 'bates, austin', is_hitter: true, player_batting_handedness: 'Switch', team_name: null };

test('buildCanonicalNameMap prefers the most-uppercase variant (tie → first seen)', () => {
  // lower variant seen first; the properly-cased one must still win.
  const m = buildCanonicalNameMap([BATES_LOWER, BATES_UPPER]);
  assert.strictEqual(m.get('bates, austin'), 'Bates, Austin');
});

test('dedupeBatters merges the case-variant pair into one entry', () => {
  const rows = dedupeBatters([BATES_UPPER, BATES_LOWER]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Bates, Austin');
  assert.deepStrictEqual([...rows[0].ids].sort(), ['A', 'B']);
  assert.strictEqual(rows[0].bats, 'Switch');
});

test('dedupeBatters keeps genuinely different names separate', () => {
  const rows = dedupeBatters([
    BATES_UPPER,
    { player_id: 'C', player_name: 'Smith, John', is_hitter: true, player_batting_handedness: 'Left' },
  ]);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.name).sort(), ['Bates, Austin', 'Smith, John']);
});

test('mergeBats prefers Switch, otherwise first non-null', () => {
  assert.strictEqual(mergeBats('Right', 'Switch'), 'Switch');
  assert.strictEqual(mergeBats('Switch', 'Right'), 'Switch');
  assert.strictEqual(mergeBats(null, 'Left'), 'Left');
  assert.strictEqual(mergeBats('Right', null), 'Right');
});
