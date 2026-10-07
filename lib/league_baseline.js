/**
 * lib/league_baseline.js — the league first-pitch approach baseline.
 *
 * The pooled league metric (season-to-date) that per-batter approaches are graded
 * against. Held in memory and mirrored to CACHE_DIR so a cold container can
 * recover the newest value from disk. The batter card attaches it but is NEVER
 * blocked on it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_DIR } = require('./config.js');
const { fetchAllPages, slimInRange } = require('./slugger.js');
const { poolLeagueFirstPitch } = require('./stats.js');
const { spanDays } = require('./dates.js');

let leagueFirstPitchMemo = null; // { start, end, metric, tally, computedAt }

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

// The baseline used to be a by-product of a full-season league-wide transform,
// which could not complete inside the Lambda budget — so every card silently read
// "league avg pending" and every batter graded Neutral. It never needed the whole
// pitch space: the metric is defined over 0-0 pitches only, and the upstream honours
// a balls=0&strikes=0 filter, so this pulls ~34k records instead of ~151k. Measured
// season-to-date: 35 pages, ~45s. poolLeagueFirstPitch re-filters with isZeroZeroPitch
// internally, so the pre-filtered pull is mathematically identical to the full pool.
const LEAGUE_FP_MAX_AGE_MS = 12 * 60 * 60 * 1000;
let leagueFpInFlight = null;

function leagueFirstPitchIsFresh(start, end) {
  const memo = leagueFirstPitchMemo;
  if (!memo || memo.metric == null) return false;
  if (memo.start !== start || memo.end !== end) return false;
  return Date.now() - new Date(memo.computedAt).getTime() < LEAGUE_FP_MAX_AGE_MS;
}

/**
 * Recomputes the league first-pitch baseline from a 0-0-only upstream fetch and
 * records it. Single-flight: concurrent callers share one fetch.
 * @param {string} start - Window start (YYYY-MM-DD).
 * @param {string} end - Window end (YYYY-MM-DD).
 * @returns {Promise<number|null>} The pooled metric, or null when the window is empty.
 */
async function refreshLeagueFirstPitch(start, end) {
  if (leagueFpInFlight) return leagueFpInFlight;
  leagueFpInFlight = (async () => {
    console.log(`Refreshing league first-pitch baseline: ${start} → ${end} (0-0 pitches only)`);
    const records = await fetchAllPages('/pitches', {
      date_range_start: start,
      date_range_end: end,
      balls: 0,
      strikes: 0
    }, slimInRange(start, end));
    const pool = poolLeagueFirstPitch(records);
    recordLeagueFirstPitch(start, end, pool);
    console.log(`✅ League first-pitch baseline: ${pool.metric} from ${records.length} 0-0 pitches`);
    return pool.metric;
  })();
  try {
    return await leagueFpInFlight;
  } finally {
    leagueFpInFlight = null;
  }
}

/** The current memo record, or null. */
function getLeagueFirstPitchMemo() {
  return leagueFirstPitchMemo;
}

/** Test seam: drop the memo so a test can model a cold container. */
function resetLeagueFirstPitch() {
  leagueFirstPitchMemo = null;
}

module.exports = {
  recordLeagueFirstPitch,
  getLeagueFirstPitchAvg,
  leagueFirstPitchIsFresh,
  refreshLeagueFirstPitch,
  getLeagueFirstPitchMemo,
  resetLeagueFirstPitch,
};
