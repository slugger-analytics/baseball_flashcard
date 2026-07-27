'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-first-pitch';
const CACHE_DIR = '/tmp/cache';

const app = require('../server.js');

const BATTER_ID = 'fp-test-0001';
const START = '2026-05-10';
const END = '2026-05-11';
const SEED_FILE = path.join(CACHE_DIR, `cache_batter_${BATTER_ID}_${START}_${END}.json`);

function mkPitch(pitch_call, balls, strikes) {
  return {
    date: START, rel_speed: 88, batter_id: BATTER_ID, batter_team_code: 'YOR',
    pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
    top_or_bottom: 'Top', inning: 1, balls, strikes, pa_of_inning: 1,
    auto_pitch_type: 'Slider', pitch_call,
    plate_loc_side: 0.0, plate_loc_height: 2.5,
  };
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('tendencies.firstStrike keeps the "Label (NN%)" shape', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Three 0-0 pitches (2 swings, 1 take) + a non-0-0 pitch that must be ignored.
  fs.writeFileSync(SEED_FILE, JSON.stringify([
    mkPitch('InPlay', 0, 0),
    mkPitch('StrikeSwinging', 0, 0),
    mkPitch('BallCalled', 0, 0),
    mkPitch('StrikeCalled', 1, 2),
  ]));

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER_ID}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 200, res.body);
    const data = JSON.parse(res.body);
    const batter = Object.values(data.teamsData).flat()[0];
    const fs2 = batter.tendencies.firstStrike;
    assert.match(fs2, /^(Aggressive|Patient|Neutral) \(\d+%\)$/, `unexpected firstStrike: ${fs2}`);
    // 2 swings / 3 PA′ = 67%; cold container (no league) → Neutral + pending.
    assert.ok(fs2.includes('(67%)'), `expected 67%, got ${fs2}`);
    assert.strictEqual(batter.tendencies.firstStrikePending, true);
  } finally {
    server.close();
    try { fs.unlinkSync(SEED_FILE); } catch (_) { /* best effort */ }
  }
});
