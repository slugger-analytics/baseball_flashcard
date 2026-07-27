/**
 * pitch_logic.js — pure pitch-display logic shared by the browser client (app.js)
 * and the node:test unit suite.
 *
 * In the browser this is loaded as a classic <script> BEFORE app.js, so the
 * functions below become globals that app.js calls (getVisiblePitches,
 * computeBucketRatings, bucketKey). Under node:test the same file is require()d
 * and reads its exports. Nothing here touches the DOM.
 *
 * Settings: each entry point accepts an optional `settings` object. When omitted,
 * it falls back to the app.js CURRENT_SETTINGS global (browser) or, failing that,
 * to DEFAULT_LOGIC_SETTINGS (node:test). Tests pass settings explicitly.
 *
 * Bucket color model: pitches are grouped into (pitch type × zone) buckets — e.g.
 * "sliders in Low-In". Each bucket's hit rate (contact hits per pitch) is compared
 * against the batter's overall hits-per-pitch rate over the same (hand-filtered)
 * pitch population. 25%+ below overall = green (good for the pitcher — attack
 * here), 25%+ above = red (avoid), inside the band = gray. Buckets with fewer than
 * the user-set Min Pitches per Bucket are eliminated from the grid entirely — too
 * small a sample to trust either way.
 */

const BUCKET_RATING_EDGE = 0.25;

// Logic-relevant subset of app.js DEFAULT_SETTINGS. Only used as a fallback when
// neither an explicit settings arg nor the app.js CURRENT_SETTINGS global exists
// (i.e. under node:test). Keep the shared keys in sync with DEFAULT_SETTINGS.
const DEFAULT_LOGIC_SETTINGS = {
  bucketMinPitches: 3,
  hiddenPitchTypes: [],
  pitcherHandFilter: 'All',
  showOnlyGoodPitches: false,
  showOnlyBadPitches: false,
};

/**
 * Resolves the effective settings object: explicit arg > app.js global > defaults.
 */
function resolveSettings(settings) {
  if (settings) return settings;
  if (typeof CURRENT_SETTINGS !== 'undefined' && CURRENT_SETTINGS) return CURRENT_SETTINGS;
  return DEFAULT_LOGIC_SETTINGS;
}

function bucketKey(p) { return `${p.pitch}|${p.zone}`; }

/**
 * Buckets a pitch population by (pitch type × zone) and rates each bucket against
 * the batter's overall hit rate over that population.
 * @param {Array<Object>} pitches - pitchZone objects ({ pitch, zone, outcome, ... }).
 * @param {Object} [settings] - Effective settings (bucketMinPitches used here).
 * @returns {{ buckets: Object, overallRate: number|null }}
 */
function computeBucketRatings(pitches, settings) {
  const cfg = resolveSettings(settings);
  const buckets = {};
  let totalHits = 0;
  pitches.forEach(p => {
    const k = bucketKey(p);
    if (!buckets[k]) buckets[k] = { pitch: p.pitch, zone: p.zone, total: 0, hit: 0, out: 0, whiff: 0, take: 0, foul: 0, other: 0 };
    const b = buckets[k];
    b.total++;
    if (b[p.outcome] !== undefined && p.outcome !== 'total') b[p.outcome]++;
    else b.other++;
    if (p.outcome === 'hit') totalHits++;
  });
  const overallRate = pitches.length > 0 ? totalHits / pitches.length : null;

  Object.values(buckets).forEach(b => {
    b.rate = b.total > 0 ? b.hit / b.total : null;
    b.eliminated = b.total < cfg.bucketMinPitches;
    b.rating = 'neutral';
    b.extremity = -1;
    if (!b.eliminated && overallRate > 0 && b.rate !== null) {
      if (b.rate <= overallRate * (1 - BUCKET_RATING_EDGE)) b.rating = 'green';
      else if (b.rate >= overallRate * (1 + BUCKET_RATING_EDGE)) b.rating = 'red';
      // Distance from the batter's average, used to reveal extremes first
      b.extremity = Math.abs(b.rate / overallRate - 1);
    }
  });
  return { buckets, overallRate };
}

/**
 * Builds the drawable pitch list for a batter: applies the pitcher-hand filter,
 * buckets and rates the population, drops eliminated (under-sample) buckets and
 * hidden pitch types, applies the green/red-only toggles, and orders pitches so
 * the most extreme buckets come first.
 * @param {Object} batterData - A batter object from TEAMS_DATA.
 * @param {Object} [settings] - Effective settings.
 * @returns {{ pitches: Array<Object>, bucketCtx: Object, populationCount: number }}
 */
function getVisiblePitches(batterData, settings) {
  const cfg = resolveSettings(settings);
  const hand = cfg.pitcherHandFilter;
  const population = (batterData.pitchZones || []).filter(z =>
    (hand === 'L' || hand === 'R') ? z.pitcherThrows === hand : true);
  const bucketCtx = computeBucketRatings(population, cfg);

  let fz = population.map(z => {
    const b = bucketCtx.buckets[bucketKey(z)];
    return { ...z, rating: b.rating, extremity: b.extremity, eliminated: b.eliminated };
  });
  fz = fz.filter(z => !z.eliminated);
  if (cfg.hiddenPitchTypes && cfg.hiddenPitchTypes.length > 0) {
    fz = fz.filter(z => !cfg.hiddenPitchTypes.includes(z.pitch));
  }
  if (cfg.showOnlyGoodPitches && !cfg.showOnlyBadPitches) {
    fz = fz.filter(z => z.rating === 'green');
  } else if (cfg.showOnlyBadPitches && !cfg.showOnlyGoodPitches) {
    fz = fz.filter(z => z.rating === 'red');
  }
  // Stable sort: ties (pitches in the same bucket) keep chronological order
  fz.sort((a, b) => (b.extremity ?? -1) - (a.extremity ?? -1));
  return { pitches: fz, bucketCtx, populationCount: population.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BUCKET_RATING_EDGE,
    DEFAULT_LOGIC_SETTINGS,
    resolveSettings,
    bucketKey,
    computeBucketRatings,
    getVisiblePitches,
  };
}
