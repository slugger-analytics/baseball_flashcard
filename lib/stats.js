/**
 * lib/stats.js — server-side pitch statistics helpers kept in a small module so
 * the pure logic can be unit-tested under node:test without booting Express.
 *
 * Home of the first-pitch approach metric. The pitch-call vocabulary below is
 * confirmed against the SLUGGER feed and the on-disk pitch caches.
 */

// A swing is any of these pitch calls; a take is a called ball or strike.
const SWUNG_CALLS = ['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'];
const TAKEN_CALLS = ['StrikeCalled', 'BallCalled'];
const HIT_BY_PITCH_CALL = 'HitByPitch';

/**
 * True when a pitch was thrown on a 0-0 count. Uses the pre-pitch count fields
 * (balls/strikes), which are reliable per-pitch and route around the cross-game
 * plate-appearance key collision in the transform's pitch loop.
 * @param {Object} pitch - A pitch record with numeric `balls`/`strikes`.
 * @returns {boolean}
 */
function isZeroZeroPitch(pitch) {
  return Number(pitch.balls) === 0 && Number(pitch.strikes) === 0;
}

module.exports = {
  SWUNG_CALLS,
  TAKEN_CALLS,
  HIT_BY_PITCH_CALL,
  isZeroZeroPitch,
};
