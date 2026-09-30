'use strict';

require('dotenv').config({ quiet: true });
const axios = require('axios');
const {
  REGIME_PRIOR,
  REGIME_EDGE,
  REGIMES,
  SENSITIVITY_MULTIPLIER,
  expectedWinRate,
  zoneRegime,
  pitchFamily,
  getZoneFromLocation,
} = require('../pitch_logic.js');

const API_URL = 'https://1ywv9dczq5.execute-api.us-east-2.amazonaws.com/ALPBAPI';
const PAGE_SIZE = 1000;
const PAGE_BATCH = 6;
const TRAIN_START = '2025-04-25';
const TRAIN_END = '2025-07-31';
const VALIDATE_START = '2025-08-01';
const VALIDATE_END = '2025-09-18';
const TEST_START = '2026-04-21';
const TEST_END = '2026-09-13';
const PRIOR_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const MIN_BUCKET_PITCHES = [3, 5, 8, 12];
const SENSITIVITY_LEVELS = [1, 2, 3, 4, 5];
const WIN_CALLS = new Set(['StrikeSwinging', 'StrikeCalled', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable']);
const OUTS = new Set(['Out', 'FieldersChoice', 'Sacrifice']);
const HITS = new Set(['Single', 'Double', 'Triple', 'HomeRun']);
const PITCH_ABBREVIATIONS = {
  Fastball: 'FB', FourSeam: '4S', 'Four-Seam': '4S', TwoSeamFastball: '2S',
  Sinker: 'Si', Cutter: 'FC', Slider: 'SL', Curveball: 'CB', Changeup: 'CH',
  ChangeUp: 'CH', Splitter: 'SP', Knuckleball: 'KN',
};

function isoDate(date) {
  return String(date || '').slice(0, 10);
}

function addDays(iso, amount) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function ranges(start, end, days = 30) {
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, days)) {
    const last = addDays(cursor, days - 1);
    out.push([cursor, last < end ? last : end]);
  }
  return out;
}

async function fetchWindow(start, end, apiKey) {
  const records = [];
  let page = 1;
  while (true) {
    const pages = Array.from({ length: PAGE_BATCH }, (_, index) => page + index);
    const responses = await Promise.all(pages.map(async requestedPage => {
      const response = await axios.get(`${API_URL}/pitches`, {
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        params: { date_range_start: start, date_range_end: end, page: requestedPage, limit: PAGE_SIZE },
        timeout: 25000,
      });
      return { requestedPage, body: response.data };
    }));
    let reachedEnd = false;
    for (const { body } of responses) {
      if (!body?.success || !body.data) {
        reachedEnd = true;
        break;
      }
      const batch = Array.isArray(body.data) ? body.data : [body.data];
      for (const pitch of batch) {
        const date = isoDate(pitch.date);
        if (date >= start && date <= end) records.push(pitch);
      }
      if (batch.length < PAGE_SIZE) {
        reachedEnd = true;
        break;
      }
    }
    if (reachedEnd) break;
    page += PAGE_BATCH;
    if (page > 500) throw new Error(`Pagination limit reached for ${start}..${end}`);
  }
  return records;
}

async function fetchRange(start, end, apiKey, label) {
  const all = [];
  const windows = ranges(start, end);
  for (let index = 0; index < windows.length; index++) {
    const [windowStart, windowEnd] = windows[index];
    const records = await fetchWindow(windowStart, windowEnd, apiKey);
    all.push(...records);
    console.log(`${label}: window ${index + 1}/${windows.length}, ${records.length} pitches`);
  }
  return all;
}

function playerKey(pitch) {
  return `${pitch.batter_id || ''}|${pitch.batter_side || ''}`;
}

function normalizePitch(pitch) {
  const side = pitch.batter_side === 'Left' ? 'LHB' : 'RHB';
  const coordinateValues = [pitch.plate_loc_side, pitch.plate_loc_height];
  if (coordinateValues.some(value => value == null || value === '' || !Number.isFinite(Number(value)))) return null;
  const zone = getZoneFromLocation(Number(pitch.plate_loc_side), Number(pitch.plate_loc_height), side);
  const rawType = pitch.auto_pitch_type || pitch.tagged_pitch_type || 'Undefined';
  const pitchType = PITCH_ABBREVIATIONS[rawType] || rawType;
  const family = pitchFamily(pitchType);
  let outcome = null;
  if (WIN_CALLS.has(pitch.pitch_call)) outcome = 'win';
  else if (pitch.pitch_call === 'InPlay' && HITS.has(pitch.play_result)) outcome = 'loss';
  else if (pitch.pitch_call === 'InPlay' && OUTS.has(pitch.play_result)) outcome = 'win';
  else if (pitch.pitch_call === 'BallCalled') outcome = 'loss';
  return {
    player: playerKey(pitch),
    zone,
    regime: zoneRegime(zone),
    family,
    key: `${family}|${zone}`,
    outcome,
    game: String(pitch.game_id || `${isoDate(pitch.date)}|${pitch.batter_team_code || ''}`),
  };
}

function summarizeTrain(pitches) {
  const players = new Map();
  for (const rawPitch of pitches) {
    const pitch = normalizePitch(rawPitch);
    if (!pitch) continue;
    if (!players.has(pitch.player)) players.set(pitch.player, { regimes: new Map(), buckets: new Map() });
    const player = players.get(pitch.player);
    const bucket = player.buckets.get(pitch.key) || {
      zone: pitch.zone, regime: pitch.regime, total: 0, win: 0, loss: 0,
    };
    bucket.total++;
    if (pitch.outcome) {
      const regime = player.regimes.get(pitch.regime) || { win: 0, loss: 0 };
      regime[pitch.outcome]++;
      player.regimes.set(pitch.regime, regime);
      bucket[pitch.outcome]++;
    }
    player.buckets.set(pitch.key, bucket);
  }
  return players;
}

function predictionFor(pitch, player, config) {
  const regimeTally = player?.regimes.get(pitch.regime);
  if (!regimeTally) return null;
  const regimeTotal = regimeTally.win + regimeTally.loss;
  if (!regimeTotal) return null;
  const regimeBaseline = regimeTally.win / regimeTotal;
  const expected = expectedWinRate(pitch.zone, regimeBaseline);
  const bucket = player.buckets.get(pitch.key);
  let predicted = expected;
  let colored = 'gray';
  if (bucket && bucket.total >= config.minPitches && bucket.win + bucket.loss > 0) {
    const prior = REGIME_PRIOR[pitch.regime] * config.priorScale;
    predicted = (bucket.win + prior * expected) / (bucket.win + bucket.loss + prior);
    const edge = REGIME_EDGE[pitch.regime] * SENSITIVITY_MULTIPLIER[config.sensitivity];
    const delta = predicted - expected;
    if (delta >= edge) colored = 'green';
    else if (delta <= -edge) colored = 'red';
  }
  return { predicted, regimeBaseline, expected, colored, trainedBucket: !!bucket && bucket.total >= config.minPitches };
}

function brier(rows, field) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + (row[field] - row.actual) ** 2, 0) / rows.length;
}

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function resampleGames(rows, iterations, statistic) {
  const games = new Map();
  for (const row of rows) {
    if (!games.has(row.game)) games.set(row.game, []);
    games.get(row.game).push(row);
  }
  const clusters = [...games.values()];
  if (clusters.length < 2) return [];
  let seed = 190730;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const improvements = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = [];
    for (let index = 0; index < clusters.length; index++) {
      sample.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    improvements.push(statistic(sample));
  }
  return { games: clusters.length, values: improvements };
}

function clusteredImprovementInterval(rows, iterations = 500) {
  const sample = resampleGames(rows, iterations,
    rowsInSample => brier(rowsInSample, 'baselinePrediction') - brier(rowsInSample, 'prediction'));
  if (!sample.values?.length) return null;
  return {
    games: sample.games,
    low: quantile(sample.values, 0.025),
    high: quantile(sample.values, 0.975),
  };
}

function clusteredBrierStandardError(rows, field, iterations = 300) {
  const sample = resampleGames(rows, iterations, rowsInSample => brier(rowsInSample, field));
  if (!sample.values?.length) return 0;
  const mean = sample.values.reduce((sum, value) => sum + value, 0) / sample.values.length;
  return Math.sqrt(sample.values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (sample.values.length - 1));
}

function clusteredPairedImprovementInterval(candidateRows, currentRows, iterations = 500) {
  if (candidateRows.length !== currentRows.length) return null;
  const rows = candidateRows.map((row, index) => ({
    game: row.game,
    candidate: row.prediction,
    current: currentRows[index].prediction,
    actual: row.actual,
  }));
  const sample = resampleGames(rows, iterations, rowsInSample =>
    rowsInSample.reduce((sum, row) => sum + (row.current - row.actual) ** 2 - (row.candidate - row.actual) ** 2, 0) / rowsInSample.length
  );
  if (!sample.values?.length) return null;
  return { games: sample.games, low: quantile(sample.values, 0.025), high: quantile(sample.values, 0.975) };
}

function evaluate(pitches, players, config) {
  const rows = [];
  for (const rawPitch of pitches) {
    const pitch = normalizePitch(rawPitch);
    if (!pitch || !pitch.outcome) continue;
    const rating = predictionFor(pitch, players.get(pitch.player), config);
    if (!rating) continue;
    rows.push({
      game: pitch.game,
      actual: pitch.outcome === 'win' ? 1 : 0,
      prediction: rating.predicted,
      baselinePrediction: rating.regimeBaseline,
      expected: rating.expected,
      colored: rating.colored,
      trainedBucket: rating.trainedBucket,
    });
  }
  const colored = rows.filter(row => row.colored !== 'gray');
  const colorGroups = new Map();
  for (const row of colored) {
    const key = `${row.game}|${row.colored}`;
    const entry = colorGroups.get(key) || { color: row.colored, actual: 0, expected: 0, n: 0 };
    entry.actual += row.actual;
    entry.expected += row.expected;
    entry.n++;
    colorGroups.set(key, entry);
  }
  const groups = [...colorGroups.values()].filter(group => group.n >= 5);
  const directionAccuracy = groups.length
    ? groups.filter(group => group.color === 'green'
      ? group.actual / group.n > group.expected / group.n
      : group.actual / group.n < group.expected / group.n).length / groups.length
    : null;
  return {
    decisivePitches: rows.length,
    predictionCoverage: rows.length,
    ratedPitchCoverage: rows.length ? rows.filter(row => row.trainedBucket).length / rows.length : 0,
    coloredPitchCoverage: rows.length ? colored.length / rows.length : 0,
    brier: brier(rows, 'prediction'),
    baselineBrier: brier(rows, 'baselinePrediction'),
    expectedBrier: brier(rows.map(row => ({ actual: row.actual, score: row.expected })), 'score'),
    colorPitches: colored.length,
    colorGroups: groups.length,
    directionAccuracy,
    actualWinRateByColor: {
      green: colorRate(colored.filter(row => row.colored === 'green')),
      red: colorRate(colored.filter(row => row.colored === 'red')),
    },
    rows,
  };
}

function colorRate(rows) {
  if (!rows.length) return null;
  return rows.reduce((sum, row) => sum + row.actual, 0) / rows.length;
}

function configLabel(config) {
  return `k×${config.priorScale}, min=${config.minPitches}`;
}

function printEvaluation(label, result, interval) {
  console.log(`\n${label}`);
  console.log(`  eligible decisive pitches: ${result.decisivePitches.toLocaleString()}`);
  console.log(`  trained-bucket coverage: ${(result.ratedPitchCoverage * 100).toFixed(1)}%`);
  console.log(`  colored-pitch coverage (sensitivity 3): ${(result.coloredPitchCoverage * 100).toFixed(1)}%`);
  console.log(`  Brier: ${result.brier.toFixed(4)} | batter-regime baseline: ${result.baselineBrier.toFixed(4)} | location expectation: ${result.expectedBrier.toFixed(4)}`);
  console.log(`  Brier improvement vs regime baseline: ${(result.baselineBrier - result.brier).toFixed(4)}` +
    (interval ? ` (game-cluster 95% CI ${interval.low.toFixed(4)}..${interval.high.toFixed(4)}; ${interval.games} games)` : ''));
  console.log(`  colored groups with ≥5 pitches: ${result.colorGroups}; direction agreement: ${result.directionAccuracy == null ? 'n/a' : `${(result.directionAccuracy * 100).toFixed(1)}%`}`);
  console.log(`  actual pitcher-win rate, green: ${formatRate(result.actualWinRateByColor.green)}; red: ${formatRate(result.actualWinRateByColor.red)}`);
}

function formatRate(rate) {
  return rate == null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function main() {
  const apiKey = process.env.SLUGGER_API_KEY;
  if (!apiKey || apiKey === 'your-slugger-api-key-here') {
    throw new Error('Set SLUGGER_API_KEY in baseball_flashcard/.env before running this evaluator.');
  }
  return (async () => {
    console.log('Fetching pitches for temporal evaluation; pitch data and credentials are not written to disk.');
    const trainRaw = await fetchRange(TRAIN_START, TRAIN_END, apiKey, '2025 fit');
    const validateRaw = await fetchRange(VALIDATE_START, VALIDATE_END, apiKey, '2025 validation');
    const testRaw = await fetchRange(TEST_START, TEST_END, apiKey, '2026 holdout');
    const players = summarizeTrain(trainRaw);
    console.log(`\nTrain: ${TRAIN_START}..${TRAIN_END}; validate: ${VALIDATE_START}..${VALIDATE_END}; holdout: ${TEST_START}..${TEST_END}`);
    console.log(`Raw pitches: train ${trainRaw.length.toLocaleString()}, validation ${validateRaw.length.toLocaleString()}, holdout ${testRaw.length.toLocaleString()}; trained batter/side profiles: ${players.size}`);

    const candidates = [];
    for (const priorScale of PRIOR_SCALES) {
      for (const minPitches of MIN_BUCKET_PITCHES) {
        const config = { priorScale, minPitches, sensitivity: 3 };
        const result = evaluate(validateRaw, players, config);
        candidates.push({ config, result });
      }
    }
    candidates.sort((a, b) => a.result.brier - b.result.brier);
    const best = candidates[0];
    const bestStandardError = clusteredBrierStandardError(best.result.rows, 'prediction');
    const withinOneError = candidates.filter(candidate =>
      candidate.result.brier <= best.result.brier + bestStandardError
    );
    console.log(`\nBest 2025 validation candidates (Brier; game-cluster SE of best ≈ ${bestStandardError.toFixed(5)}; not evaluated on 2026):`);
    for (const candidate of candidates.slice(0, 5)) {
      console.log(`  ${configLabel(candidate.config)} | Brier ${candidate.result.brier.toFixed(5)} | rated ${(candidate.result.ratedPitchCoverage * 100).toFixed(1)}% | colored ${(candidate.result.coloredPitchCoverage * 100).toFixed(1)}%`);
    }
    withinOneError.sort((a, b) =>
      Math.abs(a.config.priorScale - 1) - Math.abs(b.config.priorScale - 1) ||
      Math.abs(a.config.minPitches - 3) - Math.abs(b.config.minPitches - 3)
    );
    const selected = withinOneError[0];
    console.log(`Selected with one-standard-error rule (prefer current settings when statistically tied): ${configLabel(selected.config)}`);
    const validationSelected = evaluate(validateRaw, players, selected.config);
    printEvaluation('2025 validation diagnostics', validationSelected, null);

    const holdout = evaluate(testRaw, players, selected.config);
    const current = evaluate(testRaw, players, { priorScale: 1, minPitches: 3, sensitivity: 3 });
    for (const sensitivity of SENSITIVITY_LEVELS) {
      const sensitivityResult = evaluate(testRaw, players, { ...selected.config, sensitivity });
      console.log(`2026 color sensitivity ${sensitivity}: colored ${(sensitivityResult.coloredPitchCoverage * 100).toFixed(1)}%, direction agreement ${sensitivityResult.directionAccuracy == null ? 'n/a' : `${(sensitivityResult.directionAccuracy * 100).toFixed(1)}%`}`);
    }
    printEvaluation('2026 final holdout (settings frozen from 2025 validation)', holdout,
      clusteredImprovementInterval(holdout.rows));
    if (configLabel(selected.config) !== configLabel({ priorScale: 1, minPitches: 3 })) {
      printEvaluation('2026 current-production comparison (k×1, min=3)', current, null);
      const paired = clusteredPairedImprovementInterval(holdout.rows, current.rows);
      console.log(`  paired Brier improvement (current minus selected): ${(current.brier - holdout.brier).toFixed(4)}` +
        (paired ? ` (game-cluster 95% CI ${paired.low.toFixed(4)}..${paired.high.toFixed(4)}; ${paired.games} games)` : ''));
    } else {
      console.log('\nValidation selected the current production settings under the one-standard-error rule; no parameter change is recommended.');
    }
    console.log('\nInterpretation: positive Brier improvement is better than the batter-regime baseline; color direction agreement should exceed 50% on unseen games. Holdout results are diagnostic and must not be used to retune these same settings.');
  })();
}

main().catch(error => {
  console.error(`Evaluation failed: ${error.response?.status ? `upstream HTTP ${error.response.status}` : error.message}`);
  process.exitCode = 1;
});
