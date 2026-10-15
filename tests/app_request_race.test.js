'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');

test('a pending card response cannot overwrite a newly selected cached batter', async () => {
  let resolveFetch;
  const context = {
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
    formatRange: () => 'May 1 – May 2',
    console,
  };
  vm.runInNewContext(`${source}\nthis.FlashcardApp = FlashcardApp;`, context);
  const app = Object.create(context.FlashcardApp.prototype);
  const batterA = { name: 'Batter A', ids: ['a'] };
  const batterB = { name: 'Batter B', ids: ['b'] };
  const applied = [];
  app.selectedBatterInfo = batterA;
  app.cardRequest = 0;
  app.prefetchCache = new Map([['b', { teamsData: { cached: true }, label: 'B' }]]);
  app.lastMaxVelocity = 105;
  app.lastPitchGroup = 'All';
  app.status = 'idle';
  app.resetBatterScopedSettings = () => {};
  app.batterCacheKey = batter => batter.ids[0];
  app.currentRange = () => ({ start: '2026-05-01', end: '2026-05-02' });
  app.render = () => {};
  app.applyCardData = data => { applied.push(data.label || 'cached'); return true; };

  const pendingLoad = app.loadBatterCard();
  app.selectBatter(batterB);
  resolveFetch({ ok: true, json: async () => ({ teamsData: { stale: true }, label: 'A' }) });
  await pendingLoad;

  assert.strictEqual(app.selectedBatterInfo, batterB);
  assert.deepStrictEqual(applied, ['B']);
});