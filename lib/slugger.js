/**
 * lib/slugger.js — the SLUGGER (ALPB Trackman) HTTP client.
 *
 * Authenticated GETs with a timeout and bounded retry, concurrent pagination, and
 * the per-record slimming applied to every pitch as it arrives.
 */

'use strict';

const axios = require('axios');
const { SLUGGER_CONFIG } = require('./config.js');

// Retry only what a retry can fix: transport failures and upstream 5xx. A 4xx is a
// malformed request and fails identically on every attempt.
function isRetryableUpstream(err) {
  if (!err) return false;
  if (err.response) return err.response.status >= 500;
  return true; // no response at all: network error / ECONNABORTED / ETIMEDOUT
}

const UPSTREAM_TIMEOUT_MS = 25000;
const UPSTREAM_RETRY_DELAYS_MS = [500, 1500];

/**
 * Makes an authenticated GET request to the SLUGGER API.
 *
 * axios defaults to NO timeout, so before this a single hung page could silently
 * consume the whole Lambda budget on any path — including the batter card the
 * interactive flow depends on. 25s sits under the upstream API Gateway's 29s
 * integration limit, and transport/5xx failures get a short bounded retry.
 * @param {string} endpoint - API path (e.g. '/pitches').
 * @param {Object} [params={}] - Query parameters to include. Defaults `limit` to 1000.
 * @returns {Promise<Object>} Parsed JSON response body.
 */
async function sluggerRequest(endpoint, params = {}) {
  let lastError;
  for (let attempt = 0; attempt <= UPSTREAM_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await axios.get(`${SLUGGER_CONFIG.baseUrl}${endpoint}`, {
        headers: { 'x-api-key': SLUGGER_CONFIG.apiKey, 'Content-Type': 'application/json' },
        params: { ...params, limit: params.limit || 1000 },
        timeout: UPSTREAM_TIMEOUT_MS
      });
      return response.data;
    } catch (err) {
      lastError = err;
      if (attempt === UPSTREAM_RETRY_DELAYS_MS.length || !isRetryableUpstream(err)) break;
      await new Promise(resolve => setTimeout(resolve, UPSTREAM_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError;
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

// Raw pitch records from the API carry dozens of fields; the app reads only these.
// Slimming each record as its page arrives (instead of holding full-fat records for
// the whole range) keeps a full-season fetch (~110k+ pitches) far from the Lambda's
// memory ceiling — the full raw dataset never exists in the heap at once.
const PITCH_FIELDS = [
  'game_id', 'date', 'rel_speed', 'release_speed',
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

/**
 * Page transform for /pitches: drops records outside [start, end] (the upstream
 * date filter is not trusted to be exact) and slims the rest.
 * @param {string} start - YYYY-MM-DD, inclusive.
 * @param {string} end - YYYY-MM-DD, inclusive.
 * @returns {Function} mapBatch for fetchAllPages.
 */
function slimInRange(start, end) {
  return (items) => items
    .filter(p => {
      const d = (p.date || '').slice(0, 10);
      return d >= start && d <= end;
    })
    .map(slimPitch);
}

/**
 * True when the feed rejected the request because of the batter id itself.
 *
 * SLUGGER answers an id it does not recognise with HTTP 400 and a validation error
 * naming `batter_id`. That is an answer, not an outage — so "couldn't reach the
 * feed" would be false. It is also not "no pitch data for this batter": the
 * card must only say that when the feed returned an empty list (see the
 * upstream_failure tests). Requiring the error to name batter_id keeps a 400 caused
 * by anything else — including a malformed request from our own code — on the 503
 * path, where it belongs.
 */
function isUnknownBatterError(err) {
  const res = err && err.response;
  if (!res || res.status !== 400) return false;
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
  return /batter_id/i.test(body);
}

const UPSTREAM_ERROR_MESSAGE = "Couldn't reach the league data feed. Please try again in a moment.";

module.exports = {
  sluggerRequest,
  fetchAllPages,
  slimPitch,
  slimInRange,
  isUnknownBatterError,
  UPSTREAM_ERROR_MESSAGE,
};
