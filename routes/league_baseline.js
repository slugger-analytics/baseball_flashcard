/**
 * routes/league_baseline.js — GET /api/league-baseline, hit by the prewarm cron.
 */

'use strict';

const express = require('express');
const { resolveDateRange } = require('../lib/dates.js');
const { UPSTREAM_ERROR_MESSAGE } = require('../lib/slugger.js');
const {
  leagueFirstPitchIsFresh, refreshLeagueFirstPitch, getLeagueFirstPitchMemo,
} = require('../lib/league_baseline.js');

const router = express.Router();

/**
 * GET /api/league-baseline
 * Computes (or returns the cached) season-to-date league first-pitch metric that
 * every batter card grades against. Awaited rather than fired-and-forgotten:
 * Lambda freezes the execution environment after the response, so a detached
 * background fetch would stall mid-flight.
 * @returns {Object} { metric, start, end, computedAt, refreshed }
 */
router.get('/api/league-baseline', async (req, res) => {
  try {
    const range = resolveDateRange(null, null);
    if (range.error) {
      return res.status(range.status).json({ error: range.error, message: range.message });
    }
    const { finalStartDate, finalEndDate } = range;

    let refreshed = false;
    if (!leagueFirstPitchIsFresh(finalStartDate, finalEndDate)) {
      await refreshLeagueFirstPitch(finalStartDate, finalEndDate);
      refreshed = true;
    }

    const memo = getLeagueFirstPitchMemo();
    res.json({
      metric: memo ? memo.metric : null,
      start: memo ? memo.start : finalStartDate,
      end: memo ? memo.end : finalEndDate,
      computedAt: memo ? memo.computedAt : null,
      refreshed
    });
  } catch (error) {
    console.error('League baseline refresh failed:', error.message);
    res.status(503).json({ error: 'upstream_error', message: UPSTREAM_ERROR_MESSAGE });
  }
});

module.exports = router;
