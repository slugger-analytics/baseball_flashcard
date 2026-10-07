/**
 * routes/status.js — API health and lookup-cache status.
 */

'use strict';

const express = require('express');
const { lookupCache } = require('../lib/lookup.js');

const router = express.Router();

router.get('/api/health', (req, res) => {
  res.json({
    status: 'Server running',
    apiConfigured: true,
    cacheStatus: { players: lookupCache.players.size, teams: lookupCache.teams.size, ballparks: lookupCache.ballparks.size }
  });
});

router.get('/api/cache-status', (req, res) => {
  res.json({
    players: lookupCache.players.size,
    teams: lookupCache.teams.size,
    ballparks: lookupCache.ballparks.size,
    samplePlayer: Array.from(lookupCache.players.keys())[0] || null,
    apiKeyConfigured: !!process.env.SLUGGER_API_KEY
  });
});

module.exports = router;
