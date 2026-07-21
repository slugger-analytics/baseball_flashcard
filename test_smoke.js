/**
 * CI smoke test — boots the Express app WITHOUT any secrets and asserts the
 * core surfaces respond. Run via `npm test` (locally or in GitHub Actions).
 *
 * Requiring server.js registers all routes but does NOT listen or populate the
 * upstream lookup caches (that only happens under `require.main === module`),
 * so this test needs no SLUGGER_API_KEY and makes no network calls beyond
 * localhost. Every assertion below holds with or without credentials present —
 * it proves the server boots, serves the static bundle, and API routes answer
 * gracefully (not crash) when unconfigured.
 */
const http = require('http');
const assert = require('assert');
const path = require('path');

// The static middleware serves from the process cwd — pin it to the app dir so
// the test passes regardless of where npm/node was invoked from.
process.chdir(__dirname);

const app = require('./server.js');

function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout on ${reqPath}`)));
    req.on('error', reject);
  });
}

async function main() {
  const server = app.listen(0);
  await new Promise(resolve => server.on('listening', resolve));
  const port = server.address().port;
  const failures = [];

  async function check(name, fn) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.error(`  FAIL ${name}: ${err.message}`);
    }
  }

  console.log(`Smoke testing on 127.0.0.1:${port} (SLUGGER_API_KEY ${process.env.SLUGGER_API_KEY ? 'present' : 'absent'})`);

  await check('static index.html served', async () => {
    const res = await get(port, '/');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(res.body.includes('SLUGGER Batter Flashcard Widget'), 'index.html title missing from body');
    assert.ok(res.body.includes('app.js'), 'index.html does not reference app.js bundle');
  });

  await check('GET /health responds', async () => {
    const res = await get(port, '/health');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert.strictEqual(JSON.parse(res.body).status, 'healthy');
  });

  await check('GET /api/health responds', async () => {
    const res = await get(port, '/api/health');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    JSON.parse(res.body); // must be valid JSON
  });

  await check('GET /api/cache-status responds without creds', async () => {
    const res = await get(port, '/api/cache-status');
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const json = JSON.parse(res.body);
    assert.ok(typeof json.players === 'number', 'players count missing');
  });

  await check('GET /api/batter/card without a batter is a graceful 400', async () => {
    const res = await get(port, '/api/batter/card');
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    const json = JSON.parse(res.body);
    assert.strictEqual(json.error, 'missing_batter');
  });

  await check('GET /api/batter/card rejects a future window without fetching', async () => {
    const res = await get(port, '/api/batter/card?batterIds=00000000-0000-0000-0000-000000000000&startDate=2099-01-01&endDate=2099-01-02');
    assert.strictEqual(res.status, 404, `expected 404, got ${res.status}`);
    assert.strictEqual(JSON.parse(res.body).error, 'future_date');
  });

  server.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} smoke check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed');
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
