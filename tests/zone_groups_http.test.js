'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Force the Lambda cache dir (/tmp/cache) BEFORE requiring server.js so we can seed
// a per-batter disk cache and stay off the network.
process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-zone-groups';
const CACHE_DIR = '/tmp/cache';

const app = require('../server.js');

const BATTER_ID = 'zg-test-0001';
const START = '2026-05-20';
const END = '2026-05-21';
const SEED_FILE = path.join(CACHE_DIR, `cache_batter_${BATTER_ID}_${START}_${END}.json`);

// RHB Low-Out band: plate_loc_side < -0.33 (outside), plate_loc_height < 2.0 (low).
function mkPitch(pitchType, pitchCall, playResult) {
  return {
    date: START, rel_speed: 88, batter_id: BATTER_ID, batter_team_code: 'YOR',
    pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
    top_or_bottom: 'Top', inning: 1, balls: 1, strikes: 1, pa_of_inning: 1,
    auto_pitch_type: pitchType, pitch_call: pitchCall, play_result: playResult,
    plate_loc_side: -0.6, plate_loc_height: 1.5,
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

test('zoneAnalysis Low-Out is annotated with the driving pitch group; groups never ship', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const pitches = [];
  // 8 Low-Out sliders, all swung on and missed → Breaking cell is the vulnerable group.
  for (let i = 0; i < 8; i++) pitches.push(mkPitch('Slider', 'StrikeSwinging', 'Undefined'));
  // 8 Low-Out four-seams, all put in play for hits → Fastballs cell is not vulnerable.
  for (let i = 0; i < 8; i++) pitches.push(mkPitch('Four-Seam', 'InPlay', 'Single'));
  fs.writeFileSync(SEED_FILE, JSON.stringify(pitches));

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await get(port, `/api/batter/card?batterIds=${BATTER_ID}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 200, res.body);
    const data = JSON.parse(res.body);
    const batter = Object.values(data.teamsData).flat()[0];
    const zone = batter.zoneAnalysis['Low-Out'];
    assert.ok(zone, 'expected a Low-Out zone in zoneAnalysis');
    assert.strictEqual(zone.vg, 'Breaking');
    assert.strictEqual(zone.vgN, 8);
    // The per-group accumulator is server-internal and must never reach the wire.
    assert.ok(!('groups' in zone), 'zone.groups must be deleted before shipping');
  } finally {
    server.close();
    try { fs.unlinkSync(SEED_FILE); } catch (_) { /* best effort */ }
  }
});
