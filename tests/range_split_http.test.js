'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-range-split';
// Own cache dir: test files run in parallel processes, and this one seeds cache
// files that a sibling's beforeEach clear would otherwise race to delete.
const CACHE_DIR = '/tmp/cache-range-split';
process.env.CACHE_DIR = CACHE_DIR;

const axios = require('axios');
const realGet = axios.get;
const app = require('../server.js');

function isoOffset(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Two batters on two teams so summary/team responses have real shape to assert.
function twoTeamPitches(dateStr) {
  const out = [];
  for (const [batterId, teamCode] of [['split-batter-a', 'YOR'], ['split-batter-b', 'LAN']]) {
    for (let i = 0; i < 12; i++) {
      const base = {
        date: dateStr, rel_speed: 90, batter_id: batterId, batter_team_code: teamCode,
        pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
        top_or_bottom: 'Top', inning: i + 1, pa_of_inning: 1,
        plate_loc_side: 0.1, plate_loc_height: 2.4, auto_pitch_type: 'Four-Seam',
      };
      out.push({ ...base, balls: 0, strikes: 0, pitch_call: 'StrikeCalled' });
      out.push({ ...base, balls: 0, strikes: 1, pitch_call: 'InPlay', play_result: 'Out', exit_speed: 71 });
    }
  }
  return out;
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  try {
    return await fn(server.address().port);
  } finally {
    server.close();
  }
}

function clearRangeCaches() {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith('cache_2') || f.startsWith('league_fp_')) {
        fs.unlinkSync(path.join(CACHE_DIR, f));
      }
    }
  } catch (_) { /* dir may not exist */ }
}

test.beforeEach(() => { clearRangeCaches(); });
test.afterEach(() => { axios.get = realGet; clearRangeCaches(); });

// Distinct date ranges per test: the wire memo is keyed on the range and lives
// for the module, so reusing a range would serve one test's data to another.
function rangeQuery(start, end, extra = '') {
  return `/api/teams/range?startDate=${start}&endDate=${end}&maxVelocity=105&pitchGroup=All${extra}`;
}

test('summary=1 returns team batter counts and metadata, but no batter data', async () => {
  const START = isoOffset(-12), END = isoOffset(-3);
  axios.get = async () => ({ data: { success: true, data: twoTeamPitches(END) } });

  await withServer(async port => {
    const res = await get(port, rangeQuery(START, END, '&summary=1'));
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);

    assert.strictEqual(body.teamsData, undefined);
    const names = Object.keys(body.teams);
    assert.strictEqual(names.length, 2, res.body);
    for (const name of names) assert.strictEqual(body.teams[name], 1);
    assert.strictEqual(body.metadata.startDate, START);
    assert.strictEqual(body.metadata.endDate, END);
    assert.ok(body.metadata.pzLegend, 'summary metadata keeps the legend shape');
  });
});

test('team=<name> returns exactly that team, decodable with the shared legend', async () => {
  const START = isoOffset(-26), END = isoOffset(-17);
  axios.get = async () => ({ data: { success: true, data: twoTeamPitches(END) } });

  await withServer(async port => {
    const summary = JSON.parse((await get(port, rangeQuery(START, END, '&summary=1'))).body);
    const [first, second] = Object.keys(summary.teams).sort();

    const res = await get(port, rangeQuery(START, END, `&team=${encodeURIComponent(first)}`));
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);

    assert.deepStrictEqual(Object.keys(body.teamsData), [first]);
    assert.strictEqual(body.teamsData[first].length, 1);
    const batter = body.teamsData[first][0];
    assert.ok(batter.pz && Array.isArray(batter.pz.x), 'columnar pz survives slicing');
    assert.ok(body.metadata.pzLegend.t.length > 0, 'slice carries the legend it decodes with');
    assert.ok(!(second in body.teamsData));
  });
});

test('an unknown team is a 404 that names the real choices', async () => {
  const START = isoOffset(-40), END = isoOffset(-31);
  axios.get = async () => ({ data: { success: true, data: twoTeamPitches(END) } });

  await withServer(async port => {
    const res = await get(port, rangeQuery(START, END, '&team=No%20Such%20Team'));
    assert.strictEqual(res.status, 404, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'unknown_team');
    assert.strictEqual(body.teams.length, 2);
  });
});

test('a wide range tiled by cached windows is assembled without a fetch or a clamp', async () => {
  // 100 days — far past the 60-day clamp. Two adjacent cached windows cover it,
  // so it must be served in full, from disk, with no upstream call and no notice.
  const START = isoOffset(-104), MID = isoOffset(-55), MID1 = isoOffset(-54), END = isoOffset(-5);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `cache_${START}_${MID}.json`), JSON.stringify(twoTeamPitches(MID)));
  fs.writeFileSync(path.join(CACHE_DIR, `cache_${MID1}_${END}.json`), JSON.stringify(twoTeamPitches(END)));

  axios.get = async () => { throw new Error('must not fetch: the range is tiled by cached windows'); };

  await withServer(async port => {
    const summary = await get(port, rangeQuery(START, END, '&summary=1'));
    assert.strictEqual(summary.status, 200, summary.body);
    const sumBody = JSON.parse(summary.body);
    assert.strictEqual(sumBody.metadata.startDate, START);
    assert.strictEqual(sumBody.metadata.notice, undefined);
    assert.strictEqual(sumBody.metadata.partial, undefined);
    // Both windows contributed: each team's lone batter saw both files' pitches.
    assert.strictEqual(sumBody.metadata.filesProcessed, twoTeamPitches(END).length * 2);

    const teamName = Object.keys(sumBody.teams)[0];
    const slice = await get(port, rangeQuery(START, END, `&team=${encodeURIComponent(teamName)}`));
    assert.strictEqual(slice.status, 200, slice.body);
    const sliceBody = JSON.parse(slice.body);
    assert.strictEqual(sliceBody.teamsData[teamName].length, 1);
  });
});

test('the memo serves repeat requests after the cache files are gone', async () => {
  const START = isoOffset(-20), END = isoOffset(-13);
  axios.get = async () => ({ data: { success: true, data: twoTeamPitches(END) } });

  await withServer(async port => {
    const summary = await get(port, rangeQuery(START, END, '&summary=1'));
    assert.strictEqual(summary.status, 200, summary.body);
    const teamName = Object.keys(JSON.parse(summary.body).teams)[0];

    // The team slices of a wide load arrive moments after the summary; they must
    // not pay for a second fetch+transform — or any fetch at all.
    clearRangeCaches();
    axios.get = async () => { throw new Error('must not fetch: the memo has this range'); };

    const slice = await get(port, rangeQuery(START, END, `&team=${encodeURIComponent(teamName)}`));
    assert.strictEqual(slice.status, 200, slice.body);
    assert.strictEqual(JSON.parse(slice.body).teamsData[teamName].length, 1);
  });
});
