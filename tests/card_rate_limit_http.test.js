'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.CARD_RATE_LIMIT_MAX = '2';
const app = require('../server.js');

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('card endpoint is rate limited without applying the limit to health checks', async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;
  try {
    assert.strictEqual(await get(port, '/health'), 200);
    assert.strictEqual(await get(port, '/api/batter/card?batterIds=bad%20id'), 400);
    assert.strictEqual(await get(port, '/api/batter/card?batterIds=bad%20id'), 400);
    assert.strictEqual(await get(port, '/api/batter/card?batterIds=bad%20id'), 429);
    assert.strictEqual(await get(port, '/health'), 200);
  } finally {
    server.close();
  }
});