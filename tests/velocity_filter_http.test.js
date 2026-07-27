'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Force the Lambda cache dir (/tmp/cache) BEFORE requiring server.js, so we can
// seed a per-batter disk cache and avoid the repo's cache/ directory + the network.
process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-velocity';
const CACHE_DIR = '/tmp/cache';

const app = require('../server.js');

const BATTER_ID = 'velo-test-0001';
const START = '2026-05-01';
const END = '2026-05-02';
const SEED_FILE = path.join(CACHE_DIR, `cache_batter_${BATTER_ID}_${START}_${END}.json`);

function mkPitch(relSpeed) {
  return {
    date: START, rel_speed: relSpeed, batter_id: BATTER_ID, batter_team_code: 'YOR',
    pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
    top_or_bottom: 'Top', inning: 1, balls: 0, strikes: 0, pa_of_inning: 1,
    auto_pitch_type: 'Slider', pitch_call: 'BallCalled',
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

test('/api/batter/card?maxVelocity=80 drops pitches faster than 80mph from pz', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify([mkPitch(95), mkPitch(75)])); // one over, one under

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER_ID}&startDate=${START}&endDate=${END}&maxVelocity=80`);
    assert.strictEqual(res.status, 200, res.body);
    const data = JSON.parse(res.body);
    const batters = Object.values(data.teamsData).flat();
    assert.strictEqual(batters.length, 1);
    // Only the 75mph pitch survives → exactly one pitchZone column entry.
    assert.strictEqual(batters[0].pz.x.length, 1);
  } finally {
    server.close();
    try { fs.unlinkSync(SEED_FILE); } catch (_) { /* best effort */ }
  }
});
