/**
 * lib/roster_cache.js — iScore club rosters joined to SLUGGER ids, cached.
 *
 * Rosters change at most a few times a day (transactions, IL moves), and the
 * build costs 11 iScore calls, so it is memoised in process and mirrored to disk
 * so a cold container does not pay for it again.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { CACHE_DIR, TEAM_DISPLAY_NAMES, getSeasonDefaults } = require('./config.js');
const { lookupCache } = require('./lookup.js');
const { fetchPitchesByDateRange } = require('./pitch_cache.js');
const {
  buildRosters, activityWindow, latestTeamByBatter, ACTIVITY_WINDOW_DAYS,
} = require('./iscore.js');

const ROSTER_TTL_MS = 6 * 60 * 60 * 1000;
let rosterMemo = null; // { data, fetchedAt }

function rosterCachePath() {
  return path.join(CACHE_DIR, 'iscore_rosters.json');
}

function readRosterDiskCache() {
  try {
    const rec = JSON.parse(fs.readFileSync(rosterCachePath(), 'utf8'));
    if (rec && rec.fetchedAt && (Date.now() - rec.fetchedAt) < ROSTER_TTL_MS) return rec;
  } catch (_) { /* absent or unreadable — rebuild */ }
  return null;
}

/**
 * Narrows each club to the hitters actually playing for it. iScore's `active`
 * flag is club-maintained and 40% of its roster entries belong to departed
 * players, so the pitch feed decides: a hitter is on a club if his most recent
 * pitch in the window was for it.
 *
 * Fails soft on purpose. The filter is an improvement on the roster, not a
 * dependency of it — if this fetch is slow or upstream is down, return null and
 * serve the unfiltered iScore roster rather than an empty picker.
 */
async function loadActivity() {
  try {
    const season = getSeasonDefaults();
    const window = activityWindow(season.end, ACTIVITY_WINDOW_DAYS);
    const pitches = await fetchPitchesByDateRange(window.start, window.end);
    const activity = {
      latestTeam: latestTeamByBatter(pitches),
      codeToName: TEAM_DISPLAY_NAMES,
      window,
    };
    console.log(`✅ Roster activity: ${activity.latestTeam.size} batters played ` +
      `${window.start} → ${window.end}`);
    return activity;
  } catch (err) {
    console.error('Roster activity window unavailable, serving unfiltered rosters:', err.message);
    return null;
  }
}

/**
 * Current club rosters, from memory, disk or a fresh build.
 * Expects the SLUGGER lookup cache to be populated.
 * @param {boolean} [force=false] - Skip both caches and rebuild.
 * @returns {Promise<{data: Object, cached: 'memory'|'disk'|false}>}
 */
async function getRosters(force = false) {
  if (!force) {
    if (rosterMemo && (Date.now() - rosterMemo.fetchedAt) < ROSTER_TTL_MS) {
      return { data: rosterMemo.data, cached: 'memory' };
    }
    const disk = readRosterDiskCache();
    if (disk) {
      rosterMemo = disk;
      return { data: disk.data, cached: 'disk' };
    }
  }

  const activity = await loadActivity();
  const data = await buildRosters(axios, lookupCache.players.values(), undefined, activity);
  rosterMemo = { data, fetchedAt: Date.now() };
  try {
    fs.writeFileSync(rosterCachePath(), JSON.stringify(rosterMemo));
  } catch (err) {
    console.error('Roster cache write failed:', err.message);
  }
  console.log(`✅ Rosters: ${data.teams.length} teams, ` +
    `${data.teams.reduce((n, t) => n + t.batters.length, 0)} hitters matched, ` +
    `${data.unmatched.length} unmatched`);
  return { data, cached: false };
}

module.exports = { getRosters };
