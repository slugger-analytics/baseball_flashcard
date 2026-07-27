'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

// Required as a module (not main), so server.js exposes the __lookupCache seam
// and does NOT listen or hit the network on load.
const app = require('../server.js');

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

test('/api/batters merges case-duplicate players into one entry', async () => {
  const cache = app.__lookupCache;
  assert.ok(cache, 'test seam __lookupCache missing');
  // Seeding players keeps size > 0 so battersHandler never calls the network.
  cache.players.set('A', { player_id: 'A', player_name: 'Bates, Austin', is_hitter: true, player_batting_handedness: 'Right', team_name: 'York Revolution' });
  cache.players.set('B', { player_id: 'B', player_name: 'bates, austin', is_hitter: true, player_batting_handedness: 'Switch' });

  const server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  const port = server.address().port;
  try {
    const res = await get(port, '/api/batters');
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    const bates = data.batters.filter(b => b.name.toLowerCase() === 'bates, austin');
    assert.strictEqual(bates.length, 1, 'expected exactly one Bates entry');
    assert.strictEqual(bates[0].name, 'Bates, Austin');
    assert.deepStrictEqual([...bates[0].ids].sort(), ['A', 'B']);
    assert.strictEqual(bates[0].bats, 'Switch');
  } finally {
    server.close();
  }
});
