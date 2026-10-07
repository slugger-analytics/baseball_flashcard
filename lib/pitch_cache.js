/**
 * lib/pitch_cache.js — pitch fetches backed by a streamed disk cache.
 *
 * Two queries: one batter's pitches (the card) and every pitch in a date range
 * (the roster activity window). Both write
 * slimmed records to CACHE_DIR and stream them back on a hit.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { withParserAsStream } = require('stream-json/streamers/stream-array.js');
const { CACHE_DIR } = require('./config.js');
const { fetchAllPages, slimInRange } = require('./slugger.js');

/**
 * Returns the disk path for a cached pitch range file.
 */
function getCachePath(startDate, endDate) {
  return path.join(CACHE_DIR, `cache_${startDate}_${endDate}_v2.json`);
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

// Ranges bigger than this aren't disk-cached: stringifying + writing them can
// exhaust the Lambda's 512 MB /tmp (and heap), and a failed write used to leave
// a truncated file that poisoned every later request for the same range.
// Records are slimmed to PITCH_FIELDS before caching (~6x smaller than raw),
// so the ceiling covers a full season comfortably.
const MAX_CACHED_PITCHES = 200000;

/**
 * Fetches all pitch records for a date range from the SLUGGER API, with disk-backed streaming cache.
 * On a cache miss, pages are fetched and written to disk; on a hit, records are streamed back
 * through stream-json without loading the full array into V8 heap simultaneously.
 * @param {string} startDateStr - Start date in YYYY-MM-DD format.
 * @param {string} endDateStr - End date in YYYY-MM-DD format.
 * @returns {Promise<Array>} Array of raw pitch objects. Empty means the range is
 *   genuinely empty; an upstream failure throws.
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
    }, slimInRange(startDateStr, endDateStr));

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
    // Rethrow: swallowing this used to surface an upstream outage to the coach as
    // "no pitch data found", which is a different and much more misleading claim.
    console.error("❌ Error fetching from SLUGGER API:", error);
    throw error;
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
 * @returns {Promise<Array>} Slimmed pitch records for that batter. Empty means the
 *   batter genuinely has no pitches in the window; an upstream failure throws.
 */
async function fetchPitchesForBatter(batterId, startDateStr, endDateStr) {
  const cachePath = path.join(CACHE_DIR, `cache_batter_${batterId}_${startDateStr}_${endDateStr}_v2.json`);

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
    // batter_id scopes the upstream query; the date filter is a safety net.
    const filtered = await fetchAllPages('/pitches', {
      date_range_start: startDateStr,
      date_range_end: endDateStr,
      batter_id: batterId
    }, slimInRange(startDateStr, endDateStr));

    console.log(`✅ Batter ${batterId?.slice(0, 8)}: ${filtered.length} pitches`);

    try {
      await writeDiskCache(cachePath, filtered);
    } catch (err) {
      console.error(`⚠️ Batter cache write failed (serving uncached):`, err.message);
    }

    return filtered;
  } catch (error) {
    // Rethrow — see fetchPitchesByDateRange. An empty array must mean "this batter
    // genuinely has no pitches", never "the feed was unreachable".
    console.error(`❌ Error fetching batter ${batterId} pitches:`, error.message);
    throw error;
  }
}

module.exports = {
  fetchPitchesByDateRange,
  fetchPitchesForBatter,
};
