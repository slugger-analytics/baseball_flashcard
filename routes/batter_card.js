/**
 * routes/batter_card.js — GET /api/batter/card, the data behind one flashcard.
 */

'use strict';

const express = require('express');
const { resolveDateRange } = require('../lib/dates.js');
const { fetchPitchesForBatter } = require('../lib/pitch_cache.js');
const { isUnknownBatterError, UPSTREAM_ERROR_MESSAGE } = require('../lib/slugger.js');
const { getLeagueFirstPitchAvg } = require('../lib/league_baseline.js');
const {
  transformPitchDataToTeams, encodePitchZonesColumnar, countPitchesByVelocity, filterByPitchGroup,
} = require('../lib/transform.js');

const router = express.Router();

// A SLUGGER player id is a UUID; the HTTP tests use short slugs like
// 'velo-test-0001' that are served from a seeded disk cache. This accepts both and
// rejects what is plainly not an id ('../../etc/passwd', "' OR 1=1--", a 5,000-
// character string) before it reaches the upstream URL. It is a format check, not
// an existence check — a well-formed id that SLUGGER does not know still goes
// upstream and is handled by isUnknownBatterError.
const BATTER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BATTER_IDS = 20;

/**
 * GET /api/batter/card
 * Returns scouting-card data for ONE batter, scoped to that batter's pitches.
 * This is the batter-first flow's data query: pitches are fetched with a
 * `batter_id` filter (a few hundred records), never the whole date-range space.
 * Response: { teamsData: { team: [profile, ...] }, metadata } — one profile per
 * batting side, so a switch hitter comes back as two.
 * @query {string} batterIds - Comma-separated SLUGGER player UUID(s) for the chosen batter.
 * @query {string} [startDate] - Start date; defaults to season start.
 * @query {string} [endDate] - End date; defaults to today/season end.
 * @query {number} [maxVelocity] - Exclude pitches faster than this (mph).
 * @query {string} [pitchGroup] - 'All' | 'Fastballs' | 'Breaking' | 'Offspeed'.
 */
router.get('/api/batter/card', async (req, res) => {
  try {
    const { batterIds, startDate, endDate, maxVelocity, pitchGroup } = req.query;

    const ids = (batterIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'missing_batter', message: 'Select a batter first.' });
    }
    if (ids.length > MAX_BATTER_IDS || !ids.every(id => BATTER_ID_PATTERN.test(id))) {
      return res.status(400).json({ error: 'invalid_batter', message: 'That is not a valid batter.' });
    }

    const range = resolveDateRange(startDate, endDate);
    if (range.error) {
      return res.status(range.status).json({ error: range.error, message: range.message });
    }
    const { finalStartDate, finalEndDate } = range;

    console.log(`\nBatter card: ${ids.length} id(s), ${finalStartDate} → ${finalEndDate}`);

    // Scoped fetch — one query per id, merged. Never touches the full pitch space.
    let pitches = [];
    try {
      for (const id of ids) {
        const part = await fetchPitchesForBatter(id, finalStartDate, finalEndDate);
        if (part && part.length) pitches.push(...part);
      }
    } catch (err) {
      // Distinct from the empty case below: the feed was unreachable, so we do not
      // know whether this batter has data. Saying "no data found" would be a lie.
      if (isUnknownBatterError(err)) {
        return res.status(404).json({
          error: 'unknown_batter',
          message: "This batter isn't recognised by the league data feed.",
        });
      }
      console.error('Upstream fetch failed for batter card:', err.message);
      return res.status(503).json({ error: 'upstream_error', message: UPSTREAM_ERROR_MESSAGE });
    }

    if (pitches.length === 0) {
      return res.status(404).json({
        error: 'no_data',
        message: 'No pitch data found for this batter in the selected window.'
      });
    }

    pitches = filterByPitchGroup(pitches, pitchGroup);

    const parsedMaxVelocity = maxVelocity ? parseFloat(maxVelocity) : 999;
    // Attach the newest season-to-date league first-pitch average (memo/disk). If a
    // cold container has none yet, this is null → Neutral + "league avg pending".
    const leagueFirstPitchAvg = getLeagueFirstPitchAvg();
    const teamsData = transformPitchDataToTeams(pitches, {}, parsedMaxVelocity, leagueFirstPitchAvg);

    const totalPlayers = Object.values(teamsData).reduce((sum, team) => sum + team.length, 0);
    if (totalPlayers === 0) {
      return res.status(404).json({
        error: 'no_data_velocity',
        message: 'No pitch data for this batter in the selected velocity range.'
      });
    }

    const wire = encodePitchZonesColumnar(teamsData);

    res.json({
      teamsData: wire.teamsData,
      metadata: {
        startDate: finalStartDate,
        endDate: finalEndDate,
        filesProcessed: pitches.length,
        pitchesFilteredByVelocity: countPitchesByVelocity(pitches, parsedMaxVelocity),
        pzLegend: wire.pzLegend
      }
    });
  } catch (error) {
    console.error('Error building batter card:', error.message);
    res.status(500).json({ error: 'card_failed', message: error.message });
  }
});

module.exports = router;
