/**
 * lib/config.js — environment, season calendar and request-budget limits.
 *
 * Everything that changes between environments or seasons lives here, once.
 * server.js loads dotenv before requiring this module.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Lambda's filesystem is read-only except /tmp; use /tmp there, local cache/
// elsewhere. Note /tmp lives and dies with the execution container, so a cold
// start rebuilds every cache. CACHE_DIR overrides both — tests run in parallel
// processes and need disjoint dirs, and pointing it at a mount would make the
// caches survive a recycle.
const CACHE_DIR = process.env.CACHE_DIR
  || (process.env.AWS_LAMBDA_FUNCTION_NAME
    ? '/tmp/cache'
    : path.join(__dirname, '..', 'cache'));
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Set by Lambda so the ALB can route /widgets/flashcard/* here.
const BASE_PATH = process.env.BASE_PATH || '';

const SLUGGER_CONFIG = {
  // .env.example has documented SLUGGER_BASE_URL as an optional override since the
  // beginning, but this was hardcoded and silently ignored it.
  baseUrl: process.env.SLUGGER_BASE_URL
    || 'https://1ywv9dczq5.execute-api.us-east-2.amazonaws.com/ALPBAPI',
  apiKey: process.env.SLUGGER_API_KEY,
};

// ALPB season calendar. Hardcoded by necessity — the feed exposes no schedule
// endpoint. It lives once, in SEASONS in pitch_logic.js, which the browser also
// uses for the toolbar's date presets: separate copies are precisely how a
// rollover gets half-applied. Add the new season there each spring.
const { SEASONS } = require('../public/js/pitch_logic.js');
const SEASON_START = SEASONS[SEASONS.length - 1].start;
const SEASON_END = SEASONS[SEASONS.length - 1].end;

/**
 * The default date range for a request that names none: the season so far, clamped
 * to the season's own bounds.
 * @returns {{start: string, end: string}}
 */
function getSeasonDefaults() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr < SEASON_START) return { start: SEASON_START, end: SEASON_START };
  if (todayStr <= SEASON_END) return { start: SEASON_START, end: todayStr };
  return { start: SEASON_START, end: SEASON_END };
}

const TEAM_DISPLAY_NAMES = {
  'YOR': 'York Revolution', 'LI': 'Long Island Ducks', 'LAN': 'Lancaster Stormers',
  'STA_YAN': 'Staten Island FerryHawks', 'LEX_LEG': 'Lexington Legends',
  'WES_POW': 'Charleston Dirty Birds', 'HP': 'High Point Rockers',
  'GAS': 'Gastonia Ghost Peppers', 'SMD': 'Southern Maryland Blue Crabs',
  'HAG_FLY': 'Hagerstown Flying Boxcars'
};

module.exports = {
  CACHE_DIR,
  BASE_PATH,
  SLUGGER_CONFIG,
  SEASON_START,
  SEASON_END,
  getSeasonDefaults,
  TEAM_DISPLAY_NAMES,
};
