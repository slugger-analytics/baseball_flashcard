'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { planRangeChunks } = require('../pitch_logic.js');

const dayAfter = iso => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const daysIn = c =>
  (new Date(`${c.end}T00:00:00Z`) - new Date(`${c.start}T00:00:00Z`)) / 86400000 + 1;

test('a span shorter than one window is a single chunk', () => {
  assert.deepStrictEqual(planRangeChunks('2026-04-21', '2026-04-25', 30), [
    { start: '2026-04-21', end: '2026-04-25' },
  ]);
});

test('a single-day range is a single one-day chunk', () => {
  assert.deepStrictEqual(planRangeChunks('2026-04-21', '2026-04-21', 30), [
    { start: '2026-04-21', end: '2026-04-21' },
  ]);
});

test('windows tile a season-scale range: no gaps, no overlaps, none over budget', () => {
  const chunks = planRangeChunks('2026-04-21', '2026-08-11', 30);

  assert.strictEqual(chunks[0].start, '2026-04-21');
  assert.strictEqual(chunks[chunks.length - 1].end, '2026-08-11');
  for (let i = 1; i < chunks.length; i++) {
    // Adjacency is what the server's cache-chain assembly requires: each window
    // must start the exact day after the previous one ends.
    assert.strictEqual(chunks[i].start, dayAfter(chunks[i - 1].end));
  }
  for (const c of chunks) {
    assert.ok(c.start <= c.end, `${c.start} > ${c.end}`);
    assert.ok(daysIn(c) <= 30, `window ${c.start}..${c.end} exceeds 30 days`);
  }
});

test('every window except the last keeps stable dates as the end advances', () => {
  // Stable dates are what keep the server-side cache files warm day over day —
  // only the window containing "today" should ever change key.
  const a = planRangeChunks('2026-04-21', '2026-08-11', 30);
  const b = planRangeChunks('2026-04-21', '2026-08-12', 30);
  for (let i = 0; i < a.length - 1; i++) {
    assert.deepStrictEqual(b[i], a[i]);
  }
});

test('a range that is an exact multiple of the window size has full windows only', () => {
  const chunks = planRangeChunks('2026-04-21', '2026-06-19', 30); // exactly 60 days
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(daysIn(chunks[0]), 30);
  assert.strictEqual(daysIn(chunks[1]), 30);
});
