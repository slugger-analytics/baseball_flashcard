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

// ── Pitch groups ──────────────────────────────────────────────────────────────
// Coarse pitch-type categories. Membership is verbatim from the server's
// filterByPitchGroup so the range/card filter and these zone annotations agree on
// exactly which raw pitch types belong to each group. 'Fastball',
// 'TwoSeamFastball', 'Knuckleball' and 'Undefined' intentionally live in NO group.
const PITCH_GROUP_TAXONOMY = {
  Fastballs: ['Four-Seam', 'Sinker', 'Cutter'],
  Breaking: ['Slider', 'Curveball'],
  Offspeed: ['Changeup', 'ChangeUp', 'Splitter'],
};

/**
 * Maps a raw pitch type (auto_pitch_type || tagged_pitch_type) to its coarse group.
 * @param {string} rawType - Raw pitch type string from the feed.
 * @returns {'Fastballs'|'Breaking'|'Offspeed'|null} Group key, or null if ungrouped.
 */
function getPitchGroup(rawType) {
  if (!rawType) return null;
  for (const group of Object.keys(PITCH_GROUP_TAXONOMY)) {
    if (PITCH_GROUP_TAXONOMY[group].includes(rawType)) return group;
  }
  return null;
}

/**
 * Maps a pitch's plate coordinates to a named strike zone (e.g. 'High-In', 'Mid-Out').
 *
 * Sign convention (verified empirically on the full 2026 feed, ~107k pitches):
 * positive plate_loc_side = the CATCHER'S LEFT = third-base side = where a
 * right-handed batter stands. Two independent checks agree: (1) pitchers work
 * away — pitches to RHB lean negative, to LHB positive; (2) pitch physics —
 * RHP sliders (glove-side break, catcher's right) average -0.36 while RHP
 * sinkers/changeups (arm-side run, catcher's left) average +0.22/+0.27, with
 * LHP exactly mirrored. Earlier code assumed the opposite sign, which mirrored
 * every In/Out label (and the dot positions that were later flipped to match).
 *
 * @param {number} plateSide - Horizontal plate position in feet (positive = catcher's left).
 * @param {number} plateHeight - Vertical plate position in feet above the ground.
 * @param {string} handedness - Batter handedness: 'LHB' or 'RHB'.
 * @returns {string} Zone label in the format '<Vertical>-<Horizontal>'.
 */
function getZoneFromLocation(plateSide, plateHeight, handedness) {
  const isInside = (handedness === 'RHB' && plateSide > 0.33) || (handedness === 'LHB' && plateSide < -0.33);
  const isOutside = (handedness === 'RHB' && plateSide < -0.33) || (handedness === 'LHB' && plateSide > 0.33);
  const horizontal = isInside ? 'In' : (isOutside ? 'Out' : 'Mid');
  const isHigh = plateHeight > 3.0, isLow = plateHeight < 2.0;
  const vertical = isHigh ? 'High' : (isLow ? 'Low' : 'Mid');
  return `${vertical}-${horizontal}`;
}

// ── Zone × pitch-group annotations ───────────────────────────────────────────
// Minimum evidence before a (zone × group) cell may drive a zone's vulnerable/hot
// annotation. The cell rate must also exceed the zone's overall rate by ZONE_GROUP_EDGE.
const MIN_ZONE_GROUP_PITCHES = 8;
const MIN_ZONE_GROUP_SWINGS = 4;
const ZONE_GROUP_EDGE = 0.25;

/**
 * Annotates each zone in a zoneAnalysis map with the pitch group that most drives
 * its vulnerability (vg/vgN) and/or hard contact (hg/hgN), when one group clears
 * the sample + separation gates. Mutates in place and ALWAYS deletes the internal
 * per-group accumulator (`zone.groups`) so it never reaches the wire. Absent
 * signals leave the fields undefined (never null).
 *
 * Vulnerability rate = (whiffs + weakContact) / swings; hot rate = hardHits / contact.
 * A cell qualifies when it has >= MIN_ZONE_GROUP_PITCHES pitches and
 * >= MIN_ZONE_GROUP_SWINGS swings, the zone's own rate is positive, and the cell
 * rate is at least (1 + ZONE_GROUP_EDGE)x the zone rate. Hot additionally requires
 * the cell to have >= 3 balls in contact. Ties are broken by the higher cell rate.
 * @param {Object} zoneAnalysis - map of zone label → per-zone counters (+ .groups cells).
 * @returns {Object} the same zoneAnalysis, mutated.
 */
function computeZoneGroupAnnotations(zoneAnalysis) {
  if (!zoneAnalysis) return zoneAnalysis;
  const factor = 1 + ZONE_GROUP_EDGE;

  for (const zone of Object.values(zoneAnalysis)) {
    const groups = zone && zone.groups;
    if (!groups) continue;

    const zoneSwings = zone.swings || 0;
    const zoneContact = zone.contact || 0;
    const zoneVulnRate = zoneSwings > 0 ? ((zone.whiffs || 0) + (zone.weakContact || 0)) / zoneSwings : 0;
    const zoneHotRate = zoneContact > 0 ? (zone.hardHits || 0) / zoneContact : 0;

    let bestVuln = null; // { group, n, rate }
    let bestHot = null;

    for (const group of Object.keys(groups)) {
      const cell = groups[group];
      const cellPitches = cell.pitches || 0;
      const cellSwings = cell.swings || 0;
      if (cellPitches < MIN_ZONE_GROUP_PITCHES || cellSwings < MIN_ZONE_GROUP_SWINGS) continue;

      // Vulnerable: cell whiff+weak rate clears the zone rate by the edge.
      const cellVulnRate = ((cell.whiffs || 0) + (cell.weakContact || 0)) / cellSwings;
      if (zoneVulnRate > 0 && cellVulnRate >= zoneVulnRate * factor) {
        if (!bestVuln || cellVulnRate > bestVuln.rate) bestVuln = { group, n: cellPitches, rate: cellVulnRate };
      }

      // Hot: cell hard-hit rate clears the zone rate by the edge, with a contact floor.
      const cellContact = cell.contact || 0;
      if (cellContact >= 3 && zoneHotRate > 0) {
        const cellHotRate = (cell.hardHits || 0) / cellContact;
        if (cellHotRate >= zoneHotRate * factor) {
          if (!bestHot || cellHotRate > bestHot.rate) bestHot = { group, n: cellPitches, rate: cellHotRate };
        }
      }
    }

    if (bestVuln) { zone.vg = bestVuln.group; zone.vgN = bestVuln.n; }
    if (bestHot) { zone.hg = bestHot.group; zone.hgN = bestHot.n; }
    delete zone.groups;
  }
  return zoneAnalysis;
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
  PITCH_GROUP_TAXONOMY,
  getPitchGroup,
  getZoneFromLocation,
  MIN_ZONE_GROUP_PITCHES,
  MIN_ZONE_GROUP_SWINGS,
  ZONE_GROUP_EDGE,
  computeZoneGroupAnnotations,
};
