'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  asciiFold, normalizeName, stripSuffix, splitIscoreName, splitSluggerName,
  editDistance, buildHitterIndex, matchHitter, iscoreHitters, batsCode,
} = require('../lib/iscore.js');

/** Shorthand for a SLUGGER /players row. */
function sp(name, id, bats = null, hitter = true) {
  return { player_name: name, player_id: id, is_hitter: hitter, player_batting_handedness: bats };
}

test('normalization folds accents, case, punctuation and suffixes', () => {
  assert.strictEqual(asciiFold('Peña'), 'Pena');
  assert.strictEqual(normalizeName('  J.C.  '), 'j c');
  assert.strictEqual(normalizeName('Peña, José'), 'pena jose');
  assert.strictEqual(stripSuffix(normalizeName('Long Jr.')), 'long');
  assert.strictEqual(stripSuffix(normalizeName('Martin III')), 'martin');
});

test('name splitting keeps compound surnames intact', () => {
  // iScore gives "First Last"; splitting on the FIRST space only is what keeps
  // multi-word surnames whole.
  assert.deepStrictEqual(splitIscoreName('Fin Del Bonta-Smith'),
    { first: 'Fin', last: 'Del Bonta-Smith' });
  assert.deepStrictEqual(splitIscoreName('Narciso Crook'), { first: 'Narciso', last: 'Crook' });
  // SLUGGER gives "Last, First".
  assert.deepStrictEqual(splitSluggerName('Del Bonta-Smith, Fin'),
    { first: 'Fin', last: 'Del Bonta-Smith' });
  // ...and falls back to First-Last when there is no comma.
  assert.deepStrictEqual(splitSluggerName('Narciso Crook'), { first: 'Narciso', last: 'Crook' });
});

test('editDistance bails out early rather than scoring far-apart names', () => {
  assert.strictEqual(editDistance('crook', 'crook'), 0);
  assert.strictEqual(editDistance('flores', 'florez'), 1);
  assert.ok(editDistance('crook', 'martinez', 2) > 2);
});

test('the hitter index merges duplicate rows for one person and skips pitchers', () => {
  const index = buildHitterIndex([
    sp('Crook, Narciso', 'id-1', 'Right'),
    sp('Crook, Narciso', 'id-2', 'Right'),      // duplicate row, same person
    sp('Kane, Tommy', 'id-3', 'Left'),
    sp('Someone, Pitcher', 'id-4', 'Right', false), // not a hitter
    sp('', 'id-5'),                              // junk row
  ]);
  assert.strictEqual(index.length, 2);
  const crook = index.find(e => e.last === 'crook');
  assert.deepStrictEqual(crook.ids, ['id-1', 'id-2'], 'ids from both rows are pooled');
  assert.ok(!index.some(e => e.last === 'someone'), 'pitchers excluded');
});

test('an exact name match resolves with full confidence', () => {
  const index = buildHitterIndex([sp('Crook, Narciso', 'id-1', 'Right')]);
  const m = matchHitter({ name: 'Narciso Crook', bats: 'R' }, index);
  assert.strictEqual(m.confidence, 'exact');
  assert.deepStrictEqual(m.match.ids, ['id-1']);
});

test('known iScore misspellings and nicknames still resolve', () => {
  const index = buildHitterIndex([
    sp('Mateo, Francisco', 'id-1'), sp('Fix, Isaac', 'id-2'), sp('Kane, Tommy', 'id-3'),
  ]);
  // Real cases documented by the pitching widget's unmatched-player test.
  assert.strictEqual(matchHitter({ name: 'Fransisco Mateo' }, index).match.name, 'Mateo, Francisco');
  assert.strictEqual(matchHitter({ name: 'Issac Fix' }, index).match.name, 'Fix, Isaac');
  assert.strictEqual(matchHitter({ name: 'Thomas Kane' }, index).match.name, 'Kane, Tommy');
});

test('first-name prefixes resolve — the Blackwell/Ross duplicate case', () => {
  const index = buildHitterIndex([sp('Ross, Jackson', 'id-1')]);
  const m = matchHitter({ name: 'Jack Ross' }, index);
  assert.strictEqual(m.match.name, 'Ross, Jackson');
  assert.strictEqual(m.confidence, 'high');
});

test('accented and suffixed names match their plain counterparts', () => {
  const index = buildHitterIndex([sp('Peña, José', 'id-1'), sp('Long Jr., Shed', 'id-2')]);
  assert.strictEqual(matchHitter({ name: 'Jose Pena' }, index).match.name, 'Peña, José');
  assert.strictEqual(matchHitter({ name: 'Shed Long' }, index).match.name, 'Long Jr., Shed');
});

test('two equally good candidates are refused, not guessed', () => {
  // Handing a coach the wrong batter's card is worse than handing him none.
  const index = buildHitterIndex([sp('Garcia, Anthony', 'id-1'), sp('Garcia, Andrew', 'id-2')]);
  const m = matchHitter({ name: 'A. Garcia' }, index);
  assert.strictEqual(m.match, null);
  assert.match(m.reason, /ambiguous/);
  assert.strictEqual(m.candidates.length, 2, 'both candidates are reported for a human to pick');
});

test('a player absent from SLUGGER reports no candidate rather than a bad match', () => {
  const index = buildHitterIndex([sp('Crook, Narciso', 'id-1')]);
  const m = matchHitter({ name: 'Aaron Schunk' }, index);
  assert.strictEqual(m.match, null);
  assert.strictEqual(m.reason, 'no candidate');
});

test('disagreeing batting hand demotes a match', () => {
  const index = buildHitterIndex([sp('Ross, Jackson', 'id-1', 'Right')]);
  const agree = matchHitter({ name: 'Jack Ross', bats: 'R' }, index);
  const clash = matchHitter({ name: 'Jack Ross', bats: 'L' }, index);
  assert.strictEqual(agree.confidence, 'high');
  assert.strictEqual(clash.confidence, 'medium', 'same name, but the hands disagree');
});

test('batsCode normalizes the forms both feeds use', () => {
  assert.strictEqual(batsCode('Left'), 'L');
  assert.strictEqual(batsCode('R'), 'R');
  assert.strictEqual(batsCode('Switch'), 'S');
  assert.strictEqual(batsCode('Both'), 'S');
  assert.strictEqual(batsCode(''), null);
});

test('iscoreHitters keeps active position players and drops pitchers', () => {
  const roster = [
    { guid: 'g1', name: 'Narciso  Crook', number: 26, bats: 'R', throwsHand: 'R',
      positionGroup: { name: 'Outfielder' }, active: true },
    { guid: 'g2', name: 'Some Pitcher', number: 40, positionGroup: { name: 'Pitcher' }, active: true },
    { guid: 'g3', name: 'Retired Guy', number: 1, positionGroup: { name: 'Infielder' }, active: false },
    { guid: 'g4', name: 'Cole Griffith', number: 48, bats: 'R',
      positionGroup: { name: 'Catcher' }, active: true },
  ];
  const hitters = iscoreHitters(roster);
  assert.deepStrictEqual(hitters.map(h => h.name), ['Narciso Crook', 'Cole Griffith']);
  assert.strictEqual(hitters[0].number, '26', 'number is stringified for display');
  assert.strictEqual(hitters[0].bats, 'R');
});
