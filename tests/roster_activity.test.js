'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeTeamName, activityWindow, latestTeamByBatter, applyActivityFilter,
  ACTIVITY_WINDOW_DAYS,
} = require('../lib/iscore.js');

const CODES = {
  HAG_FLY: 'Hagerstown Flying Boxcars',
  STA_YAN: 'Staten Island FerryHawks',   // note: no space — iScore writes "Ferry Hawks"
  HP: 'High Point Rockers',
  SMD: 'Southern Maryland Blue Crabs',
};
const batter = (name, ids, number = '1') => ({ name, ids, number, bats: 'R', position: 'Infielder' });
const club = (name, batters) => ({ guid: 'g-' + name, name, batters });

test('team names match across feeds despite punctuation differences', () => {
  // iScore writes "Staten Island Ferry Hawks"; the server says "FerryHawks". Nine
  // of ten clubs match verbatim, so an exact compare would silently drop exactly
  // one roster — and it is the most inflated club in the league.
  assert.strictEqual(normalizeTeamName('Staten Island Ferry Hawks'),
                     normalizeTeamName('Staten Island FerryHawks'));
  assert.strictEqual(normalizeTeamName('York Revolution'), 'yorkrevolution');
  assert.strictEqual(normalizeTeamName(null), '');
});

test('the activity window is anchored to the last day with data, not today', () => {
  // The 2026 season ended 2026-09-13. A window counted back from today would hold
  // no games at all and would empty every roster.
  assert.deepStrictEqual(activityWindow('2026-09-13', 21),
    { start: '2026-08-24', end: '2026-09-13' });
  // Inclusive on both ends: a 1-day window is that single day.
  assert.deepStrictEqual(activityWindow('2026-09-13', 1),
    { start: '2026-09-13', end: '2026-09-13' });
  assert.ok(ACTIVITY_WINDOW_DAYS >= 1);
});

test('latestTeamByBatter keeps the most recent club per batter', () => {
  const latest = latestTeamByBatter([
    { date: '2026-09-01', batter_id: 'a', batter_team_code: 'HP' },
    { date: '2026-09-12', batter_id: 'a', batter_team_code: 'SMD' },  // traded
    { date: '2026-09-05', batter_id: 'b', batter_team_code: 'HAG_FLY' },
    { date: '2026-09-02', batter_id: 'a', batter_team_code: 'HP' },   // out of order
    { date: '', batter_id: 'c', batter_team_code: 'HP' },             // junk
    { date: '2026-09-09', batter_id: null, batter_team_code: 'HP' },  // junk
  ]);
  assert.strictEqual(latest.get('a').teamCode, 'SMD');
  assert.strictEqual(latest.get('a').date, '2026-09-12');
  assert.strictEqual(latest.get('b').teamCode, 'HAG_FLY');
  assert.ok(!latest.has('c'), 'records without a date are ignored');
  assert.strictEqual(latest.size, 2);
});

test('a departed player is dropped from his old club', () => {
  const teams = [club('High Point Rockers', [batter('Gone, Guy', ['x'])])];
  const latest = new Map([['x', { date: '2026-09-12', teamCode: 'SMD' }]]);
  const { teams: out, dropped } = applyActivityFilter(teams, latest, CODES);
  assert.strictEqual(out[0].batters.length, 0);
  assert.strictEqual(dropped, 1);
});

test('a player listed by two clubs lands only on the one he last played for', () => {
  const teams = [
    club('High Point Rockers', [batter('McCarthy, Ryan', ['m1', 'm2'])]),
    club('Southern Maryland Blue Crabs', [batter('McCarthy, Ryan', ['m1', 'm2'])]),
  ];
  const latest = new Map([
    ['m1', { date: '2026-08-30', teamCode: 'HP' }],   // earlier stint
    ['m2', { date: '2026-09-12', teamCode: 'SMD' }],  // current
  ]);
  const { teams: out } = applyActivityFilter(teams, latest, CODES);
  assert.strictEqual(out[0].batters.length, 0, 'dropped from the old club');
  assert.strictEqual(out[1].batters.length, 1, 'kept on the current one');
});

test('ids are resolved jointly, not one at a time', () => {
  // A traded player often carries an id per stint. Testing each id separately left
  // him on BOTH clubs; his single most recent pitch has to decide.
  const teams = [club('High Point Rockers', [batter('Split, Ian', ['old', 'new'])])];
  const stale = new Map([
    ['old', { date: '2026-09-01', teamCode: 'HP' }],
    ['new', { date: '2026-09-13', teamCode: 'SMD' }],
  ]);
  assert.strictEqual(applyActivityFilter(teams, stale, CODES).teams[0].batters.length, 0,
    'the newer id wins even though an older one points here');
});

test('duplicate iScore records for one person collapse to a single card', () => {
  // Danny Ortiz is listed twice on Hagerstown — same date of birth, different
  // jersey numbers, both flagged active. Without this his card prints twice in a
  // team packet.
  const teams = [club('Hagerstown Flying Boxcars', [
    { ...batter('Ortiz, Danny', ['o1'], '20'), iscoreGuid: '0d9e' },
    { ...batter('Ortiz, Danny', ['o1'], '26'), iscoreGuid: '6702' },
  ])];
  const latest = new Map([['o1', { date: '2026-09-13', teamCode: 'HAG_FLY' }]]);
  const { teams: out, deduped } = applyActivityFilter(teams, latest, CODES);
  assert.strictEqual(out[0].batters.length, 1);
  assert.strictEqual(deduped, 1);
});

test('deduping happens even with no activity data', () => {
  // iScore's duplicate records are a defect in their data, not a consequence of
  // filtering, so they must collapse on the fallback path too.
  const teams = [club('Hagerstown Flying Boxcars', [
    { ...batter('Ortiz, Danny', ['o1'], '20'), iscoreGuid: 'a' },
    { ...batter('Ortiz, Danny', ['o1'], '26'), iscoreGuid: 'b' },
  ])];
  const { teams: out, dropped, deduped } = applyActivityFilter(teams, null, CODES);
  assert.strictEqual(out[0].batters.length, 1);
  assert.strictEqual(deduped, 1);
  assert.strictEqual(dropped, 0, 'nothing is dropped without activity data');
});

test('no activity data means the unfiltered roster, never an empty one', () => {
  // The filter improves the roster; it is not a dependency of it. A failed pitch
  // fetch must degrade to iScore's list rather than emptying the picker.
  const teams = [club('High Point Rockers', [
    batter('A', ['a']), batter('B', ['b']), batter('C', ['c']),
  ])];
  const { teams: out, dropped } = applyActivityFilter(teams, null, CODES);
  assert.strictEqual(out[0].batters.length, 3);
  assert.strictEqual(dropped, 0);
});

test('an unmapped team code cannot silently keep a player', () => {
  const teams = [club('High Point Rockers', [batter('X', ['x'])])];
  const latest = new Map([['x', { date: '2026-09-12', teamCode: 'UNKNOWN_CODE' }]]);
  assert.strictEqual(applyActivityFilter(teams, latest, CODES).teams[0].batters.length, 0);
});

test('surviving batters stay sorted by name', () => {
  const teams = [club('High Point Rockers', [
    batter('Zulu, Zed', ['z']), batter('Alpha, Ann', ['a']), batter('Mike, Moe', ['m']),
  ])];
  const latest = new Map([
    ['z', { date: '2026-09-12', teamCode: 'HP' }],
    ['a', { date: '2026-09-12', teamCode: 'HP' }],
    ['m', { date: '2026-09-12', teamCode: 'HP' }],
  ]);
  const { teams: out } = applyActivityFilter(teams, latest, CODES);
  assert.deepStrictEqual(out[0].batters.map(b => b.name), ['Alpha, Ann', 'Mike, Moe', 'Zulu, Zed']);
});
