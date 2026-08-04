'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-league-baseline';
const CACHE_DIR = '/tmp/cache';

const axios = require('axios');
const realGet = axios.get;
const { poolLeagueFirstPitch } = require('../lib/stats.js');
const app = require('../server.js');

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

function clearLeagueFiles() {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith('league_fp_')) fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch (_) { /* dir may not exist */ }
}

// 10 swings / 6 taken / 1 HBP, all 0-0. Dated on opening day so it survives the
// handler's season-to-date window filter whenever this suite runs.
const OPENING_DAY = '2026-04-21';
function zeroZero(call, i) {
  return {
    date: OPENING_DAY, rel_speed: 90, batter_id: `lb-${i}`, batter_team_code: 'YOR',
    pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
    top_or_bottom: 'Top', inning: 1, pa_of_inning: i + 1,
    balls: 0, strikes: 0, auto_pitch_type: 'Four-Seam', pitch_call: call,
    plate_loc_side: 0.1, plate_loc_height: 2.4,
  };
}
const ZERO_ZERO_POOL = [
  ...Array.from({ length: 6 }, (_, i) => zeroZero('StrikeSwinging', i)),
  ...Array.from({ length: 4 }, (_, i) => zeroZero('InPlay', 10 + i)),
  ...Array.from({ length: 6 }, (_, i) => zeroZero('BallCalled', 20 + i)),
  zeroZero('HitByPitch', 30),
];

// Every test below models a COLD container: no disk record and no in-memory memo.
test.beforeEach(() => { clearLeagueFiles(); app.__resetLeagueFirstPitch(); });
test.afterEach(() => { axios.get = realGet; clearLeagueFiles(); });

test('the baseline is fetched with balls=0&strikes=0, not the whole pitch space', async () => {
  const seenParams = [];
  axios.get = async (url, config) => {
    seenParams.push({ url, params: config.params });
    return { data: { success: true, data: ZERO_ZERO_POOL } };
  };

  await withServer(async port => {
    const res = await get(port, '/api/league-baseline');
    assert.strictEqual(res.status, 200, res.body);
    const body = JSON.parse(res.body);

    // Every upstream page must carry the 0-0 filter. This is what turns a ~151k-record
    // season scan into a ~34k-record one and keeps the call inside the Lambda budget.
    assert.ok(seenParams.length > 0, 'no upstream call was made');
    for (const { url, params } of seenParams) {
      assert.ok(url.endsWith('/pitches'), url);
      assert.strictEqual(params.balls, 0);
      assert.strictEqual(params.strikes, 0);
    }

    assert.strictEqual(body.metric, poolLeagueFirstPitch(ZERO_ZERO_POOL).metric);
    assert.strictEqual(body.refreshed, true);
    assert.strictEqual(body.start, OPENING_DAY);
  });
});

test('a fresh baseline is reused rather than refetched', async () => {
  let calls = 0;
  axios.get = async () => {
    calls++;
    return { data: { success: true, data: ZERO_ZERO_POOL } };
  };

  await withServer(async port => {
    const first = JSON.parse((await get(port, '/api/league-baseline')).body);
    assert.strictEqual(first.refreshed, true);
    const after = calls;

    const second = JSON.parse((await get(port, '/api/league-baseline')).body);
    assert.strictEqual(second.refreshed, false);
    assert.strictEqual(second.metric, first.metric);
    assert.strictEqual(calls, after, 'a fresh memo must not trigger a second fetch');
  });
});

test('concurrent callers share one in-flight fetch', async () => {
  let calls = 0;
  axios.get = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 120));
    return { data: { success: true, data: ZERO_ZERO_POOL } };
  };

  await withServer(async port => {
    const [a, b] = await Promise.all([
      get(port, '/api/league-baseline'),
      get(port, '/api/league-baseline'),
    ]);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    const solo = calls;
    // One fetch is one page-batch. Two independent fetches would double it.
    assert.ok(solo > 0 && solo <= 8,
      `expected a single shared page-batch (<= 8 calls), saw ${solo}`);
  });
});

test('an upstream failure during refresh is a 503, not a silent null metric', async () => {
  axios.get = async () => {
    const err = new Error('Bad Request');
    err.response = { status: 400 };
    throw err;
  };

  await withServer(async port => {
    const res = await get(port, '/api/league-baseline');
    assert.strictEqual(res.status, 503, res.body);
    assert.strictEqual(JSON.parse(res.body).error, 'upstream_error');
  });
});

test('pooling a pre-filtered 0-0 array equals pooling the mixed season', () => {
  // This equivalence is the whole justification for the cheap upstream fetch:
  // poolLeagueFirstPitch re-filters with isZeroZeroPitch, so handing it only 0-0
  // records is not an approximation of the season pool — it is the same number.
  const noise = [
    { ...zeroZero('StrikeCalled', 90), balls: 1, strikes: 2 },
    { ...zeroZero('InPlay', 91), balls: 3, strikes: 0 },
    { ...zeroZero('BallCalled', 92), balls: 0, strikes: 2 },
  ];
  const mixed = [...ZERO_ZERO_POOL, ...noise];
  assert.strictEqual(poolLeagueFirstPitch(ZERO_ZERO_POOL).metric, poolLeagueFirstPitch(mixed).metric);
  assert.deepStrictEqual(poolLeagueFirstPitch(ZERO_ZERO_POOL).tally, poolLeagueFirstPitch(mixed).tally);
});
