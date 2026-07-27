'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { SWUNG_CALLS, TAKEN_CALLS, HIT_BY_PITCH_CALL, isZeroZeroPitch } = require('../lib/stats.js');

test('pitch-call vocabulary sets are as confirmed against the feed', () => {
  assert.deepStrictEqual(
    SWUNG_CALLS,
    ['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay']
  );
  assert.deepStrictEqual(TAKEN_CALLS, ['StrikeCalled', 'BallCalled']);
  assert.strictEqual(HIT_BY_PITCH_CALL, 'HitByPitch');
});

test('isZeroZeroPitch reads the pre-pitch count fields', () => {
  assert.strictEqual(isZeroZeroPitch({ balls: 0, strikes: 0 }), true);
  assert.strictEqual(isZeroZeroPitch({ balls: '0', strikes: '0' }), true);
  assert.strictEqual(isZeroZeroPitch({ balls: 1, strikes: 0 }), false);
  assert.strictEqual(isZeroZeroPitch({ balls: 0, strikes: 2 }), false);
});
