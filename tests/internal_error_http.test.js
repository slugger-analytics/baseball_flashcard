'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcard-error-test-'));
process.env.CACHE_DIR = cacheDir;
const transform = require('../lib/transform.js');
const originalTransform = transform.transformPitchDataToTeams;
transform.transformPitchDataToTeams = () => { throw new Error('internal sentinel detail'); };
const app = require('../server.js');

const batterId = 'internal-error-test';
const startDate = '2026-05-20';
const endDate = '2026-05-21';
fs.writeFileSync(path.join(cacheDir, `cache_batter_${batterId}_${startDate}_${endDate}_v2.json`), '[{}]');

function get(port) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port,
      path: `/api/batter/card?batterIds=${batterId}&startDate=${startDate}&endDate=${endDate}`,
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test.after(() => {
  transform.transformPitchDataToTeams = originalTransform;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('unexpected card errors do not expose internal exception details', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  try {
    const res = await get(server.address().port);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(JSON.parse(res.body).error, 'card_failed');
    assert.ok(!res.body.includes('internal sentinel detail'));
  } finally {
    server.close();
  }
});