/**
 * routes/batters.js — who can be picked: the SLUGGER batter index and the
 * iScore club rosters.
 */

'use strict';

const express = require('express');
const { lookupCache, ensureLookupCaches } = require('../lib/lookup.js');
const { dedupeBatters } = require('../lib/players.js');
const { getRosters } = require('../lib/roster_cache.js');

const router = express.Router();

/**
 * GET /api/batters
 * Returns the distinct batter list for the batter-first selection flow, built
 * entirely from the in-memory /players lookup cache — no pitch-space scan.
 * Hitters are deduped by canonical (case-insensitive, trimmed) name so the
 * duplicate-whitespace / duplicate-case / split-id records the league DB carries
 * collapse into one pickable batter that still carries ALL of its player_ids (the
 * card endpoint queries every id and merges, so a batter whose pitches live under
 * a different id than its team-tagged record is never lost).
 * @returns {Object} { batters: [{ name, ids:[...], team, bats }], count }
 */
router.get('/api/batters', async (req, res) => {
  try {
    await ensureLookupCaches();

    // Dedupe by canonical (case-insensitive, trimmed) name: union all player_ids,
    // keep the canonical display name, and merge bats preferring 'Switch'.
    const batters = dedupeBatters(lookupCache.players.values());

    res.json({ batters, count: batters.length });
  } catch (error) {
    console.error('Error building batter list:', error.message);
    res.status(500).json({ error: 'batters_failed', message: error.message });
  }
});

/**
 * GET /api/rosters
 * Current club rosters from iScore, with each hitter joined to their SLUGGER
 * player IDs. This is the reliable team source: SLUGGER's own /players team_name
 * is sparse (132 of 564 batters carry none) and cannot express a mid-season trade.
 * @query {string} [refresh] - '1' to bypass the cache.
 * @returns {Object} { teams: [{guid, name, batters}], unmatched, generatedAt, cached }
 */
router.get('/api/rosters', async (req, res) => {
  try {
    await ensureLookupCaches();
    const { data, cached } = await getRosters(req.query.refresh === '1');
    res.json({ ...data, cached });
  } catch (error) {
    console.error('Error building rosters:', error.message);
    // The batter picker must still work without iScore, so this stays non-fatal.
    res.status(502).json({ error: 'rosters_failed', message: error.message, teams: [], unmatched: [] });
  }
});

module.exports = router;
