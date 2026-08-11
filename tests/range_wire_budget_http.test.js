'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-wire-budget';
// Absurdly small on purpose: every full response trips the guard, while summary
// and per-team requests — which the guard must never touch — still pass.
process.env.MAX_WIRE_BYTES = '1000';
// Own cache dir: test files run in parallel processes against a shared /tmp.
const CACHE_DIR = '/tmp/cache-wire-budget';
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

const START = isoOffset(-9);
const END = isoOffset(-2);

function batterPitches(dateStr) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const base = {
      date: dateStr, rel_speed: 90, batter_id: 'budget-batter', batter_team_code: 'YOR',
      pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
      top_or_bottom: 'Top', inning: i + 1, pa_of_inning: 1,
      plate_loc_side: 0.1, plate_loc_height: 2.4, auto_pitch_type: 'Four-Seam',
    };
    out.push({ ...base, balls: 0, strikes: 0, pitch_call: 'StrikeCalled' });
    out.push({ ...base, balls: 0, strikes: 1, pitch_call: 'InPlay', play_result: 'Out', exit_speed: 71 });
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

const RANGE_PATH = `/api/teams/range?startDate=${START}&endDate=${END}&maxVelocity=105&pitchGroup=All`;

test('an over-budget full response is a 413 naming the teams, never a bare 502', async () => {
  axios.get = async () => ({ data: { success: true, data: batterPitches(END) } });

  await withServer(async port => {
    const res = await get(port, RANGE_PATH);
    assert.strictEqual(res.status, 413, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'response_too_large');
    assert.ok(Array.isArray(body.teams) && body.teams.length === 1, res.body);

    // The escape hatches the 413 points to must both still work.
    const summary = await get(port, `${RANGE_PATH}&summary=1`);
    assert.strictEqual(summary.status, 200, summary.body);

    const slice = await get(port, `${RANGE_PATH}&team=${encodeURIComponent(body.teams[0])}`);
    assert.strictEqual(slice.status, 200, slice.body);
    assert.strictEqual(JSON.parse(slice.body).teamsData[body.teams[0]].length, 1);
  });
});
