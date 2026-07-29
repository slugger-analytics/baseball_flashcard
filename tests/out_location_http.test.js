'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-out-location';
const CACHE_DIR = '/tmp/cache';

const app = require('../server.js');

const START = '2026-06-01';
const END = '2026-06-02';

function seedFile(batterId) {
  return path.join(CACHE_DIR, `cache_batter_${batterId}_${START}_${END}.json`);
}

// One 2-pitch plate appearance ending in a Slider strikeout in the RHB Low-Out band
// (plate_loc_side < -0.33 outside, plate_loc_height < 2.0 low). Distinct inning per
// PA so the plate appearances never merge.
function strikeoutPA(batterId, inning) {
  const base = {
    date: START, rel_speed: 85, batter_id: batterId, batter_team_code: 'YOR',
    pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
    top_or_bottom: 'Top', inning, pa_of_inning: 1,
    plate_loc_side: -0.6, plate_loc_height: 1.5,
  };
  return [
    { ...base, balls: 0, strikes: 0, auto_pitch_type: 'Four-Seam', pitch_call: 'StrikeCalled' },
    { ...base, balls: 0, strikes: 1, auto_pitch_type: 'Slider', pitch_call: 'StrikeSwinging', k_or_bb: 'Strikeout' },
  ];
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

async function cardFor(batterId) {
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await get(port, `/api/batter/card?batterIds=${batterId}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 200, res.body);
    const data = JSON.parse(res.body);
    return Object.values(data.teamsData).flat()[0];
  } finally {
    server.close();
  }
}

test('powerSequenceLocation surfaces the modal finish zone at >= 5 finishes', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const id = 'outloc-test-0001';
  const pitches = [];
  for (let i = 1; i <= 5; i++) pitches.push(...strikeoutPA(id, i));
  fs.writeFileSync(seedFile(id), JSON.stringify(pitches));
  try {
    const batter = await cardFor(id);
    assert.deepStrictEqual(batter.powerSequenceLocation, { zone: 'Low-Out', count: 5, total: 5 });
  } finally {
    try { fs.unlinkSync(seedFile(id)); } catch (_) { /* best effort */ }
  }
});

test('powerSequenceLocation is null when there are too few finishes', async () => {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const id = 'outloc-test-0002';
  const pitches = [];
  for (let i = 1; i <= 4; i++) pitches.push(...strikeoutPA(id, i)); // only 4 finishes
  fs.writeFileSync(seedFile(id), JSON.stringify(pitches));
  try {
    const batter = await cardFor(id);
    assert.strictEqual(batter.powerSequenceLocation, null);
  } finally {
    try { fs.unlinkSync(seedFile(id)); } catch (_) { /* best effort */ }
  }
});
