'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { seasonRange, rangeForPreset, formatRange } = require('../public/js/pitch_logic.js');
const { parseDateInput, resolveDateRange, MAX_DATE_RANGE_DAYS } = require('../lib/dates.js');

test('server date parser accepts supported formats and rejects invalid calendar dates', () => {
  assert.strictEqual(parseDateInput('2026-05-01'), '2026-05-01');
  assert.strictEqual(parseDateInput('20260501'), '2026-05-01');
  assert.strictEqual(parseDateInput('05-01-2026'), '2026-05-01');
  assert.strictEqual(parseDateInput('2026-02-30'), null);
  assert.strictEqual(parseDateInput('not-a-date'), null);
});

test('server range validation keeps omitted defaults and enforces an inclusive maximum', () => {
  const defaults = resolveDateRange(undefined, undefined);
  assert.ok(defaults.finalStartDate);
  assert.ok(defaults.finalEndDate);
  assert.deepStrictEqual(resolveDateRange('2026-05-01', '2026-05-01'), {
    finalStartDate: '2026-05-01', finalEndDate: '2026-05-01'
  });
  assert.strictEqual(resolveDateRange('2026-02-30', '2026-03-01').error, 'invalid_date');
  assert.strictEqual(resolveDateRange('2025-01-01', '2026-01-06').error, 'range_too_large');
  assert.ok(!resolveDateRange('2025-01-01', new Date(Date.UTC(2025, 0, MAX_DATE_RANGE_DAYS - 1)).toISOString().slice(0, 10)).error);
  const farFuture = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  assert.strictEqual(resolveDateRange('2025-01-01', farFuture).error, 'future_date');
});

test('in season, the season runs from opening day through today', () => {
  assert.deepStrictEqual(seasonRange('2026-06-15'), { start: '2026-04-21', end: '2026-06-15', year: 2026 });
});

test('after the season, the season stops at its last day', () => {
  assert.deepStrictEqual(seasonRange('2026-10-07'), { start: '2026-04-21', end: '2026-09-13', year: 2026 });
});

test('before opening day, the season is the last completed one', () => {
  assert.deepStrictEqual(seasonRange('2026-03-01'), { start: '2025-04-25', end: '2025-09-18', year: 2025 });
});

test('"last 14 days" off-season means the last 14 days of games, not of the calendar', () => {
  assert.deepStrictEqual(rangeForPreset('14', null, '2026-10-07'), { start: '2026-08-31', end: '2026-09-13' });
});

test('"last 30 days" in season counts back from today', () => {
  assert.deepStrictEqual(rangeForPreset('30', null, '2026-07-30'), { start: '2026-07-01', end: '2026-07-30' });
});

test('a short window early in the season is clamped to opening day', () => {
  assert.deepStrictEqual(rangeForPreset('30', null, '2026-04-25'), { start: '2026-04-21', end: '2026-04-25' });
});

test('custom uses the dates given; without both it falls back to the season', () => {
  assert.deepStrictEqual(rangeForPreset('custom', { start: '2026-05-01', end: '2026-05-31' }, '2026-10-07'),
    { start: '2026-05-01', end: '2026-05-31' });
  assert.deepStrictEqual(rangeForPreset('custom', { start: '', end: '' }, '2026-10-07'),
    { start: '2026-04-21', end: '2026-09-13' });
});

test('unknown presets mean the season', () => {
  assert.deepStrictEqual(rangeForPreset('bogus', null, '2026-10-07'), { start: '2026-04-21', end: '2026-09-13' });
});

test('formatRange is short, and names the year only across years', () => {
  assert.strictEqual(formatRange({ start: '2026-04-21', end: '2026-09-13' }), 'Apr 21 – Sep 13');
  assert.strictEqual(formatRange({ start: '2026-05-02', end: '2026-05-02' }), 'May 2');
  assert.strictEqual(formatRange({ start: '2025-09-01', end: '2026-04-30' }), 'Sep 1, 2025 – Apr 30, 2026');
  assert.strictEqual(formatRange(null), '');
});
