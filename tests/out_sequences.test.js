'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  analyzeOutSequences, MIN_OUTPITCH_FINISHES, OUTPITCH_MODAL_SHARE,
} = require('../lib/stats.js');

// out record shape: { shortSequence, outType, wasSwinging, pitchCount, zone }
function out(shortSequence, outType, wasSwinging, zone) {
  return { shortSequence, outType, wasSwinging, pitchCount: 2, zone: zone === undefined ? null : zone };
}

// ── Characterization: text + breakdown must match the pre-extraction behavior ──
test('analyzeOutSequences pins the top-sequence text with counts', () => {
  const r = analyzeOutSequences([
    out('4S → SL', 'K', true),
    out('4S → SL', 'K', true),
    out('CB → CH', 'Out', false),
  ]);
  assert.strictEqual(r.text, '4S → SL (2/3 = 67%)');
  assert.deepStrictEqual(r.breakdown, { kSwinging: 2, kLooking: 0, contactOut: 0 });
});

test('analyzeOutSequences appends a strong (>=25%) second pattern', () => {
  const r = analyzeOutSequences([
    out('4S → SL', 'K', true), out('4S → SL', 'K', true), out('4S → SL', 'K', true),
    out('CB → CH', 'Out', false), out('CB → CH', 'Out', false),
  ]);
  assert.strictEqual(r.text, '4S → SL (3/5 = 60%) • Also: CB → CH (2/5 = 40%)');
  assert.deepStrictEqual(r.breakdown, { kSwinging: 3, kLooking: 0, contactOut: 0 });
});

test('analyzeOutSequences falls back to the most common finishing pitch', () => {
  const r = analyzeOutSequences([
    out('4S → SL', 'K', true),
    out('CB → CH', 'Out', false),
    out('FB → SL', 'K', false),
    out('2S → CB', 'Out', false),
  ]);
  assert.strictEqual(r.text, 'SL gets outs (2/4)');
  // matching outs finish with SL: one K swinging, one K looking.
  assert.deepStrictEqual(r.breakdown, { kSwinging: 1, kLooking: 1, contactOut: 0 });
});

test('analyzeOutSequences returns Insufficient data for an empty list', () => {
  const r = analyzeOutSequences([]);
  assert.strictEqual(r.text, 'Insufficient data');
  assert.strictEqual(r.breakdown, null);
  assert.strictEqual(r.location, null);
});

// ── Constants ────────────────────────────────────────────────────────────────
test('out-pitch location constants are the documented values', () => {
  assert.strictEqual(MIN_OUTPITCH_FINISHES, 5);
  assert.strictEqual(OUTPITCH_MODAL_SHARE, 0.40);
});

// ── Finish-location extension ────────────────────────────────────────────────
test('fewer than 5 finishes → no location', () => {
  const outs = [];
  for (let i = 0; i < 4; i++) outs.push(out('4S → SL', 'K', true, 'Low-Out'));
  assert.strictEqual(analyzeOutSequences(outs).location, null);
});

test('5 finishes with a modal share of exactly 40% → location (boundary inclusive)', () => {
  const outs = [
    out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'High-In'),
    out('4S → SL', 'K', true, 'Mid-Mid'),
    out('4S → SL', 'K', true, 'Low-In'),
  ];
  assert.deepStrictEqual(analyzeOutSequences(outs).location, { zone: 'Low-Out', count: 2, total: 5 });
});

test('a modal share below 40% → no location', () => {
  // 8 finishes, modal zone 3 → 37.5% < 40%.
  const outs = [
    out('4S → SL', 'K', true, 'Low-Out'), out('4S → SL', 'K', true, 'Low-Out'), out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'High-In'), out('4S → SL', 'K', true, 'High-In'),
    out('4S → SL', 'K', true, 'Mid-Mid'), out('4S → SL', 'K', true, 'Mid-Mid'),
    out('4S → SL', 'K', true, 'Low-In'),
  ];
  assert.strictEqual(analyzeOutSequences(outs).location, null);
});

test('zone:null finishes are excluded from BOTH the pool and the denominator', () => {
  const outs = [
    out('4S → SL', 'K', true, 'Low-Out'), out('4S → SL', 'K', true, 'Low-Out'), out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'High-In'), out('4S → SL', 'K', true, 'Mid-Mid'),
    out('4S → SL', 'K', true, null), out('4S → SL', 'K', true, null), out('4S → SL', 'K', true, null),
  ];
  // Only the 5 located finishes count → total 5, modal Low-Out 3/5 = 60%.
  assert.deepStrictEqual(analyzeOutSequences(outs).location, { zone: 'Low-Out', count: 3, total: 5 });
});

test('the fallback branch also produces a location', () => {
  // 5 distinct singleton sequences (no significant pattern), all finishing SL.
  const outs = [
    out('4S → SL', 'K', true, 'Low-Out'),
    out('2S → SL', 'K', true, 'Low-Out'),
    out('CB → SL', 'K', false, 'Low-Out'),
    out('CH → SL', 'Out', false, 'High-In'),
    out('FC → SL', 'Out', false, 'Mid-Mid'),
  ];
  const r = analyzeOutSequences(outs);
  assert.strictEqual(r.text, 'SL gets outs (5/5)');
  assert.deepStrictEqual(r.location, { zone: 'Low-Out', count: 3, total: 5 });
});

test('a modal tie is broken deterministically by first appearance', () => {
  const outs = [
    out('4S → SL', 'K', true, 'High-In'),  // first-seen of the tie
    out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'High-In'),
    out('4S → SL', 'K', true, 'Low-Out'),
    out('4S → SL', 'K', true, 'Mid-Mid'),
  ];
  // High-In and Low-Out both appear twice (2/5 = 40%); High-In seen first wins.
  assert.deepStrictEqual(analyzeOutSequences(outs).location, { zone: 'High-In', count: 2, total: 5 });
});
