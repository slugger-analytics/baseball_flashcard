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

/**
 * Classifies a single 0-0 pitch call into 'swung' | 'taken' | 'hbp' | 'other'.
 * 'other' is any call outside SWUNG ∪ TAKEN ∪ {HitByPitch} (e.g. BallinDirt,
 * Undefined) — these do not count toward the PA′ denominator.
 */
function classifyZeroZeroCall(call) {
  if (SWUNG_CALLS.includes(call)) return 'swung';
  if (TAKEN_CALLS.includes(call)) return 'taken';
  if (call === HIT_BY_PITCH_CALL) return 'hbp';
  return 'other';
}

/**
 * Tallies a batter's (or a pool's) 0-0 pitches by decision.
 * @param {Array<Object>} pitches - pitch records with balls/strikes/pitch_call.
 * @returns {{zeroZero:number, swung:number, taken:number, hbp:number, other:number}}
 */
function firstPitchTally(pitches) {
  const tally = { zeroZero: 0, swung: 0, taken: 0, hbp: 0, other: 0 };
  for (const pitch of pitches) {
    if (!isZeroZeroPitch(pitch)) continue;
    tally.zeroZero++;
    tally[classifyZeroZeroCall(pitch.pitch_call)]++;
  }
  return tally;
}

/**
 * First-pitch approach metric = numerator / PA′, where
 *   PA′       = zeroZero − HitByPitch − Other = swung + taken
 *   numerator = PA′ − StrikeCalled − BallCalled = swung
 * @param {Object} tally - a firstPitchTally result.
 * @returns {number|null} metric in [0,1], or null when PA′ = 0.
 */
function firstPitchMetric(tally) {
  const paPrime = tally.swung + tally.taken;
  if (paPrime <= 0) return null;
  return tally.swung / paPrime;
}

/**
 * League-relative classification. Aggressive at ≥ leagueAvg×1.25 (inclusive),
 * Patient at ≤ leagueAvg×0.75 (inclusive), else Neutral. Returns 'Neutral' when
 * the metric or a usable league average is missing (league-avg-pending state).
 */
function firstPitchLabel(metric, leagueAvg) {
  if (metric == null || leagueAvg == null || leagueAvg <= 0) return 'Neutral';
  if (metric >= leagueAvg * 1.25) return 'Aggressive';
  if (metric <= leagueAvg * 0.75) return 'Patient';
  return 'Neutral';
}

/**
 * Pools 0-0 pitches league-wide (all pitches aggregated, NOT a mean of per-batter
 * metrics) and returns the pooled metric plus its tally.
 * @param {Array<Object>} pitches - every league pitch in the window.
 * @returns {{metric:number|null, tally:Object}}
 */
function poolLeagueFirstPitch(pitches) {
  const tally = firstPitchTally(pitches);
  return { metric: firstPitchMetric(tally), tally };
}

module.exports = {
  SWUNG_CALLS,
  TAKEN_CALLS,
  HIT_BY_PITCH_CALL,
  isZeroZeroPitch,
  classifyZeroZeroCall,
  firstPitchTally,
  firstPitchMetric,
  firstPitchLabel,
  poolLeagueFirstPitch,
};
