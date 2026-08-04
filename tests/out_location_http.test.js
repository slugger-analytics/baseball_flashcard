'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

process.env.AWS_LAMBDA_FUNCTION_NAME = 'unit-test-out-loc';
const CACHE_DIR = '/tmp/cache';

const app = require('../server.js');

const START = '2026-05-10';
const END = '2026-05-11';

// RHB coordinates, verified against getZoneFromLocation's strike zone.
const LOC = {
  lowOut: [-0.60, 1.80],
  chaseLowOut: [-1.20, 1.20],
  highIn: [0.60, 3.20],
  midMid: [0.00, 2.50],
  lowIn: [0.60, 1.80],
  none: [null, null],
};

/**
 * One two-pitch plate appearance per entry of `finishes`: a called 4S strike
 * followed by a slider that ends the at-bat at the given location. Each PA gets
 * its own inning because the plate-appearance key is `inning_pa_of_inning`.
 */
function buildPitches(batterId, finishes, finishFields) {
  const pitches = [];
  finishes.forEach((locKey, i) => {
    const base = {
      date: START, rel_speed: 88, batter_id: batterId, batter_team_code: 'YOR',
      pitcher_id: 'p1', batter_side: 'Right', pitcher_throws: 'Right',
      top_or_bottom: 'Top', inning: i + 1, pa_of_inning: 1,
    };
    pitches.push({
      ...base, balls: 0, strikes: 0, auto_pitch_type: 'Four-Seam',
      pitch_call: 'StrikeCalled', plate_loc_side: 0.0, plate_loc_height: 2.5,
    });
    const finish = {
      ...base, balls: 0, strikes: 1, auto_pitch_type: 'Slider', ...finishFields,
    };
    // 'omitted' leaves the coordinate keys off the record entirely (undefined),
    // which is a different case from an explicit null.
    if (locKey !== 'omitted') {
      finish.plate_loc_side = LOC[locKey][0];
      finish.plate_loc_height = LOC[locKey][1];
    }
    pitches.push(finish);
  });
  return pitches;
}

const K_FINISH = { pitch_call: 'StrikeSwinging', k_or_bb: 'Strikeout' };
const INPLAY_FINISH = { pitch_call: 'InPlay', play_result: 'Out', exit_speed: 72 };

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

async function loadCard(batterId, pitches, assertions) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const seed = path.join(CACHE_DIR, `cache_batter_${batterId}_${START}_${END}.json`);
  fs.writeFileSync(seed, JSON.stringify(pitches));
  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  try {
    const res = await get(server.address().port, `/api/batter/card?batterIds=${batterId}&startDate=${START}&endDate=${END}`);
    assert.strictEqual(res.status, 200, res.body);
    await assertions(Object.values(JSON.parse(res.body).teamsData).flat()[0], res);
  } finally {
    server.close();
    try { fs.unlinkSync(seed); } catch (_) { /* best effort */ }
  }
}

// 4 in-zone Low-Out + 2 chase Low-Out + 3 High-In + 3 Mid-Mid + 3 Low-In, and one
// PA with null coordinates that must not reach the denominator.
const DOMINANT_FINISHES = [
  'lowOut', 'lowOut', 'lowOut', 'lowOut', 'chaseLowOut', 'chaseLowOut',
  'highIn', 'highIn', 'highIn', 'midMid', 'midMid', 'midMid',
  'lowIn', 'lowIn', 'lowIn', 'none',
];

test('finishLocation survives the wire on the strikeout-without-play_result path', async () => {
  await loadCard('ol-test-0001', buildPitches('ol-test-0001', DOMINANT_FINISHES, K_FINISH), batter => {
    assert.deepStrictEqual(batter.powerSequenceBreakdown.finishLocation,
      { pitch: 'SL', band: 'Low-Out', count: 6, total: 15, chase: 2, dominant: true });
  });
});

test('the existing out-sequence output is unchanged', async () => {
  await loadCard('ol-test-0002', buildPitches('ol-test-0002', DOMINANT_FINISHES, K_FINISH), batter => {
    assert.strictEqual(batter.powerSequence, '4S → SL (16/16 = 100%)');
    assert.strictEqual(batter.powerSequenceBreakdown.kSwinging, 16);
    assert.strictEqual(batter.powerSequenceBreakdown.kLooking, 0);
    assert.strictEqual(batter.powerSequenceBreakdown.contactOut, 0);
  });
});

test('enough sample without a dominant band still ships finishLocation', async () => {
  const finishes = [
    'lowOut', 'lowOut', 'lowOut', 'lowOut', 'lowOut',
    'highIn', 'highIn', 'highIn', 'highIn',
    'midMid', 'midMid', 'midMid', 'lowIn', 'lowIn', 'lowIn',
  ];
  await loadCard('ol-test-0003', buildPitches('ol-test-0003', finishes, K_FINISH), batter => {
    const loc = batter.powerSequenceBreakdown.finishLocation;
    assert.strictEqual(loc.dominant, false);
    assert.strictEqual(loc.count, 5);
    assert.strictEqual(loc.total, 15);
  });
});

test('below the sample gate the key is omitted, not null', async () => {
  const finishes = Array.from({ length: 14 }, () => 'lowOut');
  await loadCard('ol-test-0004', buildPitches('ol-test-0004', finishes, K_FINISH), batter => {
    assert.strictEqual(batter.powerSequenceBreakdown.finishLocation, undefined);
    assert.strictEqual(batter.powerSequence, '4S → SL (14/14 = 100%)');
    assert.strictEqual(batter.powerSequenceBreakdown.kSwinging, 14);
  });
});

test('the play_result out path is located too', async () => {
  const finishes = [...Array.from({ length: 15 }, () => 'lowOut'), 'none'];
  await loadCard('ol-test-0005', buildPitches('ol-test-0005', finishes, INPLAY_FINISH), batter => {
    const loc = batter.powerSequenceBreakdown.finishLocation;
    assert.strictEqual(loc.pitch, 'SL');
    assert.strictEqual(loc.band, 'Low-Out');
    assert.strictEqual(loc.total, 15);
    assert.strictEqual(loc.dominant, true);
    assert.strictEqual(batter.powerSequenceBreakdown.contactOut, 16);
  });
});

test('missing (not null) plate coordinates never fabricate a location', async () => {
  const finishes = Array.from({ length: 16 }, () => 'omitted');
  await loadCard('ol-test-0006', buildPitches('ol-test-0006', finishes, INPLAY_FINISH), batter => {
    assert.strictEqual(batter.powerSequenceBreakdown.finishLocation, undefined);
    assert.strictEqual(batter.powerSequence, '4S → SL (16/16 = 100%)');
  });
});
