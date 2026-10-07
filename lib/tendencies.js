/**
 * lib/tendencies.js — per-batter scouting reads built on top of the transform:
 * steal and bunt threat, spray direction, and the pitch sequence that gets outs.
 */

'use strict';

const { outPitchFinishLocation, finishingToken } = require('./stats.js');

/**
 * Scores a batter's steal threat level based on stolen base history and speed indicators.
 * @param {Object} batter - Batter data object built by transformPitchDataToTeams.
 * @returns {string} 'Low', 'Moderate (reason)', or 'High (reason)'.
 */
function assessStealThreat(batter) {
  let stealScore = 0;
  const reasons = [];

  const stealAttempts = (batter.stolenBases || 0) + (batter.caughtStealing || 0);
  if (stealAttempts > 0) {
    const successRate = (batter.stolenBases / stealAttempts * 100);
    stealScore += stealAttempts * 2;
    if (successRate >= 75) stealScore += 3;
    reasons.push(`${batter.stolenBases}/${stealAttempts} SB (${successRate.toFixed(0)}%)`);
  }

  // Speed indicators from hit data
  if (batter.atBats.length >= 3) {
    const infieldHits = batter.atBats.filter(ab =>
      ab.exitSpeed < 85 && ab.distance < 150 && ab.result === 'Single'
    ).length;
    if (infieldHits >= 1) {
      stealScore += infieldHits * 2;
      reasons.push(`${infieldHits} infield hit${infieldHits > 1 ? 's' : ''}`);
    }

    // Fast runners hit weak grounders that still find holes
    const speedHits = batter.atBats.filter(ab =>
      ab.exitSpeed < 90 && ab.launchAngle < 15 && ab.result === 'Single'
    ).length;
    if (speedHits >= 2) {
      stealScore += 1;
      reasons.push('beats out grounders');
    }

    // Very high exit velo on grounders = leg speed
    const fastGrounders = batter.atBats.filter(ab =>
      ab.exitSpeed >= 95 && ab.launchAngle < 10
    ).length;
    if (fastGrounders >= 2) {
      stealScore += 2;
      reasons.push('explosive speed');
    }
  }

  // Patient hitters see more pitches = more steal opportunities
  if (batter.stats.totalPitches >= 15 && batter.plateAppearances.length > 0) {
    const pitchesPerPA = batter.stats.totalPitches / batter.plateAppearances.length;
    if (pitchesPerPA >= 4.0) {
      stealScore += 1;
      reasons.push('patient');
    }
  }

  let threat = 'Low';
  if (stealScore >= 4) threat = 'High';
  else if (stealScore >= 2) threat = 'Moderate';

  return threat === 'Low' ? 'Low' : `${threat} (${reasons.join(', ')})`;
}

/**
 * Scores a batter's bunt threat level based on bunt history, contact rate, and ground ball tendency.
 * @param {Object} batter - Batter data object built by transformPitchDataToTeams.
 * @returns {string} 'Low', 'Moderate (reason)', or 'High (reason)'.
 */
function assessBuntThreat(batter) {
  let buntScore = 0;
  const reasons = [];

  if (batter.bunts > 0) {
    buntScore += batter.bunts * 3;
    reasons.push(`${batter.bunts} bunts`);
  }

  if (batter.stats.swings > 10) {
    const contactRate = (batter.stats.contact / batter.stats.swings * 100);
    if (contactRate >= 80) {
      buntScore += 2;
      reasons.push('high contact');
    }
  }

  if (batter.stats.contact >= 10 && batter.stats.weakContact >= 3) {
    const weakPct = (batter.stats.weakContact / batter.stats.contact * 100);
    if (weakPct >= 25) {
      buntScore += 1;
      reasons.push('bat control');
    }
  }

  if (batter.atBats.length >= 5) {
    const grounders = batter.atBats.filter(ab => ab.angle < 15).length;
    const groundBallRate = (grounders / batter.atBats.length * 100);
    if (groundBallRate >= 60) {
      buntScore += 1;
      reasons.push(`${groundBallRate.toFixed(0)}% GB`);
    }
  }

  let threat = 'Low';
  if (buntScore >= 6) threat = 'High';
  else if (buntScore >= 3) threat = 'Moderate';

  return threat === 'Low' ? 'Low' : `${threat} (${reasons.join(', ')})`;
}

/**
 * Pull / center / opposite-field read from batted-ball direction.
 * @param {Object} batter - Batter data object built by transformPitchDataToTeams.
 * @returns {string|null} The spray label, or null under 5 tracked balls in play
 *   (the caller keeps its default).
 */
function sprayTendency(batter) {
  if (batter.atBats.length < 5) return null;

  const pullCount = batter.atBats.filter(ab =>
    batter.handedness === 'LHB' ? ab.direction > 15 : ab.direction < -15
  ).length;

  const centCount = batter.atBats.filter(ab =>
    ab.direction >= -15 && ab.direction <= 15
  ).length;

  const oppoCount = batter.atBats.filter(ab =>
    batter.handedness === 'LHB' ? ab.direction < -15 : ab.direction > 15
  ).length;

  const total = batter.atBats.length;
  const pullPct = (pullCount / total * 100);
  const centPct = (centCount / total * 100);
  const oppoPct = (oppoCount / total * 100);

  if (pullPct > 60) return `Pull hitter (${pullPct.toFixed(0)}%)`;
  if (oppoPct > 40) return `Opposite field (${oppoPct.toFixed(0)}%)`;
  return `All fields (P:${pullPct.toFixed(0)}% C:${centPct.toFixed(0)}% O:${oppoPct.toFixed(0)}%)`;
}

/**
 * Finds the pitch sequence that gets this batter OUT (not just strikeouts).
 * @param {Array} outSequences - { shortSequence, outType, wasSwinging, pitchCount, zone }.
 * @returns {{text: string, breakdown: Object|null}}
 */
function analyzeOutSequences(outSequences) {
  if (!outSequences || outSequences.length === 0) {
    return { text: 'Insufficient data', breakdown: null };
  }

  const total = outSequences.length;

  // Count each out's two-pitch sequence (setup pitch → out pitch)
  const sequenceCounts = {};

  outSequences.forEach(out => {
    sequenceCounts[out.shortSequence] = (sequenceCounts[out.shortSequence] || 0) + 1;
  });

  // Find sequences that appear at least twice OR represent 30%+ of outs
  const significantSequences = Object.entries(sequenceCounts)
    .filter(([seq, count]) => count >= 2 || (count / total) >= 0.3)
    .sort((a, b) => b[1] - a[1]);

  // Build breakdown for the top sequence's matching outs
  function buildBreakdown(topSeq, matchingOuts) {
    const bd = { kSwinging: 0, kLooking: 0, contactOut: 0 };
    matchingOuts.forEach(out => {
      if (out.outType === 'K') {
        if (out.wasSwinging) bd.kSwinging++;
        else bd.kLooking++;
      } else {
        bd.contactOut++;
      }
    });
    // Modal finish location of the out pitch, hung on the object that is
    // already on the wire so RESPONSE_FIELDS and the client signature stay
    // untouched. Pooled over every out FINISHING on that pitch type, not
    // just the outs matching the two-pitch headline. Assigned only when
    // non-null so sub-sample batters add no payload.
    const finishLocation = outPitchFinishLocation(outSequences, finishingToken(topSeq));
    if (finishLocation) bd.finishLocation = finishLocation;
    return bd;
  }

  if (significantSequences.length > 0) {
    const [topSeq, count] = significantSequences[0];
    const pct = Math.round(count / total * 100);

    // Show top sequence with percentage
    let text = `${topSeq} (${count}/${total} = ${pct}%)`;

    // If there's a strong second pattern, mention it too
    if (significantSequences.length > 1 && significantSequences[1][1] >= 2) {
      const [secondSeq, secondCount] = significantSequences[1];
      const secondPct = Math.round(secondCount / total * 100);
      if (secondPct >= 25) {
        text += ` • Also: ${secondSeq} (${secondCount}/${total} = ${secondPct}%)`;
      }
    }

    const matchingOuts = outSequences.filter(out => out.shortSequence === topSeq);
    return { text, breakdown: buildBreakdown(topSeq, matchingOuts) };
  }

  // Fallback: if no clear pattern, show most common individual pitch that gets outs.
  // buildBreakdown gets a BARE token here rather than an 'A → B' sequence, which
  // finishingToken handles correctly (it returns the token itself). The finish
  // caption can never appear on this branch anyway: the fallback only fires when
  // every shortSequence has count 1, and getPitchAbbreviation emits 10 distinct
  // tokens, so the finish pool caps at 10 — below FINISH_MIN_SAMPLE.
  const finalPitches = {};
  outSequences.forEach(out => {
    const lastPitch = out.shortSequence.split(' → ').pop();
    finalPitches[lastPitch] = (finalPitches[lastPitch] || 0) + 1;
  });

  const topPitch = Object.entries(finalPitches).sort((a, b) => b[1] - a[1])[0];
  if (!topPitch) return { text: 'Insufficient data', breakdown: null };

  const matchingOuts = outSequences.filter(out => out.shortSequence.split(' → ').pop() === topPitch[0]);
  return {
    text: `${topPitch[0]} gets outs (${topPitch[1]}/${total})`,
    breakdown: buildBreakdown(topPitch[0], matchingOuts)
  };
}

module.exports = {
  assessStealThreat,
  assessBuntThreat,
  sprayTendency,
  analyzeOutSequences,
};
