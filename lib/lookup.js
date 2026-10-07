/**
 * lib/lookup.js — in-memory player / team / ballpark lookups from SLUGGER.
 *
 * Loaded once per container (and on demand after a cold start), then used to turn
 * the ids on every pitch record into display names.
 */

'use strict';

const { fetchAllPages } = require('./slugger.js');
const { buildCanonicalNameMap } = require('./players.js');
const { TEAM_DISPLAY_NAMES } = require('./config.js');

const lookupCache = { players: new Map(), teams: new Map(), ballparks: new Map(), canonicalNames: new Map() };

/**
 * Populates in-memory lookup caches for players, teams, and ballparks on server start.
 * Must complete before the server begins handling requests.
 */
async function populateLookupCaches() {
  console.log('Populating lookup caches...');
  try {
    const players = await fetchAllPages('/players');
    players.forEach(p => { if (p.player_id && p.player_name) lookupCache.players.set(p.player_id, p); });
    // Canonical display name per person, so case-variant duplicate rows in the
    // league DB ("Bates, Austin" vs "bates, austin") resolve to one display name.
    lookupCache.canonicalNames = buildCanonicalNameMap(lookupCache.players.values());
    console.log(`✅ Cached ${lookupCache.players.size} players`);

    const teams = await fetchAllPages('/teams');
    teams.forEach(t => { if (t.team_code && t.team_name) lookupCache.teams.set(t.team_code, t); });
    console.log(`✅ Cached ${lookupCache.teams.size} teams`);

    const ballparks = await fetchAllPages('/ballparks');
    ballparks.forEach(b => { if (b.ballpark_name) lookupCache.ballparks.set(b.ballpark_name, b); });
    console.log(`✅ Cached ${lookupCache.ballparks.size} ballparks\n`);
  } catch (error) {
    console.error('⚠️  Cache error:', error.message, '\n');
  }
}

/**
 * A cold container starts with an empty lookup cache; build it on demand.
 */
async function ensureLookupCaches() {
  if (lookupCache.players.size === 0) await populateLookupCaches();
}

/**
 * Resolves a player ID to its canonical display name using the in-memory cache.
 * Names are trimmed (the league DB has duplicate records differing only by
 * trailing whitespace, e.g. "Brigman, Bryson " vs "Brigman, Bryson") AND
 * case-normalized to the canonical variant (e.g. "bates, austin" → "Bates,
 * Austin"), so a player never fragments into two cards with split stats.
 * @param {string} id - SLUGGER player UUID.
 * @returns {string} Player's canonical full name, or a fallback identifier if not found.
 */
function getPlayerName(id) {
  const raw = lookupCache.players.get(id)?.player_name;
  const trimmed = raw && raw.trim();
  if (!trimmed) return `Player-${id?.substring(0, 8) || 'Unknown'}`;
  return lookupCache.canonicalNames.get(trimmed.toLowerCase()) || trimmed;
}

/**
 * Resolves a team code to a display name using the in-memory cache.
 * @param {string} code - SLUGGER team code (e.g. 'YOR').
 * @returns {string} Team display name, or the raw code as fallback.
 */
function getTeamName(code) {
  return lookupCache.teams.get(code)?.team_name || TEAM_DISPLAY_NAMES[code] || code;
}

module.exports = {
  lookupCache,
  populateLookupCaches,
  ensureLookupCaches,
  getPlayerName,
  getTeamName,
};
