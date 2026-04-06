require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

// Serve static files at both root and BASE_PATH
app.use(express.static('.'));
if (BASE_PATH) {
  app.use(BASE_PATH, express.static('.'));
}

const SLUGGER_CONFIG = {
  baseUrl: "https://1ywv9dczq5.execute-api.us-east-2.amazonaws.com/ALPBAPI",
  apiKey: process.env.SLUGGER_API_KEY 
};

const lookupCache = { players: new Map(), teams: new Map(), ballparks: new Map() };
const pitchDataCache = new Map(); // Cache pitch data by date

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
 * Fetches all pages from a paginated SLUGGER API endpoint (up to 10 pages / 10,000 records).
 * @param {string} endpoint - API path to paginate (e.g. '/pitches').
 * @param {Object} [params={}] - Additional query parameters merged into each page request.
 * @returns {Promise<Array>} Combined array of all records across all pages.
 */
async function fetchAllPages(endpoint, params = {}) {
  const MAX_PAGES = 500;
  let allData = [], page = 1, hasMore = true;
  while (hasMore && page <= MAX_PAGES) {
    const response = await sluggerRequest(endpoint, { ...params, page, limit: 1000 });
    if (response.success && response.data) {
      const items = Array.isArray(response.data) ? response.data : [response.data];
      allData = allData.concat(items);
      hasMore = items.length === 1000;
      if (hasMore) console.log(`  Fetching page ${page + 1} (${allData.length} records so far)...`);
      page++;
    } else hasMore = false;
  }
  if (page > MAX_PAGES) console.warn(`⚠️  fetchAllPages hit the ${MAX_PAGES}-page safety ceiling on ${endpoint}`);
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
 * Resolves a player ID to a display name using the in-memory cache.
 * @param {string} id - SLUGGER player UUID.
 * @returns {string} Player's full name, or a fallback identifier if not found.
 */
function getPlayerName(id) {
  return lookupCache.players.get(id)?.player_name || `Player-${id?.substring(0, 8) || 'Unknown'}`;
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
 * Fetches all pitch records for a date range from the SLUGGER API, with in-memory caching.
 * @param {string} startDateStr - Start date in YYYY-MM-DD format.
 * @param {string} endDateStr - End date in YYYY-MM-DD format.
 * @returns {Promise<Array>} Array of raw pitch objects, or empty array on error.
 */
async function fetchPitchesByDateRange(startDateStr, endDateStr) {
  const cacheKey = `${startDateStr}_${endDateStr}`;
  const cacheFile = path.join(__dirname, `cache_${startDateStr}_${endDateStr}.json`);

  if (pitchDataCache.has(cacheKey)) {
    const cached = pitchDataCache.get(cacheKey);
    console.log(`✅ Memory cache hit: returning ${cached.length} pitches for ${startDateStr} to ${endDateStr}`);
    return cached;
  }

  if (fs.existsSync(cacheFile)) {
    console.log(`💾 Disk cache hit: streaming ${cacheFile}`);
    const streamJsonDir = path.dirname(require.resolve('stream-json'));
    const streamArray = require(path.join(streamJsonDir, 'streamers', 'stream-array.js'));
    const filtered = await new Promise((resolve, reject) => {
      const items = [];
      const pipeline = streamArray.withParserAsStream();
      pipeline.on('data', ({ value }) => items.push(value));
      pipeline.on('finish', () => resolve(items));
      pipeline.on('error', reject);
      fs.createReadStream(cacheFile).pipe(pipeline);
    });
    console.log(`💾 Disk cache loaded: ${filtered.length} pitches`);
    pitchDataCache.set(cacheKey, filtered);
    return filtered;
  }

    console.log(`Fetching date range from SLUGGER API: ${startDateStr} to ${endDateStr}`);

    try {
        // This uses the legacy helper to automatically handle pagination if there are >1000 pitches!
        const pitches = await fetchAllPages('/pitches', {
            date_range_start: startDateStr,
            date_range_end: endDateStr
        });

        console.log(`✅ Success: Fetched ${pitches.length} pitches from API`);

        const filtered = pitches.filter(p => {
          const d = (p.date || '').slice(0, 10);
          return d >= startDateStr && d <= endDateStr;
        });
        console.log(`✅ After date filter (${startDateStr} → ${endDateStr}): ${filtered.length} pitches`);

        await new Promise((resolve, reject) => {
          const stream = fs.createWriteStream(cacheFile);
          stream.on('error', reject);
          stream.on('finish', resolve);
          stream.write('[');
          for (let i = 0; i < filtered.length; i++) {
            stream.write(JSON.stringify(filtered[i]));
            if (i < filtered.length - 1) stream.write(',');
          }
          stream.write(']');
          stream.end();
        });
        console.log(`💾 Disk cache written: ${cacheFile}`);

        pitchDataCache.set(cacheKey, filtered);
        return filtered;

    } catch (error) {
        console.error("❌ Error fetching from SLUGGER API:", error);
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
 * Transforms a flat array of raw pitch records into a structured teams → batters data object.
 * Computes per-batter stats, zone analysis, pitch sequences, and tendency labels.
 * @param {Array} pitchData - Raw pitch records from the SLUGGER API.
 * @param {Object} [existingData={}] - Existing teams data to merge into (used for incremental builds).
 * @param {number} [maxVelocity=999] - Pitches above this speed (mph) are excluded.
 * @returns {Object} Map of team name → array of batter stat objects.
 */
function transformPitchDataToTeams(pitchData, existingData = {}, maxVelocity = 999) {

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

    const batterKey = `${teamName}_${batterName}`;
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
        stats: { totalPitches: 0, strikes: 0, balls: 0, swings: 0, contact: 0, fouls: 0, whiffs: 0, firstPitchPitches: 0, firstPitchSwings: 0, weakContact: 0, hardContact: 0 },
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
      currentPA = { key: paKey, pitches: [], result: null, isFirstPitch: true };
      batterData.plateAppearances.push(currentPA);
    }

    const pitchType = getPitchAbbreviation(pitch.auto_pitch_type || pitch.tagged_pitch_type);
    currentPA.pitches.push({ type: pitchType, call: pitch.pitch_call, count: `${pitch.balls}-${pitch.strikes}` });

    batterData.stats.totalPitches++;
    if (currentPA.isFirstPitch) {
      batterData.stats.firstPitchPitches++;
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
        batterData.stats.firstPitchSwings++;
      }
      currentPA.isFirstPitch = false;
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
        // Get the last 2-3 pitches that led to this out
        const sequence = currentPA.pitches.slice(-3).map(p => p.type).join(' → ');
        const shortSeq = currentPA.pitches.slice(-2).map(p => p.type).join(' → ');

        batterData.outSequences.push({
          sequence: sequence,
          shortSequence: shortSeq,
          outType: pitch.k_or_bb === 'Strikeout' ? 'K' : pitch.play_result,
          pitchCount: currentPA.pitches.length
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
      if (!batterData.zoneAnalysis[zone]) {
        batterData.zoneAnalysis[zone] = { pitches: 0, swings: 0, whiffs: 0, fouls: 0, weakContact: 0, hardHits: 0, contact: 0 };
      }

      const zoneStats = batterData.zoneAnalysis[zone];
      zoneStats.pitches++;
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) zoneStats.swings++;
      if (pitch.pitch_call === 'StrikeSwinging') zoneStats.whiffs++;
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) zoneStats.fouls++;
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) zoneStats.contact++;
      if (pitch.exit_speed && pitch.pitch_call === 'InPlay') {
        if (pitch.exit_speed >= 95) zoneStats.hardHits++;
        else if (pitch.exit_speed < 70) zoneStats.weakContact++;
      }

      const xPos = 50 + (pitch.plate_loc_side * 25);
      const yPos = 100 - ((pitch.plate_loc_height - 1.5) / 2 * 100);
      let isGoodPitch = false;
      if (pitch.pitch_call === 'StrikeSwinging' || pitch.pitch_call === 'StrikeCalled') isGoodPitch = true;
      else if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) isGoodPitch = true;
      else if (pitch.exit_speed && pitch.exit_speed < 70) isGoodPitch = true;
      else if (pitch.pitch_call === 'BallCalled' || (pitch.exit_speed && pitch.exit_speed >= 95) || pitch.pitch_call === 'InPlay') isGoodPitch = false;

      batterData.pitchZones.push({
        position: [Math.max(0, Math.min(100, xPos)), Math.max(0, Math.min(100, yPos))],
        pitch: pitchType, good: isGoodPitch, zone: zone,
        pitcherThrows: pitch.pitcher_throws === 'Left' ? 'L' : 'R'
      });
    }
  });

  Object.values(teamsData).forEach(batters => {
    batters.forEach(batter => {
      if (batter.stats.totalPitches > 0) {
        if (batter.stats.firstPitchPitches > 0) {
          const rate = (batter.stats.firstPitchSwings / batter.stats.firstPitchPitches * 100);
          batter.tendencies.firstStrike = rate > 50 ? `Aggressive (${rate.toFixed(0)}%)` : `Patient (${rate.toFixed(0)}%)`;
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
            return 'Insufficient data';
          }

          const total = outSequences.length;

          // Count all sequences (both 2-pitch and 3-pitch)
          const sequenceCounts = {};

          outSequences.forEach(out => {
            // Prefer 3-pitch sequences if available
            const seq = out.pitchCount >= 3 ? out.sequence : out.shortSequence;
            sequenceCounts[seq] = (sequenceCounts[seq] || 0) + 1;
          });

          // Find sequences that appear at least twice OR represent 30%+ of outs
          const significantSequences = Object.entries(sequenceCounts)
            .filter(([seq, count]) => count >= 2 || (count / total) >= 0.3)
            .sort((a, b) => b[1] - a[1]);

          if (significantSequences.length > 0) {
            const [topSeq, count] = significantSequences[0];
            const pct = Math.round(count / total * 100);

            // Show top sequence with percentage
            let result = `${topSeq} (${count}/${total} = ${pct}%)`;

            // If there's a strong second pattern, mention it too
            if (significantSequences.length > 1 && significantSequences[1][1] >= 2) {
              const [secondSeq, secondCount] = significantSequences[1];
              const secondPct = Math.round(secondCount / total * 100);
              if (secondPct >= 25) {
                result += ` • Also: ${secondSeq} (${secondPct}%)`;
              }
            }

            return result;
          }

          // Fallback: if no clear pattern, show most common individual pitch that gets outs
          const finalPitches = {};
          outSequences.forEach(out => {
            const lastPitch = out.shortSequence.split(' → ').pop();
            finalPitches[lastPitch] = (finalPitches[lastPitch] || 0) + 1;
          });

          const topPitch = Object.entries(finalPitches).sort((a, b) => b[1] - a[1])[0];
          if (!topPitch) return 'Insufficient data';
          return `${topPitch[0]} gets outs (${topPitch[1]}/${total})`;
        }

        batter.powerSequence = batter.outSequences.length > 0
          ? analyzeOutSequences(batter.outSequences)
          : 'Insufficient data';
      }
    });
  });
  return teamsData;
}

/**
 * Maps a pitch's plate coordinates to a named strike zone (e.g. 'High-In', 'Mid-Out').
 * @param {number} plateSide - Horizontal plate position in feet (negative = catcher's left).
 * @param {number} plateHeight - Vertical plate position in feet above the ground.
 * @param {string} handedness - Batter handedness: 'LHB' or 'RHB'.
 * @returns {string} Zone label in the format '<Vertical>-<Horizontal>'.
 */
function getZoneFromLocation(plateSide, plateHeight, handedness) {
  const isInside = (handedness === 'LHB' && plateSide > 0.33) || (handedness === 'RHB' && plateSide < -0.33);
  const isOutside = (handedness === 'LHB' && plateSide < -0.33) || (handedness === 'RHB' && plateSide > 0.33);
  const horizontal = isInside ? 'In' : (isOutside ? 'Out' : 'Mid');
  const isHigh = plateHeight > 3.0, isLow = plateHeight < 2.0;
  const vertical = isHigh ? 'High' : (isLow ? 'Low' : 'Mid');
  return `${vertical}-${horizontal}`;
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
    const teamsData = transformPitchDataToTeams(pitches, {}, parsedMaxVelocity);
    
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
    
    res.json({ 
      teamsData, 
      metadata: { 
        startDate: finalStartDate, 
        endDate: finalEndDate, 
        filesProcessed: pitches.length,
        pitchesFilteredByVelocity: countPitchesByVelocity(pitches, parsedMaxVelocity)
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

    const zonesToDisplay = confidenceThreshold >= 75 ? 4 : confidenceThreshold >= 50 ? 8 : undefined;

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
        zonesDisplayed: zonesToDisplay ?? 'all',
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



// API health handler
const apiHealthHandler = (req, res) => {
  res.json({
    status: 'Server running',
    apiConfigured: true,
    cacheStatus: { players: lookupCache.players.size, teams: lookupCache.teams.size, ballparks: lookupCache.ballparks.size }
  });
};

// Register API routes at root level
app.get('/api/teams/range', teamsRangeHandler);
app.get('/api/health', apiHealthHandler);

// Also register API routes at BASE_PATH for ALB routing
if (BASE_PATH) {
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

if (require.main === module) {
  startServer().catch(console.error);
}
