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

// Out-pitch finish location. Gate calibrated by replaying the season cache
// (107,458 pitches, 11,393 out sequences, 195 batter profiles) against a null
// model that redraws each profile's finish zones from the league-wide finish
// distribution at the same pool size: 15/6/0.35 fires on 7.7% of profiles vs
// 2.0% under the null, the best precision/coverage knee tested. Looser gates
// (10/4/0.30 → 16.9% vs 9.2%) and gates on the raw 17 zone labels rather than
// the 9 merged bands are mostly noise. Do not loosen without re-running that;
// the three numbers are also quoted in the client copy (app.js out-location
// caption and the Out Sequence info modal), so retune both together.
// Note FINISH_MIN_MODAL is redundant at the current sample floor: with
// FINISH_MIN_SAMPLE = 15, a 0.35 share already implies a count of 6 for every
// reachable total (0.35 * 15..17 = 5.25..5.95, and the share gate is strictly
// tighter above that). It only starts to bind if FINISH_MIN_SAMPLE drops to 14
// or below — so a future re-tune downward silently activates a gate that reads
// today as though it were already doing work.
const FINISH_MIN_SAMPLE = 15;
const FINISH_MIN_MODAL = 6;
const FINISH_MIN_SHARE = 0.35;
const OUT_SEQ_SEPARATOR = ' → '; // must match the joins in transformPitchDataToTeams
const CHASE_LABEL_PREFIX = 'Chase ';

/** Last token of a '4S → SL' sequence; a bare 'SL' returns itself. */
function finishingToken(shortSequence) {
  return String(shortSequence).split(OUT_SEQ_SEPARATOR).pop();
}

/**
 * Collapses getZoneFromLocation's 17 labels to the 9 physical bands by folding
 * 'Chase Low-Out' into 'Low-Out'. 30% of located finishes are chase pitches, so
 * splitting one physical spot across the zone edge halves every modal share and
 * no batter clears a usable sample.
 * @param {*} zone - a zone label, or anything else.
 * @returns {string|null} the band, or null when the label is unusable.
 */
function finishBand(zone) {
  if (typeof zone !== 'string' || zone === '') return null;
  return zone.startsWith(CHASE_LABEL_PREFIX) ? zone.slice(CHASE_LABEL_PREFIX.length) : zone;
}

/**
 * Modal band of the pitches that ENDED an at-bat on a given pitch type.
 * @param {Array<{shortSequence:string, zone:(string|null)}>} outSequences
 * @param {string|null} outPitchType - abbreviation of the pitch shown on the card.
 * @returns {{pitch:string, band:string, count:number, total:number, chase:number,
 *   dominant:boolean}|null} null below FINISH_MIN_SAMPLE located finishes.
 *   `dominant` false means enough sample but no one spot.
 */
function outPitchFinishLocation(outSequences, outPitchType) {
  if (!Array.isArray(outSequences) || !outPitchType) return null;
  const pool = outSequences.filter(o =>
    o && typeof o.shortSequence === 'string' &&
    finishingToken(o.shortSequence) === outPitchType &&
    finishBand(o.zone) !== null
  );
  if (pool.length < FINISH_MIN_SAMPLE) return null;

  const counts = new Map();
  const chases = new Map();
  pool.forEach(o => {
    const band = finishBand(o.zone);
    counts.set(band, (counts.get(band) || 0) + 1);
    if (o.zone.startsWith(CHASE_LABEL_PREFIX)) chases.set(band, (chases.get(band) || 0) + 1);
  });

  // Strict `>` keeps the first-seen band on a tie, which is fine for reporting the
  // modal band but must NOT be called dominant: two bands level at the top can be
  // opposite corners of the plate, and pool insertion order would decide which one
  // the coach is told to pitch to. A tie is "no dominant spot", by definition.
  let top = null;
  let tiedTops = 0;
  counts.forEach((count, band) => { if (!top || count > top.count) top = { band, count }; });
  counts.forEach(count => { if (count === top.count) tiedTops++; });
  return {
    pitch: outPitchType,
    band: top.band,
    count: top.count,
    total: pool.length,
    chase: chases.get(top.band) || 0,
    dominant: tiedTops === 1 && top.count >= FINISH_MIN_MODAL && top.count / pool.length >= FINISH_MIN_SHARE,
  };
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
  FINISH_MIN_SAMPLE,
  FINISH_MIN_MODAL,
  FINISH_MIN_SHARE,
  finishingToken,
  finishBand,
  outPitchFinishLocation,
};
