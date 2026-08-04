require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { withParserAsStream } = require('stream-json/streamers/stream-array.js');
const {
  isZeroZeroPitch, classifyZeroZeroCall, firstPitchMetric, firstPitchLabel, poolLeagueFirstPitch,
  outPitchFinishLocation, finishingToken,
} = require('./lib/stats.js');
const { buildCanonicalNameMap, dedupeBatters } = require('./lib/players.js');
// Strike zone geometry is shared with the browser client (pitch_logic.js is also
// loaded as a plain <script> before app.js), so the labels the server assigns and
// the grid the client draws are guaranteed to describe the same rectangle.
const { getZoneFromLocation, plateToPercent } = require('./pitch_logic.js');

// Vercel's and Lambda's filesystems are read-only except /tmp; use /tmp there, local cache/ elsewhere.
const CACHE_DIR = (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
  ? '/tmp/cache'
  : path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

// Get BASE_PATH from environment (set by Lambda) or default to empty
const BASE_PATH = process.env.BASE_PATH || '';

// Root health check endpoint for Lambda Web Adapter (must be at root level)
// Must be available before other routes (Requirement 12.1, 12.2, 12.4)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Also handle health check at BASE_PATH for ALB routing
if (BASE_PATH) {
  app.get(`${BASE_PATH}/health`, (req, res) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString()
    });
  });
}

// Request logging middleware (Requirements 5.3, 5.4)
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestPath = req.path;
  const method = req.method;

  // Log request start
  console.log(`[${new Date().toISOString()}] ${method} ${requestPath} - Started`);

  // Capture response finish to log response time
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    console.log(`[${new Date().toISOString()}] ${method} ${requestPath} - ${statusCode} (${duration}ms)`);
  });

  next();
});

// Serve static files at both root and BASE_PATH.
// no-cache = revalidate on every use (304 when unchanged), NOT "don't cache".
// Without it, browsers held app.js for days on heuristic freshness and users
// ran stale bundles long after deploys.
const STATIC_OPTS = {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
};
app.use(express.static('.', STATIC_OPTS));
if (BASE_PATH) {
  app.use(BASE_PATH, express.static('.', STATIC_OPTS));
}

const SLUGGER_CONFIG = {
  baseUrl: "https://1ywv9dczq5.execute-api.us-east-2.amazonaws.com/ALPBAPI",
  apiKey: process.env.SLUGGER_API_KEY 
};

const lookupCache = { players: new Map(), teams: new Map(), ballparks: new Map(), canonicalNames: new Map() };

const TEAM_DISPLAY_NAMES = {
  'YOR': 'York Revolution', 'LI': 'Long Island Ducks', 'LAN': 'Lancaster Stormers',
  'STA_YAN': 'Staten Island FerryHawks', 'LEX_LEG': 'Lexington Legends',
  'WES_POW': 'Charleston Dirty Birds', 'HP': 'High Point Rockers',
  'GAS': 'Gastonia Ghost Peppers', 'SMD': 'Southern Maryland Blue Crabs',
  'HAG_FLY': 'Hagerstown Flying Boxcars'
};

/**
 * Makes an authenticated GET request to the SLUGGER API.
 * @param {string} endpoint - API path (e.g. '/pitches').
 * @param {Object} [params={}] - Query parameters to include. Defaults `limit` to 1000.
 * @returns {Promise<Object>} Parsed JSON response body.
 */
async function sluggerRequest(endpoint, params = {}) {
  const response = await axios.get(`${SLUGGER_CONFIG.baseUrl}${endpoint}`, {
    headers: { 'x-api-key': SLUGGER_CONFIG.apiKey, 'Content-Type': 'application/json' },
    params: { ...params, limit: params.limit || 1000 }
  });
  return response.data;
}

/**
 * Fetches all pages from a paginated SLUGGER API endpoint, up to MAX_PAGES.
 *
 * Pages are fetched in fixed-size concurrent batches rather than strictly one-at-a-time.
 * The upstream API exposes no total-count, so a page returning fewer than PAGE_SIZE records
 * marks the end of data; the batch containing that short page is the last batch fetched.
 * Record order is preserved exactly — batches, and results within a batch, are appended in
 * page order — while wall-clock latency collapses from sum-of-pages to sum-of-batches. A
 * 36-page range drops from 36 serial round trips to ~5 batches at PAGE_CONCURRENCY=8, i.e.
 * roughly an 8x reduction in the dominant fetch time.
 *
 * @param {string} endpoint - API path to paginate (e.g. '/pitches').
 * @param {Object} [params={}] - Additional query parameters merged into each page request.
 * @param {Function} [mapBatch] - Optional per-page transform applied to each page's records
 *   before accumulation (filter/slim). Applied after the short-page end-of-data check so it
 *   cannot affect pagination; records stay in page order.
 * @returns {Promise<Array>} Combined array of all records across all pages, in page order.
 */
async function fetchAllPages(endpoint, params = {}, mapBatch = null) {
  const MAX_PAGES = 500;
  const PAGE_SIZE = 1000;
  const PAGE_CONCURRENCY = 8;
  const allData = [];
  let nextPage = 1;
  let reachedEnd = false;

  while (!reachedEnd && nextPage <= MAX_PAGES) {
    const batchPages = [];
    for (let i = 0; i < PAGE_CONCURRENCY && nextPage + i <= MAX_PAGES; i++) {
      batchPages.push(nextPage + i);
    }

    const settled = await Promise.allSettled(
      batchPages.map(p => sluggerRequest(endpoint, { ...params, page: p, limit: PAGE_SIZE }))
    );

    // settled is in page order (ascending), so any short/empty page is processed before the
    // speculative pages that follow it within the same batch.
    for (const result of settled) {
      if (result.status === 'rejected') {
        // A batch speculatively requests up to PAGE_CONCURRENCY pages at once, so some may
        // lie past the true end of data. Once an earlier page has signalled end-of-data, a
        // failure on those speculative pages is harmless and must not fail the whole fetch.
        // A failure seen before any end signal is a real in-range error — surface it (both
        // callers wrap this in try/catch) rather than silently truncating the dataset.
        if (reachedEnd) continue;
        throw result.reason;
      }
      const response = result.value;
      if (response.success && response.data) {
        const items = Array.isArray(response.data) ? response.data : [response.data];
        if (items.length < PAGE_SIZE) reachedEnd = true;
        allData.push(...(mapBatch ? mapBatch(items) : items));
      } else {
        reachedEnd = true;
      }
    }

    if (!reachedEnd) {
      console.log(`  Fetched ${allData.length} records (through page ${batchPages[batchPages.length - 1]})...`);
    }
    nextPage += batchPages.length;
  }

  if (nextPage > MAX_PAGES && !reachedEnd) {
    console.warn(`⚠️  fetchAllPages hit the ${MAX_PAGES}-page safety ceiling on ${endpoint}`);
  }
  return allData;
}

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

// Add this endpoint to check cache status
app.get('/api/cache-status', (req, res) => {
  res.json({
    players: lookupCache.players.size,
    teams: lookupCache.teams.size,
    ballparks: lookupCache.ballparks.size,
    samplePlayer: Array.from(lookupCache.players.keys())[0] || null,
    apiKeyConfigured: !!process.env.SLUGGER_API_KEY,
    apiKeyPrefix: process.env.SLUGGER_API_KEY ? process.env.SLUGGER_API_KEY.substring(0, 10) + '...' : 'missing'
  });
});

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


/**
 * Returns the disk path for a cached pitch range file.
 */
function getCachePath(startDate, endDate) {
  return path.join(CACHE_DIR, `cache_${startDate}_${endDate}.json`);
}

/**
 * Streams a cached pitch array from disk using fs.createReadStream + stream-json.
 * Records are parsed incrementally so the full array is never simultaneously resident.
 */
function readDiskCache(filePath) {
  return new Promise((resolve, reject) => {
    const records = [];
    const pipeline = fs.createReadStream(filePath).pipe(withParserAsStream());
    pipeline.on('data', ({ value }) => records.push(value));
    pipeline.on('end', () => resolve(records));
    pipeline.on('error', reject);
  });
}

// Raw pitch records from the API carry dozens of fields; the app reads only these.
// Slimming each record as its page arrives (instead of holding full-fat records for
// the whole range) keeps a full-season fetch (~110k+ pitches) far from the Lambda's
// memory ceiling — the full raw dataset never exists in the heap at once.
const PITCH_FIELDS = [
  'date', 'rel_speed', 'release_speed',
  'batter_id', 'batter_team_code', 'pitcher_id',
  'batter_side', 'pitcher_throws',
  'top_or_bottom', 'inning', 'balls', 'strikes', 'pa_of_inning',
  'auto_pitch_type', 'tagged_pitch_type', 'pitch_call',
  'exit_speed', 'play_result', 'k_or_bb',
  'plate_loc_side', 'plate_loc_height',
  'angle', 'direction', 'distance',
];

/**
 * Returns a copy of a raw pitch record containing only the fields the app consumes.
 */
function slimPitch(pitch) {
  const slim = {};
  for (const field of PITCH_FIELDS) {
    if (pitch[field] !== undefined) slim[field] = pitch[field];
  }
  return slim;
}

// Ranges bigger than this aren't disk-cached: stringifying + writing them can
// exhaust the Lambda's 512 MB /tmp (and heap), and a failed write used to leave
// a truncated file that poisoned every later request for the same range.
// Records are slimmed to PITCH_FIELDS before caching (~6x smaller than raw),
// so the ceiling covers a full season comfortably.
const MAX_CACHED_PITCHES = 200000;

/**
 * Writes a pitch array to disk as JSON for subsequent streamed reads.
 * Writes to a .tmp file first and renames into place so a crash mid-write can
 * never leave a partially-written cache file at the real path.
 */
async function writeDiskCache(filePath, pitches) {
  const tmpPath = `${filePath}.tmp`;
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpPath);
      ws.on('finish', resolve);
      ws.on('error', reject);
      ws.write(JSON.stringify(pitches));
      ws.end();
    });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
    throw err;
  }
}

/**
 * Fetches all pitch records for a date range from the SLUGGER API, with disk-backed streaming cache.
 * On a cache miss, pages are fetched and written to disk; on a hit, records are streamed back
 * through stream-json without loading the full array into V8 heap simultaneously.
 * @param {string} startDateStr - Start date in YYYY-MM-DD format.
 * @param {string} endDateStr - End date in YYYY-MM-DD format.
 * @returns {Promise<Array>} Array of raw pitch objects, or empty array on error.
 */
async function fetchPitchesByDateRange(startDateStr, endDateStr) {
  const cachePath = getCachePath(startDateStr, endDateStr);

  if (fs.existsSync(cachePath)) {
    console.log(`💾 Disk cache hit: ${path.basename(cachePath)}`);
    try {
      return await readDiskCache(cachePath);
    } catch (err) {
      // A corrupt/truncated cache file (e.g. from a crash mid-write) would
      // otherwise fail this range on this container forever — drop and refetch.
      console.error(`⚠️ Corrupt disk cache ${path.basename(cachePath)}, refetching:`, err.message);
      try { fs.unlinkSync(cachePath); } catch (_) { /* best effort */ }
    }
  }

  console.log(`Fetching date range from SLUGGER API: ${startDateStr} to ${endDateStr}`);

  try {
    // Filter + slim each page as it arrives so full-fat out-of-range records are
    // dropped immediately instead of accumulating across the whole range.
    const filtered = await fetchAllPages('/pitches', {
      date_range_start: startDateStr,
      date_range_end: endDateStr
    }, (items) => items
      .filter(p => {
        const d = (p.date || '').slice(0, 10);
        return d >= startDateStr && d <= endDateStr;
      })
      .map(slimPitch)
    );

    console.log(`✅ Fetched + date-filtered (${startDateStr} → ${endDateStr}): ${filtered.length} pitches`);

    // Cache failures must never discard a successful fetch — serve uncached.
    if (filtered.length <= MAX_CACHED_PITCHES) {
      try {
        await writeDiskCache(cachePath, filtered);
        console.log(`💾 Disk cache stored: ${path.basename(cachePath)} (${filtered.length} pitches)`);
      } catch (err) {
        console.error(`⚠️ Disk cache write failed (serving uncached):`, err.message);
      }
    } else {
      console.log(`⏭️ Range too large to disk-cache (${filtered.length} > ${MAX_CACHED_PITCHES} pitches)`);
    }

    return filtered;

  } catch (error) {
    console.error("❌ Error fetching from SLUGGER API:", error);
    return [];
  }
}

/**
 * Fetches pitch records for a SINGLE batter in a date range, with a per-batter
 * disk cache. The SLUGGER `/pitches` endpoint accepts a `batter_id` filter that
 * scopes the query server-side, so this pulls only the chosen batter's pitches
 * (a few hundred records) instead of the whole date-range pitch space (100k+).
 * This is the interactive flow's only pitch query — the full-space
 * fetchPitchesByDateRange is never on the batter-first path.
 * @param {string} batterId - SLUGGER player UUID to scope the query to.
 * @param {string} startDateStr - Start date (YYYY-MM-DD).
 * @param {string} endDateStr - End date (YYYY-MM-DD).
 * @returns {Promise<Array>} Slimmed pitch records for that batter, or [] on error.
 */
async function fetchPitchesForBatter(batterId, startDateStr, endDateStr) {
  const cachePath = path.join(CACHE_DIR, `cache_batter_${batterId}_${startDateStr}_${endDateStr}.json`);

  if (fs.existsSync(cachePath)) {
    console.log(`💾 Batter cache hit: ${path.basename(cachePath)}`);
    try {
      return await readDiskCache(cachePath);
    } catch (err) {
      console.error(`⚠️ Corrupt batter cache ${path.basename(cachePath)}, refetching:`, err.message);
      try { fs.unlinkSync(cachePath); } catch (_) { /* best effort */ }
    }
  }

  console.log(`Fetching batter ${batterId?.slice(0, 8)} pitches: ${startDateStr} → ${endDateStr}`);

  try {
    // batter_id scopes the upstream query; the date filter below is a safety net.
    const filtered = await fetchAllPages('/pitches', {
      date_range_start: startDateStr,
      date_range_end: endDateStr,
      batter_id: batterId
    }, (items) => items
      .filter(p => {
        const d = (p.date || '').slice(0, 10);
        return d >= startDateStr && d <= endDateStr;
      })
      .map(slimPitch)
    );

    console.log(`✅ Batter ${batterId?.slice(0, 8)}: ${filtered.length} pitches`);

    try {
      await writeDiskCache(cachePath, filtered);
    } catch (err) {
      console.error(`⚠️ Batter cache write failed (serving uncached):`, err.message);
    }

    return filtered;
  } catch (error) {
    console.error(`❌ Error fetching batter ${batterId} pitches:`, error.message);
    return [];
  }
}

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

    const paKey = `${pitch.inning}_${pitch.pa_of_inning}`;
    let currentPA = batterData.plateAppearances.find(pa => pa.key === paKey);
    if (!currentPA) {
      currentPA = { key: paKey, pitches: [], result: null };
      batterData.plateAppearances.push(currentPA);
    }

    const pitchType = getPitchAbbreviation(pitch.auto_pitch_type || pitch.tagged_pitch_type);
    currentPA.pitches.push({ type: pitchType, call: pitch.pitch_call, count: `${pitch.balls}-${pitch.strikes}` });

    batterData.stats.totalPitches++;
    // First-pitch approach uses the pre-pitch count fields (balls===0 && strikes===0),
    // which route around the cross-game paKey collision entirely.
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

      const zone = pitch.plate_loc_side !== null && pitch.plate_loc_height !== null
        ? getZoneFromLocation(pitch.plate_loc_side, pitch.plate_loc_height, batterData.handedness)
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

    if (pitch.plate_loc_side !== null && pitch.plate_loc_height !== null) {
      const zone = getZoneFromLocation(pitch.plate_loc_side, pitch.plate_loc_height, batterData.handedness);
      const pitcherHand = pitch.pitcher_throws === 'Left' ? 'L' : 'R';
      if (!batterData.zoneAnalysis[zone]) {
        batterData.zoneAnalysis[zone] = { pitches: 0, swings: 0, whiffs: 0, fouls: 0, weakContact: 0, hardHits: 0, contact: 0, calledStrikes: 0, balls: 0, contactOuts: 0, contactHits: 0 };
      }

      const zoneStats = batterData.zoneAnalysis[zone];
      zoneStats.pitches++;
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) zoneStats.swings++;
      if (pitch.pitch_call === 'StrikeSwinging') zoneStats.whiffs++;
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) zoneStats.fouls++;
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) zoneStats.contact++;
      if (pitch.pitch_call === 'StrikeCalled') zoneStats.calledStrikes++;
      if (pitch.pitch_call === 'BallCalled') zoneStats.balls++;
      if (pitch.exit_speed && pitch.pitch_call === 'InPlay') {
        if (pitch.exit_speed >= 95) zoneStats.hardHits++;
        else if (pitch.exit_speed < 70) zoneStats.weakContact++;
      }
      if (pitch.pitch_call === 'InPlay' && pitch.play_result) {
        if (['Out', 'FieldersChoice', 'Sacrifice'].includes(pitch.play_result)) zoneStats.contactOuts++;
        else if (['Single', 'Double', 'Triple', 'HomeRun'].includes(pitch.play_result)) zoneStats.contactHits++;
      }

      // Pitcher's perspective: the batter silhouette flanks the zone as the
      // pitcher sees it (LHB left of the zone, RHB right). plateToPercent owns
      // the projection and shares its geometry with the drawn strike zone.
      const position = plateToPercent(pitch.plate_loc_side, pitch.plate_loc_height);

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

        // Use improved threat assessments
        batter.tendencies.stealThreat = assessStealThreat(batter);
        batter.tendencies.buntThreat = assessBuntThreat(batter);

        if (batter.atBats.length >= 5) {
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

          if (pullPct > 60) {
            batter.tendencies.spray = `Pull hitter (${pullPct.toFixed(0)}%)`;
          } else if (oppoPct > 40) {
            batter.tendencies.spray = `Opposite field (${oppoPct.toFixed(0)}%)`;
          } else {
            batter.tendencies.spray = `All fields (P:${pullPct.toFixed(0)}% C:${centPct.toFixed(0)}% O:${oppoPct.toFixed(0)}%)`;
          }
        }

        // Analyze pitch sequences that get OUTS (not just strikeouts)
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

        const outResult = batter.outSequences.length > 0
          ? analyzeOutSequences(batter.outSequences)
          : { text: 'Insufficient data', breakdown: null };
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

// ── League first-pitch approach baseline ──────────────────────────────────────
// The pooled league metric (season-to-date) that per-batter approaches are graded
// against. Computed on every full-range transform (user load or the prewarm cron),
// held in memory and mirrored to CACHE_DIR so a cold container can recover the
// newest value from disk. The batter card attaches it but is NEVER blocked on it.
let leagueFirstPitchMemo = null; // { start, end, metric, tally, computedAt }

function spanDays(start, end) {
  const d = (new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000;
  return Number.isFinite(d) ? d : 0;
}

/**
 * Records a freshly-pooled league metric to the memo (keeping the widest / most
 * season-to-date span) and to a small per-range JSON in CACHE_DIR.
 */
function recordLeagueFirstPitch(start, end, pool) {
  if (!pool || pool.metric == null) return;
  const rec = { start, end, metric: pool.metric, tally: pool.tally, computedAt: new Date().toISOString() };
  if (!leagueFirstPitchMemo || spanDays(start, end) >= spanDays(leagueFirstPitchMemo.start, leagueFirstPitchMemo.end)) {
    leagueFirstPitchMemo = rec;
  }
  try {
    fs.writeFileSync(path.join(CACHE_DIR, `league_fp_${start}_${end}.json`), JSON.stringify(rec));
  } catch (err) {
    console.error('⚠️ league_fp write failed:', err.message);
  }
}

/**
 * Returns the newest available season-to-date league first-pitch metric, or null.
 * Prefers the memo; on a cold container scans CACHE_DIR for the widest-span record.
 */
function getLeagueFirstPitchAvg() {
  if (leagueFirstPitchMemo && leagueFirstPitchMemo.metric != null) return leagueFirstPitchMemo.metric;
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith('league_fp_') && f.endsWith('.json'));
    let best = null;
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
        if (!rec || rec.metric == null) continue;
        if (!best || spanDays(rec.start, rec.end) >= spanDays(best.start, best.end)) best = rec;
      } catch (_) { /* skip corrupt */ }
    }
    if (best) { leagueFirstPitchMemo = best; return best.metric; }
  } catch (_) { /* CACHE_DIR unreadable */ }
  return null;
}

/**
 * GET /api/teams/range
 * Returns batter scouting data for a given date range.
 * @query {string} startDate - Start date (YYYY-MM-DD, YYYYMMDD, or MM-DD-YYYY).
 * @query {string} endDate - End date. Must not be in the future.
 * @query {number} [maxVelocity] - Exclude pitches faster than this speed (mph).
 * @query {string} [pitchGroup] - Filter by pitch category: 'Fastballs', 'Breaking', or 'Offspeed'.
 * @returns {Object} { teamsData, metadata }
 */
const teamsRangeHandler = async (req, res) => {
  try {
    const { startDate, endDate, maxVelocity, pitchGroup } = req.query;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const parseDateInput = (dateStr) => {
      if (!dateStr) return null;
      const mdyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (mdyMatch) return `${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}`;
      if (dateStr.includes('-')) return dateStr;
      if (dateStr.length === 8) {
        return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
      }
      return null;
    };

    const getSeasonDefaults = () => {
      const todayStr = new Date().toISOString().slice(0, 10);
      const start = '2026-04-21';
      if (todayStr < start) return { start, end: start };
      if (todayStr <= '2026-09-13') return { start, end: todayStr };
      return { start, end: '2026-09-13' };
    };

    const parsedStart = parseDateInput(startDate);
    const parsedEnd = parseDateInput(endDate);
    const seasonDefaults = getSeasonDefaults();

    const finalStartDate = parsedStart || seasonDefaults.start;
    const finalEndDate = parsedEnd || seasonDefaults.end;

    if (new Date(`${finalStartDate}T00:00:00Z`) > new Date(`${finalEndDate}T00:00:00Z`)) {
      return res.status(400).json({
        error: 'invalid_range',
        message: 'Start date must be on or before end date.'
      });
    }

    if (new Date(`${finalEndDate}T00:00:00Z`) > today) {
      console.log(`Future date detected: ${finalEndDate}`);
      return res.status(404).json({
        error: 'future_date',
        message: 'No Data Available Yet For The Selected Period'
      });
    }

    console.log(`\nFetching date range: ${finalStartDate} to ${finalEndDate}`);

    // fetch pitches
    let pitches = await fetchPitchesByDateRange(finalStartDate, finalEndDate);

    if (!pitches || pitches.length === 0) {
      return res.status(404).json({
        error: 'no_data',
        message: 'No pitch data found for this date range. The season may not have started yet.'
      });
    }

    // League first-pitch baseline: pool over ALL pitches in the range (before any
    // pitch-group filter) so the file for a given range always reflects the league,
    // not a filtered subset. Persist to memo + disk for the batter-card endpoint.
    const leaguePool = poolLeagueFirstPitch(pitches);
    recordLeagueFirstPitch(finalStartDate, finalEndDate, leaguePool);
    const leagueFirstPitchAvg = leaguePool.metric;

    // filter by pitch group if specified
    if (pitchGroup && pitchGroup !== 'All') {
      const fastballs = ['Four-Seam', 'Sinker', 'Cutter'];
      const breaking  = ['Slider', 'Curveball'];
      const offspeed  = ['Changeup', 'ChangeUp', 'Splitter'];
      pitches = pitches.filter(p => {
        const pt = p.auto_pitch_type || p.tagged_pitch_type;
        if (pitchGroup === 'Fastballs') return fastballs.includes(pt);
        if (pitchGroup === 'Breaking')  return breaking.includes(pt);
        if (pitchGroup === 'Offspeed')  return offspeed.includes(pt);
        return true;
      });
    }

    // parse maxVelocity
    const parsedMaxVelocity = maxVelocity ? parseFloat(maxVelocity) : 999;

    // transform data with velocity filter
    const teamsData = transformPitchDataToTeams(pitches, {}, parsedMaxVelocity, leagueFirstPitchAvg);

    // check if any data survived the velocity filter
    const totalPlayers = Object.values(teamsData).reduce((sum, team) => sum + team.length, 0);
    
    if (totalPlayers === 0) {
      return res.status(404).json({
        error: 'no_data_velocity',
        message: 'No Data Available for this velocity range'
      });
    }
    
    const teamCount = Object.keys(teamsData).length;
    console.log(`✅ Complete: ${teamCount} teams, ${totalPlayers} players\n`);

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
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch data', details: error.message });
  }
};


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
 * POST /api/weakness-zones
 * Calculates and ranks a batter's weakness zones by confidence threshold.
 * @body {number} confidenceThreshold - Minimum confidence level (0–100); higher = fewer, more reliable zones.
 * @body {Object} teamsData - The full teamsData object returned by GET /api/teams/range.
 * @body {string} selectedTeam - Team name key in teamsData.
 * @body {string} selectedBatter - Batter name to analyze.
 * @returns {Object} { success, zones: Array, metadata }
 */
const weaknessZonesHandler = async (req, res) => {
  try {
    const { confidenceThreshold, teamsData, selectedTeam, selectedBatter } = req.body;

    if (!teamsData || !selectedTeam || !selectedBatter) {
      return res.status(400).json({
        error: 'missing_data',
        message: 'Missing required data: teamsData, selectedTeam, or selectedBatter'
      });
    }

    const batter = teamsData[selectedTeam]?.find(b => b.batter === selectedBatter);

    if (!batter) {
      return res.status(404).json({
        error: 'batter_not_found',
        message: `Batter ${selectedBatter} not found in team ${selectedTeam}`
      });
    }

    const weaknessZones = calculateWeaknessZones(batter, confidenceThreshold);

    const zonesToDisplay = confidenceThreshold >= 75 ? 4 : confidenceThreshold >= 50 ? 8 : 9;

    const sortedZones = Object.entries(weaknessZones)
      .map(([zone, data]) => ({
        zone,
        vulnerabilityScore: Math.round(data.vulnerabilityScore * 10) / 10,
        sampleSize: data.sampleSize,
        severity: data.severity,
        whiffs: data.whiffs,
        weakContact: data.weakContact
      }))
      .sort((a, b) => a.vulnerabilityScore - b.vulnerabilityScore)
      .slice(0, zonesToDisplay);

    res.json({
      success: true,
      zones: sortedZones,
      metadata: {
        threshold: confidenceThreshold,
        zonesDisplayed: zonesToDisplay,
        totalZonesAnalyzed: Object.keys(weaknessZones).length,
        batter: selectedBatter,
        team: selectedTeam
      }
    });

  } catch (error) {
    console.error('Error calculating weakness zones:', error);
    res.status(500).json({ error: 'calculation_error', message: error.message });
  }
};

app.post('/api/weakness-zones', weaknessZonesHandler);
if (BASE_PATH) {
  app.post(`${BASE_PATH}/api/weakness-zones`, weaknessZonesHandler);
}

/**
 * Scores each strike zone for a batter using the three-metric rank-based vulnerability formula.
 * Zones are ranked by Whiff Rate (45%), Weak Contact Rate (35%), and Chase/Foul Rate (20%).
 * A rank of 0 = worst (most vulnerable); the weighted sum produces a Vulnerability Score (0–100).
 * Only zones meeting the mode-specific minimum pitch count are included, and results are
 * filtered to the severity tier(s) allowed by the active confidence mode.
 * @param {Object} batter - A single batter object from transformPitchDataToTeams output.
 * @param {number} confidenceThreshold - Slider value (0–100): 75–100 = Strict, 50–74 = Balanced, 0–49 = Broad.
 * @returns {Object} Map of zone keys to { vulnerabilityScore, sampleSize, severity, whiffs, weakContact }.
 */
function calculateWeaknessZones(batter, confidenceThreshold) {
  const zoneStats = batter.zoneAnalysis || {};

  // Mode-specific parameters
  const minPitchesRequired = calculateMinPitches(confidenceThreshold);
  const maxScore = confidenceThreshold >= 75 ? 20 : confidenceThreshold >= 50 ? 35 : 60;

  // Step 1: compute raw percentages for zones that meet the minimum pitch count
  const zoneScores = {};
  Object.entries(zoneStats).forEach(([zone, stats]) => {
    if ((stats.pitches || 0) < minPitchesRequired) return;
    if ((stats.swings || 0) === 0) return;
    const whiff_percent       = (stats.whiffs      || 0) / stats.swings * 100;
    const chase_percent       = (stats.fouls       || 0) / stats.swings * 100;
    const weakContact_percent = stats.contact > 0 ? (stats.weakContact || 0) / stats.contact * 100 : 0;
    zoneScores[zone] = { whiff_percent, chase_percent, weakContact_percent, stats };
  });

  const zones = Object.keys(zoneScores);
  if (zones.length === 0) return {};

  // Step 2: rank each metric across zones (rank 0 = highest rate = most vulnerable)
  const getRank = (metric) => {
    const values = zones.map(z => zoneScores[z][metric]);
    const sorted = [...values].sort((a, b) => b - a);
    const ranks = {};
    zones.forEach(z => {
      const idx = sorted.findIndex(v => Math.abs(v - zoneScores[z][metric]) < 0.0001);
      ranks[z] = zones.length === 1 ? 0 : ((idx === -1 ? 0 : idx) / (zones.length - 1)) * 100;
    });
    return ranks;
  };

  const whiffRanks       = getRank('whiff_percent');
  const weakContactRanks = getRank('weakContact_percent');
  const chaseRanks       = getRank('chase_percent');

  // Step 3: compute weighted vulnerability score and filter by mode's severity ceiling
  const weaknessZones = {};
  zones.forEach(zone => {
    const vulnerabilityScore = (
      whiffRanks[zone]       * 0.45 +
      weakContactRanks[zone] * 0.35 +
      chaseRanks[zone]       * 0.20
    );
    if (vulnerabilityScore > maxScore) return;

    const severity = vulnerabilityScore <= 20 ? 'CRITICAL'
                   : vulnerabilityScore <= 35 ? 'MAJOR'
                   :                            'MODERATE';

    weaknessZones[zone] = {
      vulnerabilityScore,
      sampleSize:  zoneScores[zone].stats.pitches,
      severity,
      whiffs:      zoneScores[zone].stats.whiffs      || 0,
      weakContact: zoneScores[zone].stats.weakContact || 0,
    };
  });

  return weaknessZones;
}

/**
 * Maps a confidence threshold slider value to the minimum pitch sample size required.
 * Strict (75–100): 10+ pitches. Balanced (50–74): 7+ pitches. Broad (0–49): 3+ pitches.
 * @param {number} confidenceThreshold - Value between 0 and 100.
 * @returns {number} Minimum number of pitches required for a zone to be included.
 */
function calculateMinPitches(confidenceThreshold) {
  if (confidenceThreshold >= 75) return 10;
  if (confidenceThreshold >= 50) return 7;
  return 3;
}

/**
 * GET /api/generate-report
 * Assembles a full scouting report for a given date range and optional filters.
 * Optionally narrows output to a single team/batter and appends weakness zone analysis.
 * @query {string} startDate - Start of date range (YYYY-MM-DD or YYYYMMDD).
 * @query {string} endDate - End of date range (YYYY-MM-DD or YYYYMMDD).
 * @query {number} [maxVelocity] - Upper velocity cap in mph.
 * @query {number} [confidenceThreshold] - Weakness zone confidence threshold (0–100).
 * @query {string} [selectedTeam] - Team name to narrow output.
 * @query {string} [selectedBatter] - Batter name to include detailed zone breakdown.
 * @returns {Object} { success, reportData: { metadata, summary, teamsData, batterDetail } }
 */
app.get('/api/generate-report', async (req, res) => {
  try {
    const { startDate, endDate, maxVelocity, confidenceThreshold, selectedTeam, selectedBatter } = req.query;
    
    // fetch the data first
    const formattedStart = formatDateForApi(startDate);
    const formattedEnd = formatDateForApi(endDate);
    
    const pitches = await fetchPitchesByDateRange(formattedStart, formattedEnd);
    const parsedMaxVelocity = maxVelocity ? parseFloat(maxVelocity) : 999;
    const teamsData = transformPitchDataToTeams(pitches, {}, parsedMaxVelocity);
    
    // get specific batter data if selected
    let batterData = null;
    if (selectedTeam && selectedBatter && teamsData[selectedTeam]) {
      batterData = teamsData[selectedTeam].find(b => b.batter === selectedBatter);
      
      // calculate weakness zones if confidence threshold provided
      if (batterData && confidenceThreshold) {
        const weaknessZones = calculateWeaknessZones(batterData, parseFloat(confidenceThreshold));
        batterData.weaknessZones = weaknessZones;
      }
    }
    
    // prepare clean report data
    const reportData = {
      metadata: {
        generatedAt: new Date().toISOString(),
        dateRange: { start: startDate, end: endDate },
        velocityRange: maxVelocity ? `≤ ${maxVelocity} mph` : 'All velocities',
        confidenceThreshold: confidenceThreshold || 'Not applied',
        selectedBatter: selectedBatter || 'All batters',
        selectedTeam: selectedTeam || 'All teams'
      },
      summary: {
        totalTeams: Object.keys(teamsData).length,
        totalBatters: Object.values(teamsData).reduce((sum, team) => sum + team.length, 0),
        totalPitchesProcessed: pitches.length
      },
      teamsData: selectedTeam ? { [selectedTeam]: teamsData[selectedTeam] } : teamsData,
      batterDetail: batterData
    };
    
    res.json({
      success: true,
      reportData
    });
    
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Normalizes a date string to ISO format (YYYY-MM-DD).
 * Accepts either YYYY-MM-DD (passed through) or compact YYYYMMDD (converted).
 * @param {string|null} dateStr - Input date string.
 * @returns {string|null} ISO-formatted date string, or null if input is falsy.
 */
function formatDateForApi(dateStr) {
  if (!dateStr) return null;
  if (dateStr.includes('-')) return dateStr;
  if (dateStr.length === 8) {
    return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
  }
  return dateStr;
}

/**
 * Normalizes and validates a requested date range, falling back to season defaults.
 * Mirrors the parsing/validation teamsRangeHandler does inline, shared by the
 * batter-scoped card endpoint.
 * @param {string} startDate - Raw start date (YYYY-MM-DD, YYYYMMDD, or MM-DD-YYYY).
 * @param {string} endDate - Raw end date.
 * @returns {{finalStartDate:string, finalEndDate:string} | {error:string, status:number, message:string}}
 */
function resolveDateRange(startDate, endDate) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const parseDateInput = (dateStr) => {
    if (!dateStr) return null;
    const mdyMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (mdyMatch) return `${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}`;
    if (dateStr.includes('-')) return dateStr;
    if (dateStr.length === 8) {
      return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
    }
    return null;
  };

  const getSeasonDefaults = () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const start = '2026-04-21';
    if (todayStr < start) return { start, end: start };
    if (todayStr <= '2026-09-13') return { start, end: todayStr };
    return { start, end: '2026-09-13' };
  };

  const seasonDefaults = getSeasonDefaults();
  const finalStartDate = parseDateInput(startDate) || seasonDefaults.start;
  const finalEndDate = parseDateInput(endDate) || seasonDefaults.end;

  if (new Date(`${finalStartDate}T00:00:00Z`) > new Date(`${finalEndDate}T00:00:00Z`)) {
    return { error: 'invalid_range', status: 400, message: 'Start date must be on or before end date.' };
  }
  if (new Date(`${finalEndDate}T00:00:00Z`) > today) {
    return { error: 'future_date', status: 404, message: 'No Data Available Yet For The Selected Period' };
  }
  return { finalStartDate, finalEndDate };
}

/**
 * Applies the pitch-group category filter (Fastballs / Breaking / Offspeed) to a
 * pitch array. Shared by the range and batter-card endpoints. 'All' / falsy = no filter.
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
const battersHandler = async (req, res) => {
  try {
    // On Vercel the lookup cache warms in the background; build it on demand if empty.
    if (lookupCache.players.size === 0) {
      await populateLookupCaches();
    }

    // Dedupe by canonical (case-insensitive, trimmed) name: union all player_ids,
    // keep the canonical display name, and merge bats preferring 'Switch'.
    const batters = dedupeBatters(lookupCache.players.values());

    res.json({ batters, count: batters.length });
  } catch (error) {
    console.error('Error building batter list:', error.message);
    res.status(500).json({ error: 'batters_failed', message: error.message });
  }
};

/**
 * GET /api/batter/card
 * Returns scouting-card data for ONE batter, scoped to that batter's pitches.
 * This is the batter-first flow's data query: pitches are fetched with a
 * `batter_id` filter (a few hundred records), never the whole date-range space.
 * Response shape matches GET /api/teams/range ({ teamsData, metadata }) so the
 * client renders it through the same decode/aggregate path.
 * @query {string} batterIds - Comma-separated SLUGGER player UUID(s) for the chosen batter.
 * @query {string} [startDate] - Start date; defaults to season start.
 * @query {string} [endDate] - End date; defaults to today/season end.
 * @query {number} [maxVelocity] - Exclude pitches faster than this (mph).
 * @query {string} [pitchGroup] - 'All' | 'Fastballs' | 'Breaking' | 'Offspeed'.
 */
const batterCardHandler = async (req, res) => {
  try {
    const { batterIds, startDate, endDate, maxVelocity, pitchGroup } = req.query;

    const ids = (batterIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: 'missing_batter', message: 'Select a batter first.' });
    }

    const range = resolveDateRange(startDate, endDate);
    if (range.error) {
      return res.status(range.status).json({ error: range.error, message: range.message });
    }
    const { finalStartDate, finalEndDate } = range;

    console.log(`\nBatter card: ${ids.length} id(s), ${finalStartDate} → ${finalEndDate}`);

    // Scoped fetch — one query per id, merged. Never touches the full pitch space.
    let pitches = [];
    for (const id of ids) {
      const part = await fetchPitchesForBatter(id, finalStartDate, finalEndDate);
      if (part && part.length) pitches.push(...part);
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
};



// API health handler
const apiHealthHandler = (req, res) => {
  res.json({
    status: 'Server running',
    apiConfigured: true,
    cacheStatus: { players: lookupCache.players.size, teams: lookupCache.teams.size, ballparks: lookupCache.ballparks.size }
  });
};

// Register API routes at root level
app.get('/api/batters', battersHandler);
app.get('/api/batter/card', batterCardHandler);
app.get('/api/teams/range', teamsRangeHandler);
app.get('/api/health', apiHealthHandler);

// Also register API routes at BASE_PATH for ALB routing
if (BASE_PATH) {
  app.get(`${BASE_PATH}/api/batters`, battersHandler);
  app.get(`${BASE_PATH}/api/batter/card`, batterCardHandler);
  app.get(`${BASE_PATH}/api/teams/range`, teamsRangeHandler);
  app.get(`${BASE_PATH}/api/health`, apiHealthHandler);
}

// Error handling middleware for logging errors with stack traces (Requirement 5.4)
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${err.message}`);
  console.error(`[${timestamp}] Stack trace:`, err.stack);

  res.status(500).json({
    error: 'Internal server error',
    timestamp: timestamp
  });
});

// Environment-based port configuration for Lambda compatibility
const PORT = process.env.PORT || 8080;

async function startServer() {
  await populateLookupCaches(); // previously commented out?
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}/\n`);
  });
}

if (process.env.VERCEL) {
  setTimeout(() => {
    console.log('Background cache population started...');
    populateLookupCaches().catch(console.error);
  }, 1000);
}

module.exports = app;

// Test seam: when required as a module (never as the production entrypoint), expose
// the in-memory lookup cache so the unit suite can seed players without a network call.
if (require.main !== module) {
  app.__lookupCache = lookupCache;
}

if (require.main === module) {
  startServer().catch(console.error);
}
