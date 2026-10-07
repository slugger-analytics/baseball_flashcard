/**
 * lib/transform.js — raw pitch records → per-batter card data.
 *
 * transformPitchDataToTeams groups pitches by team and batter and builds every
 * count, zone cell and tendency the card shows; encodePitchZonesColumnar packs the
 * per-pitch dots for the wire.
 */

'use strict';

const {
  isZeroZeroPitch, classifyZeroZeroCall, firstPitchMetric, firstPitchLabel,
} = require('./stats.js');
const { getPlayerName, getTeamName } = require('./lookup.js');
const {
  assessStealThreat, assessBuntThreat, sprayTendency, analyzeOutSequences,
} = require('./tendencies.js');
// Strike zone geometry is shared with the browser client (public/js/pitch_logic.js
// is also loaded as a plain <script> in the page), so the labels the server assigns and
// the grid the client draws are guaranteed to describe the same rectangle.
const {
  getZoneFromLocation, plateToPercent, pitchFamily, annotateZoneGroups,
} = require('../public/js/pitch_logic.js');

/**
 * Coerces a raw plate coordinate, rejecting anything that isn't a real reading.
 * The guard is load-bearing: getZoneFromLocation never fails, it just returns a
 * label, so any junk that survives coercion becomes a confident fake location.
 * A bare `!= null` check is not enough — Number('') and Number(false) are both a
 * finite 0, which lands dead centre of the plate. The numeric-string branch stays
 * deliberately: the feed emitting '0.5' must not silently kill the whole feature.
 * @param {*} value - Raw plate_loc_side / plate_loc_height off the pitch record.
 * @returns {number|null}
 */
function plateCoordinate(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Zone label for the pitch that FINISHED a plate appearance, or null when the feed
 * carries no usable plate coordinates.
 * @param {Object} pitch - The raw pitch record that ended the plate appearance.
 * @param {string} handedness - Batter handedness: 'LHB' or 'RHB'.
 * @returns {string|null}
 */
function finishZoneOf(pitch, handedness) {
  const side = plateCoordinate(pitch.plate_loc_side);
  const height = plateCoordinate(pitch.plate_loc_height);
  if (side === null || height === null) return null;
  return getZoneFromLocation(side, height, handedness);
}

/**
 * Converts a full Trackman pitch type name to its display abbreviation.
 * @param {string} pitchType - Raw pitch type string from the API (e.g. 'Four-Seam', 'Slider').
 * @returns {string} Two-letter abbreviation (e.g. '4S', 'SL'). Defaults to 'FB' if unrecognized.
 */
function getPitchAbbreviation(pitchType) {
  if (!pitchType || pitchType === 'Undefined') return 'FB';
  const abbrev = { 'Fastball': 'FB', 'Four-Seam': '4S', 'TwoSeamFastball': '2S', 'Sinker': 'Si', 'Cutter': 'FC', 'Slider': 'SL', 'Curveball': 'CB', 'Changeup': 'CH', 'ChangeUp': 'CH', 'Splitter': 'SP', 'Knuckleball': 'KN' };
  return abbrev[pitchType] || 'FB';
}

/**
 * Transforms a flat array of raw pitch records into a structured teams → batters data object.
 * Computes per-batter stats, zone analysis, pitch sequences, and tendency labels.
 * @param {Array} pitchData - Raw pitch records from the SLUGGER API.
 * @param {Object} [existingData={}] - Existing teams data to merge into (used for incremental builds).
 * @param {number} [maxVelocity=999] - Pitches above this speed (mph) are excluded.
 * @param {number|null} [leagueFirstPitchAvg=null] - Pooled league first-pitch metric
 *   (season-to-date) used to classify each batter's approach. null = league-avg pending.
 * @returns {Object} Map of team name → array of batter stat objects.
 */
function transformPitchDataToTeams(pitchData, existingData = {}, maxVelocity = 999, leagueFirstPitchAvg = null) {

  const teamsData = { ...existingData }, batterMap = new Map();
  Object.entries(teamsData).forEach(([team, batters]) => {
    batters.forEach(batter => batterMap.set(`${team}_${batter.batter}`, batter));
  });

  pitchData.forEach(pitch => {

    const pitchSpeed = parseFloat(pitch.rel_speed || pitch.release_speed || 0);
    if (maxVelocity < 999 && pitchSpeed > maxVelocity) {
      return;
    }

    const batterName = getPlayerName(pitch.batter_id);
    const teamName = getTeamName(pitch.batter_team_code);
    const pitcherName = getPlayerName(pitch.pitcher_id);
    if (!batterName || !teamName || !pitcherName) return;

    // Switch hitters are keyed by both name and side so they form two independent profiles.
    const batterHandedness = pitch.batter_side === 'Left' ? 'LHB' : 'RHB';
    const batterKey = `${teamName}_${batterName}_${batterHandedness}`;
    if (!teamsData[teamName]) teamsData[teamName] = [];

    let batterData = batterMap.get(batterKey);
    if (!batterData) {
      batterData = {
        batter: batterName,
        handedness: pitch.batter_side === 'Left' ? 'LHB' : 'RHB',
        pitcher: pitcherName,
        pitcherThrows: pitch.pitcher_throws === 'Left' ? 'LHP' : 'RHP',
        context: `${pitch.top_or_bottom || 'Top'} ${pitch.inning || 1}, ${pitch.balls || 0}-${pitch.strikes || 0}`,
        battingOrder: pitch.pa_of_inning || teamsData[teamName].length + 1,
        pitchZones: [], zoneAnalysis: {},
        stats: { totalPitches: 0, strikes: 0, balls: 0, swings: 0, contact: 0, fouls: 0, whiffs: 0, weakContact: 0, hardContact: 0 },
        // First-pitch approach tally over 0-0 pitches (internal; not shipped on the wire).
        _fp: { zeroZero: 0, swung: 0, taken: 0, hbp: 0, other: 0 },
        plateAppearances: [], atBats: [], stolenBases: 0, caughtStealing: 0, bunts: 0,
        strikeoutSequences: [], strikeoutDetails: [], outSequences: [],
        tendencies: { firstStrike: 'Calculating...', buntThreat: 'Low', stealThreat: 'Low', spray: 'All fields' },
        powerSequence: 'Calculating...'
      };
      batterMap.set(batterKey, batterData);
      teamsData[teamName].push(batterData);
    }

    const gameKey = pitch.game_id != null && pitch.game_id !== ''
      ? `game-${pitch.game_id}`
      : `date-${pitch.date || 'unknown'}`;
    const paKey = `${gameKey}_${pitch.top_or_bottom || 'Top'}_${pitch.inning}_${pitch.pa_of_inning}`;
    let currentPA = batterData.plateAppearances.find(pa => pa.key === paKey);
    if (!currentPA) {
      currentPA = { key: paKey, pitches: [], result: null };
      batterData.plateAppearances.push(currentPA);
    }

    const pitchType = getPitchAbbreviation(pitch.auto_pitch_type || pitch.tagged_pitch_type);
    currentPA.pitches.push({ type: pitchType, call: pitch.pitch_call, count: `${pitch.balls}-${pitch.strikes}` });

    batterData.stats.totalPitches++;
    // First-pitch approach uses the pre-pitch count fields directly and does not
    // depend on plate-appearance grouping.
    if (isZeroZeroPitch(pitch)) {
      batterData._fp.zeroZero++;
      batterData._fp[classifyZeroZeroCall(pitch.pitch_call)]++;
    }

    if (['StrikeCalled', 'StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) batterData.stats.strikes++;
    if (pitch.pitch_call === 'BallCalled') batterData.stats.balls++;
    if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) batterData.stats.swings++;
    if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) batterData.stats.contact++;
    if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) batterData.stats.fouls++;
    if (pitch.pitch_call === 'StrikeSwinging') batterData.stats.whiffs++;

    if (pitch.exit_speed && pitch.pitch_call === 'InPlay') {
      if (pitch.exit_speed >= 95) batterData.stats.hardContact++;
      else if (pitch.exit_speed < 70) batterData.stats.weakContact++;
    }

    if (pitch.play_result && pitch.play_result !== 'Undefined') {
      currentPA.result = pitch.play_result;

      // Track sequences that get OUTS (any type of out)
      const isOut =
        pitch.play_result === 'Out' ||
        pitch.play_result === 'FieldersChoice' ||
        pitch.play_result === 'Sacrifice' ||
        pitch.k_or_bb === 'Strikeout';

      if (isOut && currentPA.pitches.length >= 2) {
        // The final two pitches that led to this out (setup pitch → out pitch)
        const shortSeq = currentPA.pitches.slice(-2).map(p => p.type).join(' → ');

        batterData.outSequences.push({
          shortSequence: shortSeq,
          outType: pitch.k_or_bb === 'Strikeout' ? 'K' : pitch.play_result,
          wasSwinging: pitch.pitch_call === 'StrikeSwinging',
          pitchCount: currentPA.pitches.length,
          zone: finishZoneOf(pitch, batterData.handedness)
        });
      }

      if (pitch.play_result.includes('StolenBase') || pitch.k_or_bb === 'Stolen Base') batterData.stolenBases++;
      if (pitch.play_result.includes('CaughtStealing')) batterData.caughtStealing++;
      if (pitch.play_result.includes('Bunt') || pitch.pitch_call.includes('Bunt')) batterData.bunts++;
      if (pitch.pitch_call === 'InPlay' && pitch.exit_speed) {
        batterData.atBats.push({
          launchAngle: pitch.angle || 0,
          direction: pitch.direction || 0,
          distance: pitch.distance || 0,
          exitSpeed: pitch.exit_speed,
          result: pitch.play_result
        });
      }
    }

    // Strikeouts in Trackman often have no play_result — capture them for outSequences separately
    if (pitch.k_or_bb === 'Strikeout' && currentPA.pitches.length >= 2 &&
        !(pitch.play_result && pitch.play_result !== 'Undefined')) {
      const shortSeq = currentPA.pitches.slice(-2).map(p => p.type).join(' → ');
      batterData.outSequences.push({
        shortSequence: shortSeq,
        outType: 'K',
        wasSwinging: pitch.pitch_call === 'StrikeSwinging',
        pitchCount: currentPA.pitches.length,
        zone: finishZoneOf(pitch, batterData.handedness)
      });
    }

    if (pitch.k_or_bb === 'Strikeout' && currentPA.pitches.length >= 2) {
      const lastTwo = currentPA.pitches.slice(-2);
      batterData.strikeoutSequences.push(`${lastTwo[0].type} → ${lastTwo[1].type}`);

      // Detailed strikeout analysis
      const strikeoutPitch = currentPA.pitches[currentPA.pitches.length - 1];
      const setupPitch = currentPA.pitches.length >= 2 ? currentPA.pitches[currentPA.pitches.length - 2] : null;

      const strikeoutSide = plateCoordinate(pitch.plate_loc_side);
      const strikeoutHeight = plateCoordinate(pitch.plate_loc_height);
      const zone = strikeoutSide !== null && strikeoutHeight !== null
        ? getZoneFromLocation(strikeoutSide, strikeoutHeight, batterData.handedness)
        : 'Unknown';

      batterData.strikeoutDetails.push({
        finalPitch: strikeoutPitch.type,
        setupPitch: setupPitch ? setupPitch.type : null,
        finalCount: strikeoutPitch.count,
        zone: zone,
        wasSwinging: pitch.pitch_call === 'StrikeSwinging',
        fullSequence: currentPA.pitches.map(p => p.type).join(' → ')
      });
    }

    const zoneAnalysisSide = plateCoordinate(pitch.plate_loc_side);
    const zoneAnalysisHeight = plateCoordinate(pitch.plate_loc_height);
    if (zoneAnalysisSide !== null && zoneAnalysisHeight !== null) {
      const zone = getZoneFromLocation(zoneAnalysisSide, zoneAnalysisHeight, batterData.handedness);
      const pitcherHand = pitch.pitcher_throws === 'Left' ? 'L' : 'R';
      if (!batterData.zoneAnalysis[zone]) {
        batterData.zoneAnalysis[zone] = { pitches: 0, swings: 0, whiffs: 0, fouls: 0, weakContact: 0, hardHits: 0, contact: 0, ballsInPlay: 0, exitSpeedCount: 0, calledStrikes: 0, balls: 0, contactOuts: 0, contactHits: 0, groups: {} };
      }

      const zoneStats = batterData.zoneAnalysis[zone];
      // Per-family cell within this zone. annotateZoneGroups reads these to decide
      // whether one family drives the zone, then deletes them — they must never
      // reach the wire (17 zones x 3 families of counters on a 1 MB budget).
      const family = pitchFamily(pitchType);
      const cell = zoneStats.groups[family]
        || (zoneStats.groups[family] = { pitches: 0, swings: 0, whiffs: 0, weakContact: 0, contact: 0, hardHits: 0 });
      cell.pitches++;
      zoneStats.pitches++;
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) { zoneStats.swings++; cell.swings++; }
      if (pitch.pitch_call === 'StrikeSwinging') { zoneStats.whiffs++; cell.whiffs++; }
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) zoneStats.fouls++;
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) { zoneStats.contact++; cell.contact++; }
      if (pitch.pitch_call === 'StrikeCalled') zoneStats.calledStrikes++;
      if (pitch.pitch_call === 'BallCalled') zoneStats.balls++;
      if (pitch.pitch_call === 'InPlay') {
        zoneStats.ballsInPlay++;
        const exitSpeed = Number(pitch.exit_speed);
        if (pitch.exit_speed != null && pitch.exit_speed !== '' && Number.isFinite(exitSpeed)) {
          zoneStats.exitSpeedCount++;
          if (exitSpeed >= 95) { zoneStats.hardHits++; cell.hardHits++; }
          else if (exitSpeed < 70) { zoneStats.weakContact++; cell.weakContact++; }
        }
      }
      if (pitch.pitch_call === 'InPlay' && pitch.play_result) {
        if (['Out', 'FieldersChoice', 'Sacrifice'].includes(pitch.play_result)) zoneStats.contactOuts++;
        else if (['Single', 'Double', 'Triple', 'HomeRun'].includes(pitch.play_result)) zoneStats.contactHits++;
      }

      // Pitcher's perspective: the batter silhouette flanks the zone as the
      // pitcher sees it (LHB left of the zone, RHB right). plateToPercent owns
      // the projection and shares its geometry with the drawn strike zone.
      const position = plateToPercent(zoneAnalysisSide, zoneAnalysisHeight);

      // Single-word outcome per pitch so the frontend can bucket pitches any
      // way it likes (pitch type × zone × pitcher hand) and derive hit rates.
      // Takes are split by the umpire's call: a called strike and a ball are
      // very different reads on a batter's discipline.
      let outcome = 'other';
      if (pitch.pitch_call === 'StrikeSwinging') outcome = 'whiff';
      else if (pitch.pitch_call === 'StrikeCalled') outcome = 'strike';
      else if (pitch.pitch_call === 'BallCalled') outcome = 'ball';
      else if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) outcome = 'foul';
      else if (pitch.pitch_call === 'InPlay' && ['Single', 'Double', 'Triple', 'HomeRun'].includes(pitch.play_result)) outcome = 'hit';
      else if (pitch.pitch_call === 'InPlay' && ['Out', 'FieldersChoice', 'Sacrifice'].includes(pitch.play_result)) outcome = 'out';

      batterData.pitchZones.push({
        position,
        pitch: pitchType, outcome: outcome, zone: zone,
        pitcherThrows: pitcherHand
      });
    }
  });

  Object.values(teamsData).forEach(batters => {
    batters.forEach(batter => {
      // Attribute each zone's vulnerability/damage to a pitch family where one
      // family clearly drives it, then strip the per-family cells. Runs for every
      // batter, including those with no pitches, so `groups` can never leak onto
      // the wire.
      annotateZoneGroups(batter.zoneAnalysis);

      if (batter.stats.totalPitches > 0) {
        // First-pitch approach: metric = swings / PA′ over 0-0 pitches, classified
        // against the pooled league average (±25%). Missing league avg → Neutral +
        // pending flag; the card is never blocked on it.
        const fp = batter._fp || { swung: 0, taken: 0 };
        const paPrime = fp.swung + fp.taken;
        if (paPrime > 0) {
          const metric = firstPitchMetric(fp);
          const pct = Math.round(metric * 100);
          const hasLeague = (leagueFirstPitchAvg != null && leagueFirstPitchAvg > 0);
          const label = firstPitchLabel(metric, hasLeague ? leagueFirstPitchAvg : null);
          batter.tendencies.firstStrike = `${label} (${pct}%)`;
          batter.tendencies.firstStrikeLeagueAvg = hasLeague ? Math.round(leagueFirstPitchAvg * 100) : null;
          batter.tendencies.firstStrikePending = !hasLeague;
        }

        batter.tendencies.stealThreat = assessStealThreat(batter);
        batter.tendencies.buntThreat = assessBuntThreat(batter);

        const spray = sprayTendency(batter);
        if (spray) batter.tendencies.spray = spray;

        const outResult = analyzeOutSequences(batter.outSequences);
        batter.powerSequence = outResult.text;
        batter.powerSequenceBreakdown = outResult.breakdown;
      }
    });
  });

  // Response slimming. The frontend (app.js) reads only the fields below; the raw
  // plateAppearances / atBats / *Sequences accumulators exist solely to derive
  // tendencies + powerSequence above. Shipping them inflated the payload past the
  // ALB 1 MB Lambda-response limit, which reached users as a 502 (data never loaded,
  // so the team/player-selection panels were never reachable). Return only what the
  // UI consumes.
  const RESPONSE_FIELDS = [
    'batter', 'handedness', 'jerseyNumber',
    'stats', 'pitchZones', 'zoneAnalysis',
    'tendencies', 'powerSequence', 'powerSequenceBreakdown',
  ];
  const slimData = {};
  for (const [teamName, batters] of Object.entries(teamsData)) {
    slimData[teamName] = batters.map(batter => {
      const slim = {};
      for (const field of RESPONSE_FIELDS) {
        if (batter[field] !== undefined) slim[field] = batter[field];
      }
      return slim;
    });
  }
  return slimData;
}

/**
 * Re-encodes each batter's pitchZones array into a columnar form for the wire.
 *
 * Row form ({position, pitch, outcome, zone, pitcherThrows} per pitch) repeats key
 * names and string values ~100k times on a full-season response; even gzipped (and
 * then base64-encoded by the Lambda/ALB integration) that overflowed the ALB's 1 MB
 * response limit and reached users as a 502. Columnar arrays of small integers with
 * per-response legends carry the same data in ~1/4 the size: a full season gzips to
 * ~550 KB (~730 KB after base64) vs ~850 KB (~1.1 MB) in row form.
 *
 * position values are already rounded to one decimal, so ×10 round-trips exactly.
 * Legends are built from the data and shipped in metadata.pzLegend, so the client
 * decoder can never drift from the server's value sets.
 *
 * @param {Object} teamsData - transformPitchDataToTeams output (row-form pitchZones).
 * @returns {{teamsData: Object, pzLegend: Object}} Wire teamsData (pz columns per
 *   batter, no pitchZones) and the legend needed to decode it.
 */
function encodePitchZonesColumnar(teamsData) {
  const legends = { t: new Map(), o: new Map(), z: new Map(), h: new Map() };
  const indexOf = (legend, value) => {
    let idx = legend.get(value);
    if (idx === undefined) {
      idx = legend.size;
      legend.set(value, idx);
    }
    return idx;
  };

  const wireTeams = {};
  for (const [teamName, batters] of Object.entries(teamsData)) {
    wireTeams[teamName] = batters.map(batter => {
      const { pitchZones, ...rest } = batter;
      const x = [], y = [], t = [], o = [], z = [], h = [];
      for (const p of (pitchZones || [])) {
        x.push(Math.round(p.position[0] * 10));
        y.push(Math.round(p.position[1] * 10));
        t.push(indexOf(legends.t, p.pitch));
        o.push(indexOf(legends.o, p.outcome));
        z.push(indexOf(legends.z, p.zone));
        h.push(indexOf(legends.h, p.pitcherThrows));
      }
      return { ...rest, pz: { x, y, t, o, z, h } };
    });
  }

  const pzLegend = {
    t: [...legends.t.keys()], o: [...legends.o.keys()],
    z: [...legends.z.keys()], h: [...legends.h.keys()],
  };
  return { teamsData: wireTeams, pzLegend };
}

/**
 * Counts how many pitches in an array exceed the velocity cap (used for response metadata).
 * @param {Array} pitches - Array of raw pitch objects.
 * @param {number} maxVelocity - Velocity ceiling in mph.
 * @returns {number} Number of pitches that would be excluded by the cap.
 */
function countPitchesByVelocity(pitches, maxVelocity) {
  if (maxVelocity >= 999) return 0;
  return pitches.filter(pitch => {
    const pitchSpeed = parseFloat(pitch.rel_speed || pitch.release_speed || 0);
    return pitchSpeed > maxVelocity;
  }).length;
}

/**
 * Applies the pitch-group category filter (Fastballs / Breaking / Offspeed) to a
 * pitch array. 'All' / falsy = no filter.
 */
function filterByPitchGroup(pitches, pitchGroup) {
  if (!pitchGroup || pitchGroup === 'All') return pitches;
  const fastballs = ['Four-Seam', 'Sinker', 'Cutter'];
  const breaking  = ['Slider', 'Curveball'];
  const offspeed  = ['Changeup', 'ChangeUp', 'Splitter'];
  return pitches.filter(p => {
    const pt = p.auto_pitch_type || p.tagged_pitch_type;
    if (pitchGroup === 'Fastballs') return fastballs.includes(pt);
    if (pitchGroup === 'Breaking')  return breaking.includes(pt);
    if (pitchGroup === 'Offspeed')  return offspeed.includes(pt);
    return true;
  });
}

module.exports = {
  transformPitchDataToTeams,
  encodePitchZonesColumnar,
  countPitchesByVelocity,
  filterByPitchGroup,
};
