const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// SLUGGER API Configuration
const SLUGGER_CONFIG = {
  baseUrl: process.env.SLUGGER_BASE_URL || "https://1ywv9dczq5.execute-api.us-east-2.amazonaws.com/ALPBAPI",
  apiKey: process.env.SLUGGER_API_KEY
};

// Cache for player and team lookups
const lookupCache = {
  players: new Map(),
  teams: new Map(),
  ballparks: new Map()
};

// Team name mapping (for display purposes)
const TEAM_DISPLAY_NAMES = {
  'YOR': 'York Revolution',
  'LI': 'Long Island Ducks',
  'LAN': 'Lancaster Stormers',
  'STA_YAN': 'Staten Island FerryHawks',
  'LEX_LEG': 'Lexington Legends',
  'WES_POW': 'Charleston Dirty Birds',
  'HP': 'High Point Rockers',
  'GAS': 'Gastonia Ghost Peppers',
  'SMD': 'Southern Maryland Blue Crabs',
  'HAG_FLY': 'Hagerstown Flying Boxcars'
};

// Helper function to make authenticated requests
async function sluggerRequest(endpoint, params = {}) {
  try {
    const response = await axios.get(`${SLUGGER_CONFIG.baseUrl}${endpoint}`, {
      headers: {
        'x-api-key': SLUGGER_CONFIG.apiKey,
        'Content-Type': 'application/json'
      },
      params: {
        ...params,
        limit: params.limit || 1000
      }
    });
    return response.data;
  } catch (error) {
    console.error(`Error calling ${endpoint}:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

// Populate lookup caches on server start
async function populateLookupCaches() {
  console.log('Populating lookup caches from SLUGGER API...');
  
  try {
    // Fetch players
    console.log('Fetching players...');
    const playersResponse = await sluggerRequest('/players', { limit: 10000 });
    if (playersResponse.success && playersResponse.data) {
      const players = Array.isArray(playersResponse.data) ? playersResponse.data : [playersResponse.data];
      players.forEach(player => {
        if (player.player_id && player.player_name) {
          lookupCache.players.set(player.player_id, player);
        }
      });
      console.log(`✅ Cached ${lookupCache.players.size} players`);
    }
    
    // Fetch teams
    console.log('Fetching teams...');
    const teamsResponse = await sluggerRequest('/teams', { limit: 1000 });
    if (teamsResponse.success && teamsResponse.data) {
      const teams = Array.isArray(teamsResponse.data) ? teamsResponse.data : [teamsResponse.data];
      teams.forEach(team => {
        if (team.team_code && team.team_name) {
          lookupCache.teams.set(team.team_code, team);
        }
      });
      console.log(`✅ Cached ${lookupCache.teams.size} teams`);
    }
    
    // Fetch ballparks
    console.log('Fetching ballparks...');
    const ballparksResponse = await sluggerRequest('/ballparks', { limit: 1000 });
    if (ballparksResponse.success && ballparksResponse.data) {
      const ballparks = Array.isArray(ballparksResponse.data) ? ballparksResponse.data : [ballparksResponse.data];
      ballparks.forEach(ballpark => {
        if (ballpark.ballpark_name) {
          lookupCache.ballparks.set(ballpark.ballpark_name, ballpark);
        }
      });
      console.log(`✅ Cached ${lookupCache.ballparks.size} ballparks`);
    }
    
    console.log('✅ Cache population complete!');
  } catch (error) {
    console.error('❌ Error populating caches:', error.message);
  }
}

// Helper function to get player name from ID
function getPlayerName(playerId) {
  const player = lookupCache.players.get(playerId);
  return player?.player_name || `Player-${playerId?.substring(0, 8) || 'Unknown'}`;
}

// Helper function to get full team name from code
function getTeamName(teamCode) {
  // First try the lookup cache
  const team = lookupCache.teams.get(teamCode);
  if (team?.team_name) return team.team_name;
  
  // Fall back to display names mapping
  return TEAM_DISPLAY_NAMES[teamCode] || teamCode;
}

// Helper function to fetch all pages of pitch data
async function fetchAllPitches(params) {
  let allPitches = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await sluggerRequest('/pitches', {
      ...params,
      page,
      order: 'ASC'
    });

    if (response.success && response.data) {
      const pitches = Array.isArray(response.data) ? response.data : [response.data];
      allPitches = allPitches.concat(pitches);
      
      hasMore = pitches.length === (params.limit || 1000);
      page++;
      
      console.log(`  Page ${page - 1}: ${pitches.length} pitches (total: ${allPitches.length})`);
    } else {
      hasMore = false;
    }
  }

  return allPitches;
}

function transformPitchDataToTeams(pitchData, existingData = {}) {
  const teamsData = { ...existingData };
  const batterMap = new Map();

  // Initialize batterMap with existing data
  Object.entries(teamsData).forEach(([team, batters]) => {
    batters.forEach(batter => {
      const key = `${team}_${batter.batter}`;
      batterMap.set(key, batter);
    });
  });

  pitchData.forEach(pitch => {
    // Extract info using the ACTUAL API structure (flat, not nested)
    const batterName = getPlayerName(pitch.batter_id);
    const teamName = getTeamName(pitch.batter_team_code);
    const pitcherName = getPlayerName(pitch.pitcher_id);
    
    if (!batterName || !teamName || !pitcherName) return;

    const batterKey = `${teamName}_${batterName}`;

    if (!teamsData[teamName]) {
      teamsData[teamName] = [];
    }

    let batterData = batterMap.get(batterKey);
    
    if (!batterData) {
      batterData = {
        batter: batterName,
        handedness: pitch.batter_side === 'Left' ? 'LHB' : 'RHB',
        pitcher: pitcherName,
        pitcherThrows: pitch.pitcher_throws === 'Left' ? 'LHP' : 'RHP',
        context: `${pitch.top_or_bottom || 'Top'} ${pitch.inning || 1}, ${pitch.balls || 0}-${pitch.strikes || 0}`,
        battingOrder: pitch.pa_of_inning || teamsData[teamName].length + 1,
        pitchZones: [],
        zoneAnalysis: {},
        stats: {
          totalPitches: 0,
          strikes: 0,
          balls: 0,
          swings: 0,
          contact: 0,
          fouls: 0,
          whiffs: 0,
          firstPitchPitches: 0,
          firstPitchSwings: 0,
          weakContact: 0,
          hardContact: 0
        },
        plateAppearances: [],
        atBats: [],
        stolenBases: 0,
        caughtStealing: 0,
        bunts: 0,
        strikeoutSequences: [],
        tendencies: {
          firstStrike: 'Calculating...',
          buntThreat: 'Low',
          stealThreat: 'Low',
          spray: 'All fields'
        },
        powerSequence: 'Calculating...'
      };
      
      batterMap.set(batterKey, batterData);
      teamsData[teamName].push(batterData);
    }

    // Track plate appearances
    const paKey = `${pitch.inning}_${pitch.pa_of_inning}`;
    let currentPA = batterData.plateAppearances.find(pa => pa.key === paKey);
    
    if (!currentPA) {
      currentPA = {
        key: paKey,
        pitches: [],
        result: null,
        isFirstPitch: true
      };
      batterData.plateAppearances.push(currentPA);
    }

    const pitchType = getPitchAbbreviation(pitch.tagged_pitch_type || pitch.auto_pitch_type);
    currentPA.pitches.push({
      type: pitchType,
      call: pitch.pitch_call,
      count: `${pitch.balls}-${pitch.strikes}`
    });

    // Update stats
    batterData.stats.totalPitches++;
    
    if (currentPA.isFirstPitch) {
      batterData.stats.firstPitchPitches++;
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
        batterData.stats.firstPitchSwings++;
      }
      currentPA.isFirstPitch = false;
    }
    
    if (['StrikeCalled', 'StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) {
      batterData.stats.strikes++;
    }
    if (pitch.pitch_call === 'BallCalled') {
      batterData.stats.balls++;
    }
    if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
      batterData.stats.swings++;
    }
    if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
      batterData.stats.contact++;
    }
    if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) {
      batterData.stats.fouls++;
    }
    if (pitch.pitch_call === 'StrikeSwinging') {
      batterData.stats.whiffs++;
    }

    if (pitch.exit_speed && pitch.pitch_call === 'InPlay') {
      if (pitch.exit_speed >= 95) {
        batterData.stats.hardContact++;
      } else if (pitch.exit_speed < 70) {
        batterData.stats.weakContact++;
      }
    }

    // Handle play results
    if (pitch.play_result && pitch.play_result !== 'Undefined') {
      currentPA.result = pitch.play_result;
      
      if (pitch.play_result.includes('StolenBase') || pitch.k_or_bb === 'Stolen Base') {
        batterData.stolenBases++;
      }
      if (pitch.play_result.includes('CaughtStealing')) {
        batterData.caughtStealing++;
      }
      
      if (pitch.play_result.includes('Bunt') || pitch.pitch_call.includes('Bunt')) {
        batterData.bunts++;
      }
      
      if (pitch.pitch_call === 'InPlay' && pitch.angle !== null && pitch.exit_speed) {
        batterData.atBats.push({
          angle: pitch.angle,
          distance: pitch.distance || 0,
          exitSpeed: pitch.exit_speed,
          result: pitch.play_result
        });
      }
    }

    // Track strikeout sequences
    if (pitch.k_or_bb === 'Strikeout' && currentPA.pitches.length >= 2) {
      const lastTwo = currentPA.pitches.slice(-2);
      batterData.strikeoutSequences.push(
        `${lastTwo[0].type} → ${lastTwo[1].type}`
      );
    }

    // Zone analysis
    if (pitch.plate_loc_side !== null && pitch.plate_loc_height !== null) {
      const zone = getZoneFromLocation(pitch.plate_loc_side, pitch.plate_loc_height, batterData.handedness);
      
      if (!batterData.zoneAnalysis[zone]) {
        batterData.zoneAnalysis[zone] = {
          pitches: 0,
          swings: 0,
          whiffs: 0,
          fouls: 0,
          weakContact: 0,
          hardHits: 0,
          contact: 0
        };
      }
      
      const zoneStats = batterData.zoneAnalysis[zone];
      zoneStats.pitches++;
      
      if (['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
        zoneStats.swings++;
      }
      if (pitch.pitch_call === 'StrikeSwinging') {
        zoneStats.whiffs++;
      }
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) {
        zoneStats.fouls++;
      }
      if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'].includes(pitch.pitch_call)) {
        zoneStats.contact++;
      }
      if (pitch.exit_speed && pitch.pitch_call === 'InPlay') {
        if (pitch.exit_speed >= 95) {
          zoneStats.hardHits++;
        } else if (pitch.exit_speed < 70) {
          zoneStats.weakContact++;
        }
      }

      // Calculate position for visualization
      const xPos = 50 + (pitch.plate_loc_side * 25);
      const yPos = 100 - ((pitch.plate_loc_height - 1.5) / 2 * 100);
      
      let isGoodPitch = false;
      
      if (pitch.pitch_call === 'StrikeSwinging') {
        isGoodPitch = true;
      } else if (pitch.pitch_call === 'StrikeCalled') {
        isGoodPitch = true;
      } else if (['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable'].includes(pitch.pitch_call)) {
        isGoodPitch = true;
      } else if (pitch.exit_speed && pitch.exit_speed < 70) {
        isGoodPitch = true;
      } else if (pitch.pitch_call === 'BallCalled') {
        isGoodPitch = false;
      } else if (pitch.exit_speed && pitch.exit_speed >= 95) {
        isGoodPitch = false;
      } else if (pitch.pitch_call === 'InPlay') {
        isGoodPitch = false;
      }

      batterData.pitchZones.push({
        position: [
          Math.max(0, Math.min(100, xPos)),
          Math.max(0, Math.min(100, yPos))
        ],
        pitch: pitchType,
        good: isGoodPitch,
        zone: zone
      });
    }
  });

  // Calculate tendencies
  Object.values(teamsData).forEach(batters => {
    batters.forEach(batter => {
      if (batter.stats.totalPitches > 0) {
        if (batter.stats.firstPitchPitches > 0) {
          const firstPitchSwingRate = (batter.stats.firstPitchSwings / batter.stats.firstPitchPitches * 100);
          batter.tendencies.firstStrike = firstPitchSwingRate > 50 ? 
            `Aggressive (${firstPitchSwingRate.toFixed(0)}%)` : 
            `Patient (${firstPitchSwingRate.toFixed(0)}%)`;
        }
        
        const stealAttempts = batter.stolenBases + batter.caughtStealing;
        if (stealAttempts >= 3) {
          const successRate = (batter.stolenBases / stealAttempts * 100).toFixed(0);
          batter.tendencies.stealThreat = `High (${batter.stolenBases}/${stealAttempts} - ${successRate}%)`;
        } else if (stealAttempts > 0) {
          batter.tendencies.stealThreat = `Moderate (${batter.stolenBases}/${stealAttempts})`;
        } else {
          batter.tendencies.stealThreat = 'Low';
        }
        
        if (batter.bunts >= 3) {
          batter.tendencies.buntThreat = `High (${batter.bunts} bunts)`;
        } else if (batter.bunts > 0) {
          batter.tendencies.buntThreat = `Moderate (${batter.bunts} bunts)`;
        } else {
          batter.tendencies.buntThreat = 'Low';
        }
        
        if (batter.atBats.length >= 5) {
          const pullCount = batter.atBats.filter(ab => {
            if (batter.handedness === 'LHB') return ab.angle < -15;
            else return ab.angle > 15;
          }).length;
          
          const oppoCount = batter.atBats.filter(ab => {
            if (batter.handedness === 'LHB') return ab.angle > 15;
            else return ab.angle < -15;
          }).length;
          
          const pullPct = (pullCount / batter.atBats.length * 100);
          const oppoPct = (oppoCount / batter.atBats.length * 100);
          
          if (pullPct > 60) {
            batter.tendencies.spray = `Pull hitter (${pullPct.toFixed(0)}%)`;
          } else if (oppoPct > 40) {
            batter.tendencies.spray = `Opposite field (${oppoPct.toFixed(0)}%)`;
          } else {
            batter.tendencies.spray = `All fields (P:${pullPct.toFixed(0)}% O:${oppoPct.toFixed(0)}%)`;
          }
        }
        
        if (batter.strikeoutSequences.length > 0) {
          const sequenceCounts = {};
          batter.strikeoutSequences.forEach(seq => {
            sequenceCounts[seq] = (sequenceCounts[seq] || 0) + 1;
          });
          const mostCommon = Object.entries(sequenceCounts)
            .sort((a, b) => b[1] - a[1])[0];
          batter.powerSequence = `${mostCommon[0]} (${mostCommon[1]}x)`;
        }
      }
    });
  });

  return teamsData;
}

function getZoneFromLocation(plateSide, plateHeight, handedness) {
  const isInside = (handedness === 'LHB' && plateSide > 0.33) || 
                   (handedness === 'RHB' && plateSide < -0.33);
  const isOutside = (handedness === 'LHB' && plateSide < -0.33) || 
                    (handedness === 'RHB' && plateSide > 0.33);
  
  const horizontal = isInside ? 'In' : (isOutside ? 'Out' : 'Mid');
  
  const isHigh = plateHeight > 3.0;
  const isLow = plateHeight < 2.0;
  const vertical = isHigh ? 'High' : (isLow ? 'Low' : 'Mid');
  
  return `${vertical}-${horizontal}`;
}

function getPitchAbbreviation(pitchType) {
  if (!pitchType || pitchType === 'Undefined') return 'FB';
  
  const abbrev = {
    'Fastball': 'FB',
    'Four-Seam': '4S',
    'TwoSeamFastball': '2S',
    'Sinker': 'SI',
    'Cutter': 'FC',
    'Slider': 'SL',
    'Curveball': 'CB',
    'Changeup': 'CH',
    'ChangeUp': 'CH',
    'Splitter': 'SP',
    'Knuckleball': 'KN'
  };
  
  return abbrev[pitchType] || 'FB';
}

// API Routes

app.get('/api/teams/range', async (req, res) => {
  try {
    const { startDate, endDate, maxVelocity, pitchGroup } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    console.log(`\n📊 Fetching data from ${startDate} to ${endDate}`);
    
    // Convert YYYYMMDD to YYYY-MM-DD format
    const formattedStartDate = `${startDate.substring(0, 4)}-${startDate.substring(4, 6)}-${startDate.substring(6, 8)}`;
    const formattedEndDate = `${endDate.substring(0, 4)}-${endDate.substring(4, 6)}-${endDate.substring(6, 8)}`;
    
    console.log(`  API format: ${formattedStartDate} to ${formattedEndDate}`);
    
    // Fetch all pitches for the date range
    // Fetch all pitches for the date range
    const pitches = await fetchAllPitches({
      date_range_start: formattedStartDate,
      date_range_end: formattedEndDate
    });
    
    console.log(`✅ Fetched ${pitches.length} total pitches`);

    // --- RYAN DULL FEATURE: FILTER PITCHES ---
    let filteredPitches = pitches;
    
    if (maxVelocity && parseFloat(maxVelocity) < 105) {
       filteredPitches = filteredPitches.filter(p => !p.rel_speed || p.rel_speed <= parseFloat(maxVelocity));
    }

    if (pitchGroup && pitchGroup !== 'All') {
       const fastballs = ['Fastball', 'Four-Seam', 'TwoSeamFastball', 'Sinker', 'Cutter'];
       const breaking = ['Slider', 'Curveball', 'KnuckleCurve', 'Sweeper']; 
       const offspeed = ['Changeup', 'ChangeUp', 'Splitter', 'Knuckleball'];
       
       filteredPitches = filteredPitches.filter(p => {
          const pt = p.tagged_pitch_type || p.auto_pitch_type;
          if (pitchGroup === 'Fastballs') return fastballs.includes(pt);
          if (pitchGroup === 'Breaking') return breaking.includes(pt);
          if (pitchGroup === 'Offspeed') return offspeed.includes(pt);
          return true;
       });
       console.log(`🎯 Filtered down to ${filteredPitches.length} ${pitchGroup} pitches`);
    }
    // -----------------------------------------

    console.log(`⚙️  Transforming pitch data to team format...`);
    
    const teamsData = transformPitchDataToTeams(filteredPitches);
    
    const teamCount = Object.keys(teamsData).length;
    const playerCount = Object.values(teamsData).reduce((sum, team) => sum + team.length, 0);
    
    console.log(`✅ Transformation complete: ${teamCount} teams, ${playerCount} players\n`);
    
    res.json({
      teamsData,
      metadata: {
        startDate,
        endDate,
        filesProcessed: pitches.length,
        filesSkipped: 0
      }
    });
  } catch (error) {
    console.error('❌ Error fetching range data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch data',
      details: error.message 
    });
  }
});

app.get('/api/game/:date/:stadium', async (req, res) => {
  try {
    const { date, stadium } = req.params;
    
    // Convert YYYYMMDD to YYYY-MM-DD format
    const formattedDate = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
    
    console.log(`\n📊 Fetching game data for ${formattedDate} at ${stadium}`);
    
    // Fetch pitches for specific game
    const pitches = await fetchAllPitches({
      date: formattedDate,
      ballpark_name: stadium
    });
    
    console.log(`✅ Fetched ${pitches.length} pitches for game`);
    
    const teamsData = transformPitchDataToTeams(filteredPitches);
    
    res.json(teamsData);
  } catch (error) {
    console.error('❌ Error fetching game data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch game data',
      details: error.message 
    });
  }
});

app.get('/api/games/range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    // Convert dates
    const formattedStartDate = `${startDate.substring(0, 4)}-${startDate.substring(4, 6)}-${startDate.substring(6, 8)}`;
    const formattedEndDate = `${endDate.substring(0, 4)}-${endDate.substring(4, 6)}-${endDate.substring(6, 8)}`;
    
    console.log(`\n📅 Fetching games list from ${formattedStartDate} to ${formattedEndDate}`);
    
    // Fetch games
    const response = await sluggerRequest('/games', {
      date_range_start: formattedStartDate,
      date_range_end: formattedEndDate,
      limit: 1000
    });
    
    const games = Array.isArray(response.data) ? response.data : [response.data];
    
    const formattedGames = games.map(game => ({
      date: game.date.replace(/-/g, ''),
      stadium: game.ballpark_name || 'Unknown',
      filename: `${game.date}-${game.ballpark_name}_unverified.csv`
    }));
    
    console.log(`✅ Found ${formattedGames.length} games\n`);
    
    res.json({ games: formattedGames });
  } catch (error) {
    console.error('❌ Error listing games:', error);
    res.status(500).json({ 
      error: 'Failed to list games',
      details: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'Server is running',
    apiConfigured: !!SLUGGER_CONFIG.apiKey && SLUGGER_CONFIG.apiKey !== 'your-api-key-here',
    cacheStatus: {
      players: lookupCache.players.size,
      teams: lookupCache.teams.size,
      ballparks: lookupCache.ballparks.size
    }
  });
});

const PORT = process.env.PORT || 3000;

// Initialize server
async function startServer() {
  console.log('🚀 Starting Baseball Scouting Server...\n');
  
  await populateLookupCaches();
  
  app.listen(PORT, () => {
    console.log(`\n✅ Server running on http://localhost:${PORT}/`);
    console.log(`📡 API Base URL: ${SLUGGER_CONFIG.baseUrl}`);
    console.log(`🔑 API Key configured: ${SLUGGER_CONFIG.apiKey !== 'your-api-key-here'}\n`);
    console.log(`Ready to process requests! 🎯\n`);
  });
}

startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});