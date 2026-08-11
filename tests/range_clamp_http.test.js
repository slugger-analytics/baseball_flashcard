'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-range-clamp';
// Own cache dir: test files run in parallel processes, and the cached-superset
// test seeds a file that a sibling's beforeEach clear would race to delete.
const CACHE_DIR = '/tmp/cache-range-clamp';
process.env.CACHE_DIR = CACHE_DIR;

const axios = require('axios');
const realGet = axios.get;
const app = require('../server.js');

const CLAMP_DAYS = 60;

function isoOffset(days) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Relative to today so this doesn't rot: a 105-day window ending two days ago.
const END = isoOffset(-2);
const REQUESTED_START = isoOffset(-107);
const EXPECTED_START = isoOffset(-2 - CLAMP_DAYS);

function batterPitches(dateStr) {
  const out = [];
  for (let i = 0; i < 12; i++) {
    const base = {
      date: dateStr, rel_speed: 90, batter_id: 'clamp-batter', batter_team_code: 'YOR',
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

const RANGE_PATH = `/api/teams/range?startDate=${REQUESTED_START}&endDate=${END}&maxVelocity=105&pitchGroup=All`;

test('an over-budget uncached range is clamped AND says so', async () => {
  axios.get = async () => ({ data: { success: true, data: batterPitches(END) } });

  await withServer(async port => {
    const res = await get(port, RANGE_PATH);
    assert.strictEqual(res.status, 200, res.body);
    const meta = JSON.parse(res.body).metadata;

    assert.strictEqual(meta.startDate, EXPECTED_START);
    assert.strictEqual(meta.endDate, END);
    assert.strictEqual(meta.requestedStartDate, REQUESTED_START);
    assert.strictEqual(meta.clampedTo, CLAMP_DAYS);
    assert.strictEqual(meta.partial, true);

    // The notice is the whole reason clamping is acceptable. It must name BOTH the
    // window asked for and the window actually served — a coach must never be handed
    // a narrower range and left to assume it was the one they picked.
    assert.strictEqual(typeof meta.notice, 'string');
    assert.ok(meta.notice.includes(REQUESTED_START), meta.notice);
    assert.ok(meta.notice.includes(EXPECTED_START), meta.notice);
    assert.ok(meta.notice.includes(END), meta.notice);
  });
});

test('a cached superset is served in full, with no clamp and no notice', async () => {
  // Reading an existing range off disk costs seconds, so there is nothing to clamp.
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const seed = path.join(CACHE_DIR, `cache_${REQUESTED_START}_${END}.json`);
  fs.writeFileSync(seed, JSON.stringify(batterPitches(END)));

  axios.get = async () => { throw new Error('must not fetch: the range is cached'); };

  await withServer(async port => {
    const res = await get(port, RANGE_PATH);
    assert.strictEqual(res.status, 200, res.body);
    const meta = JSON.parse(res.body).metadata;

    assert.strictEqual(meta.startDate, REQUESTED_START);
    assert.strictEqual(meta.endDate, END);
    assert.strictEqual(meta.requestedStartDate, undefined);
    assert.strictEqual(meta.partial, undefined);
    assert.strictEqual(meta.notice, undefined);
  });
});

test('a range inside the budget is untouched', async () => {
  axios.get = async () => ({ data: { success: true, data: batterPitches(END) } });
  const start = isoOffset(-2 - 30);

  await withServer(async port => {
    const res = await get(port, `/api/teams/range?startDate=${start}&endDate=${END}`);
    assert.strictEqual(res.status, 200, res.body);
    const meta = JSON.parse(res.body).metadata;
    assert.strictEqual(meta.startDate, start);
    assert.strictEqual(meta.notice, undefined);
    assert.strictEqual(meta.partial, undefined);
  });
});

test('an unreachable feed on the range path is a 503, not "no data for this range"', async () => {
  axios.get = async () => {
    const err = new Error('Bad Request');
    err.response = { status: 400 };
    throw err;
  };

  // Not RANGE_PATH: the wire memo (keyed on the served range) already holds the
  // clamp test's result for it, and a memo hit never touches the feed.
  const failPath = `/api/teams/range?startDate=${isoOffset(-9)}&endDate=${END}&maxVelocity=105&pitchGroup=All`;

  await withServer(async port => {
    const res = await get(port, failPath);
    assert.strictEqual(res.status, 503, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'upstream_error');
    assert.ok(!/no pitch data found/i.test(body.message), body.message);
  });
});
