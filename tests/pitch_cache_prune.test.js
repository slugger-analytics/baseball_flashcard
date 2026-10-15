'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashcard-cache-prune-'));
process.env.CACHE_DIR = cacheDir;
const { pruneExpiredBatterCaches } = require('../lib/pitch_cache.js');

test.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));

test('pruning deletes only expired completed per-batter cache files', () => {
  const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const files = [
    'cache_batter_abc-123_2026-05-01_2026-05-02_v2.json',
    'cache_batter_fresh_2026-05-01_2026-05-02_v2.json',
    'cache_batter_tmp_2026-05-01_2026-05-02_v2.json.tmp',
    'cache_2026-05-01_2026-05-02_v2.json',
    'cache_batter_other_2026-05-01_2026-05-02_v3.json',
  ];
  for (const filename of files) fs.writeFileSync(path.join(cacheDir, filename), '[]');
  fs.utimesSync(path.join(cacheDir, files[0]), oldTime, oldTime);
  fs.utimesSync(path.join(cacheDir, files[2]), oldTime, oldTime);
  fs.utimesSync(path.join(cacheDir, files[3]), oldTime, oldTime);

  assert.strictEqual(pruneExpiredBatterCaches(), 1);
  assert.strictEqual(fs.existsSync(path.join(cacheDir, files[0])), false);
  for (const filename of files.slice(1)) assert.strictEqual(fs.existsSync(path.join(cacheDir, filename)), true);
});