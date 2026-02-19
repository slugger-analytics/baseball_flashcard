const express = require('express');
const cors = require('cors');
const axios = require('axios');

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
  apiKey: "ojgvHrY7Pu4qoE4GDsmxJ1TPZnYa9qwfL9fnI072" //Paste Key here
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

async function sluggerRequest(endpoint, params = {}) {
  const response = await axios.get(`${SLUGGER_CONFIG.baseUrl}${endpoint}`, {
    headers: { 'x-api-key': SLUGGER_CONFIG.apiKey, 'Content-Type': 'application/json' },
    params: { ...params, limit: params.limit || 1000 }
  });
  return response.data;
}

async function fetchAllPages(endpoint, params = {}) {
  let allData = [], page = 1, hasMore = true;
  while (hasMore && page <= 10) {
    const response = await sluggerRequest(endpoint, { ...params, page, limit: 1000 });
    if (response.success && response.data) {
      const items = Array.isArray(response.data) ? response.data : [response.data];
      allData = allData.concat(items);
      hasMore = items.length === 1000;
      page++;
    } else hasMore = false;
  }
  return allData;
}

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

function getPlayerName(id) {
  return lookupCache.players.get(id)?.player_name || `Player-${id?.substring(0, 8) || 'Unknown'}`;
}

function getTeamName(code) {
  return lookupCache.teams.get(code)?.team_name || TEAM_DISPLAY_NAMES[code] || code;
}

// Known dates with actual game data (from our data exploration)
const DATES_WITH_DATA = new Set([
  '2024-05-03', '2024-05-04', '2024-05-05', '2024-05-06', '2024-05-07', '2024-05-08', '2024-05-09',
  '2024-05-10', '2024-05-11', '2024-05-12', '2024-05-14', '2024-05-15', '2024-05-16', '2024-05-17',
  '2024-05-18', '2024-05-19', '2024-05-21', '2024-05-22', '2024-05-23', '2024-05-24', '2024-05-25',
  '2024-05-26', '2024-05-27', '2024-05-28', '2024-05-29', '2024-05-30', '2024-05-31',
  '2024-06-01', '2024-06-02', '2024-06-04', '2024-06-05', '2024-06-06', '2024-06-07', '2024-06-08',
  '2024-06-09', '2024-06-11', '2024-06-12', '2024-06-13', '2024-06-14', '2024-06-15', '2024-06-16',
  '2024-06-18', '2024-06-19', '2024-06-20', '2024-06-21', '2024-06-22', '2024-06-23', '2024-06-25',
  '2024-06-26', '2024-06-27', '2024-06-28', '2024-06-29', '2024-06-30',
  '2024-07-02', '2024-07-03', '2024-07-04', '2024-07-05', '2024-07-06', '2024-07-07', '2024-07-09',
  '2024-07-10', '2024-07-11', '2024-07-12', '2024-07-13', '2024-07-14', '2024-07-16', '2024-07-17',
  '2024-07-18', '2024-07-19', '2024-07-20', '2024-07-21', '2024-07-23', '2024-07-31',
  '2024-08-04',
  '2025-04-25', '2025-04-26', '2025-04-27', '2025-04-28', '2025-04-29', '2025-04-30'
]);

// OPTIMIZED: Only fetch dates that have actual game data
async function fetchPitchesByDateRange(startDateStr, endDateStr) {
  console.log(`Fetching date range: ${startDateStr} to ${endDateStr}`);
  const startDate = new Date(startDateStr), endDate = new Date(endDateStr);
  const allDates = [];
  let currentDate = new Date(startDate);

  // Build list of all dates in range
  while (currentDate <= endDate) {
    allDates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // Filter to only dates with known data
  const datesToFetch = allDates.filter(d => DATES_WITH_DATA.has(d));

  console.log(`  Total dates in range: ${allDates.length}`);
  console.log(`  Dates with data: ${datesToFetch.length}`);
  console.log(`  Skipping ${allDates.length - datesToFetch.length} empty dates`);

  if (datesToFetch.length === 0) {
    console.log(`⚠️  WARNING: No known game dates in this range!`);
    console.log(`   Try: 2024-05-01 to 2024-05-31 (May 2024)`);
    console.log(`   Or:  2024-06-01 to 2024-06-30 (June 2024)`);
    return [];
  }

  // Fetch in LARGER batches of 30 for speed
  const BATCH_SIZE = 30;
  const allPitches = [];
  const startTime = Date.now();

  for (let i = 0; i < datesToFetch.length; i += BATCH_SIZE) {
    const batch = datesToFetch.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(datesToFetch.length / BATCH_SIZE);

    console.log(`  [Batch ${batchNum}/${totalBatches}] Fetching ${batch.length} dates...`);

    const fetchPromises = batch.map(async (dateStr) => {
      // Check cache first
      if (pitchDataCache.has(dateStr)) {
        return pitchDataCache.get(dateStr);
      }

      try {
        const pitches = await fetchAllPages('/pitches', { date: dateStr, order: 'ASC' });
        if (pitches.length > 0) {
          console.log(`    ✅ ${dateStr}: ${pitches.length}`);
        }
        pitchDataCache.set(dateStr, pitches);
        return pitches;
      } catch (error) {
        console.log(`    ❌ ${dateStr}: ${error.message}`);
        return [];
      }
    });

    const batchResults = await Promise.all(fetchPromises);
    allPitches.push(...batchResults.flat());

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const pitchCount = allPitches.length;
    console.log(`    Progress: ${pitchCount.toLocaleString()} pitches in ${elapsed}s`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ Complete: ${allPitches.length.toLocaleString()} pitches from ${datesToFetch.length} dates in ${totalTime}s\n`);
  return allPitches;
}

// Better steal threat assessment
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
      ab.exitSpeed < 90 && ab.angle < 15 && ab.result === 'Single'
    ).length;
    if (speedHits >= 2) {
      stealScore += 1;
      reasons.push('beats out grounders');
    }

    // Very high exit velo on grounders = leg speed
    const fastGrounders = batter.atBats.filter(ab =>
      ab.exitSpeed >= 95 && ab.angle < 10
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

// Better bunt threat assessment
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

// (Task for VF): #4 fourth change was I added the minVelocity as a parameter to filter out pitches that don't meet 
// the minimum velocity requirement before processing them into teams.
function transformPitchDataToTeams(pitchData, existingData = {}, minVelocity = 0) {
  const teamsData = { ...existingData }, batterMap = new Map();
  Object.entries(teamsData).forEach(([team, batters]) => {
    batters.forEach(batter => batterMap.set(`${team}_${batter.batter}`, batter));
  });

  pitchData.forEach(pitch => {

    // (Task for VF): #5 fifth change ok here is the velocity filtering logic:
    // we parse the pitch speed from the api data, using rel_speed or release_speed as the source and we defaulting to 0 if neither is available
    const pitchSpeed = parseFloat(pitch.rel_speed || pitch.release_speed  || 0);
    // if a min velocity limit is requested and this pitch is slower than the limit, we skip it.
    if (minVelocity > 0 && pitchSpeed < minVelocity) {
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
      const isOut = ['Out', 'Strikeout', 'FieldersChoice', 'DoublePlay', 'TriplePlay', 'Flyout', 'Groundout', 'Lineout', 'Popout'].some(outType =>
        pitch.play_result.includes(outType) || pitch.k_or_bb === 'Strikeout'
      );

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
      if (pitch.pitch_call === 'InPlay' && pitch.angle !== null && pitch.exit_speed) {
        batterData.atBats.push({ angle: pitch.angle, distance: pitch.distance || 0, exitSpeed: pitch.exit_speed, result: pitch.play_result });
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
        pitch: pitchType, good: isGoodPitch, zone: zone
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
          const pullCount = batter.atBats.filter(ab => batter.handedness === 'LHB' ? ab.angle < -15 : ab.angle > 15).length;
          const oppoCount = batter.atBats.filter(ab => batter.handedness === 'LHB' ? ab.angle > 15 : ab.angle < -15).length;
          const pullPct = (pullCount / batter.atBats.length * 100);
          const oppoPct = (oppoCount / batter.atBats.length * 100);
          if (pullPct > 60) batter.tendencies.spray = `Pull hitter (${pullPct.toFixed(0)}%)`;
          else if (oppoPct > 40) batter.tendencies.spray = `Opposite field (${oppoPct.toFixed(0)}%)`;
          else batter.tendencies.spray = `All fields (P:${pullPct.toFixed(0)}% O:${oppoPct.toFixed(0)}%)`;
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
          return `${topPitch[0]} gets outs (${topPitch[1]}/${total})`;
        }

        if (batter.outSequences.length > 0) {
          batter.powerSequence = analyzeOutSequences(batter.outSequences);
        }
      }
    });
  });
  return teamsData;
}

function getZoneFromLocation(plateSide, plateHeight, handedness) {
  const isInside = (handedness === 'LHB' && plateSide > 0.33) || (handedness === 'RHB' && plateSide < -0.33);
  const isOutside = (handedness === 'LHB' && plateSide < -0.33) || (handedness === 'RHB' && plateSide > 0.33);
  const horizontal = isInside ? 'In' : (isOutside ? 'Out' : 'Mid');
  const isHigh = plateHeight > 3.0, isLow = plateHeight < 2.0;
  const vertical = isHigh ? 'High' : (isLow ? 'Low' : 'Mid');
  return `${vertical}-${horizontal}`;
}

function getPitchAbbreviation(pitchType) {
  if (!pitchType || pitchType === 'Undefined') return 'FB';
  const abbrev = { 'Fastball': 'FB', 'Four-Seam': '4S', 'TwoSeamFastball': '2S', 'Sinker': 'SI', 'Cutter': 'FC', 'Slider': 'SL', 'Curveball': 'CB', 'Changeup': 'CH', 'ChangeUp': 'CH', 'Splitter': 'SP', 'Knuckleball': 'KN' };
  return abbrev[pitchType] || 'FB';
}

// API route handler for teams/range
const teamsRangeHandler = async (req, res) => {
  try {
    // (Task for Velocity Filter): #1 first change for the velocity filter logic is to add the minVelocity to the extracted query parameters.
    const { startDate, endDate, minVelocity } = req.query;

    // (Task for Dynamic Time Period Filtering (ALPB Logic)):
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth(); // 0 is january, 11 is december

    // (Task for DTPF): #1 first is to determine the target season year using if/else
    let targetYear;
      if (currentMonth < 3) {
        // so if we are in jan, feb, or march (0, 1, 2), the ALPB season hasnt started yet.
        // so we need to look at last year's data:
        targetYear = currentYear - 1;
      } else {
        // if we are in any other month like april thru december, we want to look at the current year's data
        targetYear = currentYear;
      }
    
    // (Task for DTPF): #2 second this is to define some sort of safety net start date for the ALPB
    // Start is always going to be april 15th of our target year in order to catch the alpb opening day
    // even it starts on different days each year, this will ensure we are always capturing the start of the season. We can adjust this date as needed if we find that there are games being missed at the beginning of the season.
    // alpb start dates for the last 4 years (april, 25, 25, 28, 21) so april 15th is a safe bet to always be before the season starts.
    const defaultStart = `${targetYear}0415`; // April 15th of target year
    
    // (Task for DTPF): #3 determine the end date
    let defaultEnd;
      // if its before april (jan - march) or after october (nov-dec) its the Off-Season.
      if (currentMonth > 3 || currentMonth < 9) {
        // it the offeseason so cap the search at oct 15 to safley include the ALPB championship.
        defaultEnd = `${targetYear}1015`; // October 15th of target year
      } else {
        // we are actively in the season (April through October). Use Today's exact date
        const currentMonthFormatted = String(currentMonth + 1).padStart(2, '0');
        const currentDayFormatted = String(today.getDate()).padStart(2, '0');
        defaultEnd = `${targetYear}${currentMonthFormatted}${currentDayFormatted}`;
      }
    
    // (Task for DTPF): #4 apply the coaches input (like use their dates if they types them in)
    let finalStartDate;
    if (startDate) {
      finalStartDate = startDate;
    } else {
      finalStartDate = defaultStart;
    }

    let finalEndDate;
    if (endDate) {
      finalEndDate = endDate;
    } else {
      finalEndDate = defaultEnd;
    }

    //clean log
    console.log(`\nFetching ${finalStartDate} to ${finalEndDate}`); 

    // Commented this out b/c this is acting like a strict error check. If the frontend sends blank dates (e.g., clicking "Full Season"), 
    // we want to fall back to the default dates below instead of just crashing the app: 
    // if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });
    
    const formattedStart = `${finalStartDate.substring(0, 4)}-${finalStartDate.substring(4, 6)}-${finalStartDate.substring(6, 8)}`;
    const formattedEnd = `${finalEndDate.substring(0, 4)}-${finalEndDate.substring(4, 6)}-${finalEndDate.substring(6, 8)}`;

    const pitches = await fetchPitchesByDateRange(formattedStart, formattedEnd);
    
    // (Task for VF): #2 second change is adding a safe parsing logic to convert the minVelocity string into a number (defaulting to 0).
    let parsedMinVelocity;
    if (minVelocity) {
      parsedMinVelocity = parseFloat(minVelocity);
    } else {
      parsedMinVelocity = 0;
    }

    // (Task for VF): #3 third change is to passed the parsedMinVelocity to the transformPitchDataToTeams function, which will now filter 
    // out any pitches that don't meet the minimum velocity requirement before processing them into teams.
    const teamsData = transformPitchDataToTeams(pitches, {}, parsedMinVelocity);

    const teamCount = Object.keys(teamsData).length;
    const playerCount = Object.values(teamsData).reduce((sum, team) => sum + team.length, 0);
    console.log(`✅ Complete: ${teamCount} teams, ${playerCount} players\n`);

    res.json({ teamsData, metadata: { startDate: finalStartDate, endDate: finalEndDate, filesProcessed: pitches.length, filesSkipped: 0 } });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch data', details: error.message });
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
  await populateLookupCaches();
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}/\n`);
  });
}

startServer().catch(console.error);