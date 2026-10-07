'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-upstream';
const CACHE_DIR = '/tmp/cache';

// Replace axios.get before server.js resolves it. server.js holds the module object,
// not the function, so the stub is picked up at call time.
const axios = require('axios');
const realGet = axios.get;
const app = require('../server.js');

const START = '2026-05-20';
const END = '2026-05-21';
const BATTER = 'upstream-test-0001';

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

function clearBatterCache() {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.includes(BATTER)) fs.unlinkSync(path.join(CACHE_DIR, f));
    }
  } catch (_) { /* dir may not exist */ }
}

test.afterEach(() => { axios.get = realGet; clearBatterCache(); });

test('an unreachable feed is a 503, NOT "no data found for this batter"', async () => {
  // A 4xx is non-retryable, so this also proves the retry loop does not spin on
  // errors a retry cannot fix.
  axios.get = async () => {
    const err = new Error('Bad Request');
    err.response = { status: 400 };
    throw err;
  };

  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 503, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'upstream_error');
    // The old behaviour told a coach the batter had no data. That claim is unknowable
    // when the feed never answered, and it is the one thing this must never say.
    assert.ok(!/no pitch data found/i.test(body.message), body.message);
  });
});

test('a SUCCESSFUL fetch returning zero records is still 404 no_data', async () => {
  axios.get = async () => ({ data: { success: true, data: [] } });

  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 404, res.body);
    assert.strictEqual(JSON.parse(res.body).error, 'no_data');
  });
});

test('a retryable 5xx is retried, then reported as upstream_error', async () => {
  let calls = 0;
  axios.get = async () => {
    calls++;
    const err = new Error('Bad Gateway');
    err.response = { status: 502 };
    throw err;
  };

  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 503, res.body);
    assert.strictEqual(JSON.parse(res.body).error, 'upstream_error');
    // 3 attempts (initial + 2 retries) on at least the first page.
    assert.ok(calls >= 3, `expected >= 3 upstream attempts, saw ${calls}`);
  });
});

test('sluggerRequest passes an explicit timeout (an unbounded page can eat the whole budget)', async () => {
  let seenConfig = null;
  axios.get = async (url, config) => {
    seenConfig = config;
    return { data: { success: true, data: [] } };
  };

  await withServer(async port => {
    await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.ok(seenConfig, 'axios.get was never called');
    assert.strictEqual(typeof seenConfig.timeout, 'number');
    assert.ok(seenConfig.timeout > 0 && seenConfig.timeout < 29000,
      `timeout must be set and stay under the upstream 29s gateway limit, got ${seenConfig.timeout}`);
  });
});

// ── batter id handling ─────────────────────────────────────────────────────
// Three distinct answers, and the card must never blur them:
//   invalid_batter  — not an id at all; rejected locally, the feed is never called
//   unknown_batter  — a well-formed id the feed explicitly says it does not know
//   upstream_error  — the feed failed or rejected the request for another reason
// None of these may say "no pitch data found": that claim is reserved for a feed
// that actually answered with an empty list.

test('a malformed batter id is rejected locally without calling the feed', async () => {
  let calls = 0;
  axios.get = async () => { calls++; return { data: { success: true, data: [] } }; };
  await withServer(async port => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', "'%20OR%201%3D1--", 'a'.repeat(65), 'has%20space']) {
      const res = await get(port, `/api/batter/card?batterIds=${bad}&startDate=${START}&endDate=${END}`);
      assert.strictEqual(res.status, 400, `${bad}: ${res.body}`);
      assert.strictEqual(JSON.parse(res.body).error, 'invalid_batter');
    }
  });
  assert.strictEqual(calls, 0, 'the feed must not be called for a malformed id');
});

test('too many ids in one request is rejected', async () => {
  const many = Array.from({ length: 21 }, (_, i) => `id-${i}`).join(',');
  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${many}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 400, res.body);
    assert.strictEqual(JSON.parse(res.body).error, 'invalid_batter');
  });
});

test('an id the feed rejects as unknown is unknown_batter — not "feed down", not "no data"', async () => {
  // SLUGGER's real response to an id it does not recognise.
  axios.get = async () => {
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400, data: {
      success: false, message: 'Invalid request parameters',
      errors: '1 validation error for PitchQueryParams\nbatter_id\n  value is not a valid uuid',
    } };
    throw err;
  };
  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 404, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'unknown_batter');
    assert.ok(!/no pitch data found/i.test(body.message), body.message);
    assert.ok(!/couldn't reach/i.test(body.message), 'the feed DID answer');
  });
});

test('a 400 that does not name batter_id stays a 503 — it may be our own bug', async () => {
  // A malformed date or parameter built by our code also earns a 400. Reporting
  // that as "unknown batter" would blame the batter for a defect on our side.
  axios.get = async () => {
    const err = new Error('Request failed with status code 400');
    err.response = { status: 400, data: { success: false, errors: 'date_range_start\n  invalid date' } };
    throw err;
  };
  await withServer(async port => {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 503, res.body);
    assert.strictEqual(JSON.parse(res.body).error, 'upstream_error');
  });
});
