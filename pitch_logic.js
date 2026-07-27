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
  circleColorMode: 'both', // 'both' | 'green' | 'red'
  maxCirclesPerBucket: 1,  // number (1..10) or 'All'
  swingsOnly: false,       // restrict the population to swings (drop takes + other)
};

// Per-pitch outcomes counted as a swing (a take is 'take'; 'other' is neither).
const SWING_OUTCOMES = ['whiff', 'foul', 'hit', 'out'];

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
 * Orders pitches by bucket extremity (most extreme first). Stable: equal-extremity
 * pitches (same bucket) keep their incoming order, which is chronological.
 */
function byExtremityDesc(arr) {
  return arr
    .map((z, i) => [z, i])
    .sort((a, b) => ((b[0].extremity ?? -1) - (a[0].extremity ?? -1)) || (a[1] - b[1]))
    .map(pair => pair[0]);
}

/**
 * Interleaves two ordered arrays one-at-a-time starting with the first (reds).
 * When one runs out, the remainder of the other is appended in order.
 * e.g. interleave([R1,R2], [G1,G2]) → [R1,G1,R2,G2]; interleave([R1,R2,R3],[G1]) → [R1,G1,R2,R3].
 */
/**
 * Interprets the maxCirclesPerBucket setting as a numeric cap. 'All' (or missing)
 * means no cap (Infinity); a positive number caps circles kept per bucket.
 */
function normalizeCircleCap(v) {
  if (v === undefined || v === null || v === 'All' || v === 'all') return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : Infinity;
}

function interleave(reds, greens) {
  const out = [];
  const n = Math.max(reds.length, greens.length);
  for (let i = 0; i < n; i++) {
    if (i < reds.length) out.push(reds[i]);
    if (i < greens.length) out.push(greens[i]);
  }
  return out;
}

/**
 * Resolves the circle color mode ('both' | 'green' | 'red'), gracefully migrating
 * the legacy showOnlyGoodPitches / showOnlyBadPitches booleans if they are the
 * only thing present in a persisted settings object.
 */
function circleColorMode(cfg) {
  if (cfg.circleColorMode) return cfg.circleColorMode;
  if (cfg.showOnlyGoodPitches && !cfg.showOnlyBadPitches) return 'green';
  if (cfg.showOnlyBadPitches && !cfg.showOnlyGoodPitches) return 'red';
  return 'both';
}

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
  let population = (batterData.pitchZones || []).filter(z =>
    (hand === 'L' || hand === 'R') ? z.pitcherThrows === hand : true);
  // Swings-only mode: filter BEFORE bucketing so population, overallRate, bucket
  // colors, and elimination thresholds all recompute on the swing population.
  if (cfg.swingsOnly) {
    population = population.filter(z => SWING_OUTCOMES.includes(z.outcome));
  }
  const bucketCtx = computeBucketRatings(population, cfg);

  let fz = population.map(z => {
    const b = bucketCtx.buckets[bucketKey(z)];
    return { ...z, rating: b.rating, extremity: b.extremity, eliminated: b.eliminated };
  });
  fz = fz.filter(z => !z.eliminated);
  if (cfg.hiddenPitchTypes && cfg.hiddenPitchTypes.length > 0) {
    fz = fz.filter(z => !cfg.hiddenPitchTypes.includes(z.pitch));
  }

  const mode = circleColorMode(cfg);
  const reds = byExtremityDesc(fz.filter(z => z.rating === 'red'));
  const greens = byExtremityDesc(fz.filter(z => z.rating === 'green'));
  const grays = byExtremityDesc(fz.filter(z => z.rating !== 'red' && z.rating !== 'green'));

  let ordered;
  if (mode === 'green') {
    ordered = greens;
  } else if (mode === 'red') {
    ordered = reds;
  } else {
    // 'both': alternate one red, one green (starting red); grays after all colors.
    ordered = interleave(reds, greens).concat(grays);
  }

  // Cap circles per bucket AFTER ordering: keeping the first N in the ordered list
  // preserves the chronologically-first pitch(es) within each bucket (and the
  // alternation shape), since same-bucket pitches retain chronological order.
  const cap = normalizeCircleCap(cfg.maxCirclesPerBucket);
  if (cap !== Infinity) {
    const perBucket = {};
    ordered = ordered.filter(z => {
      const k = bucketKey(z);
      perBucket[k] = (perBucket[k] || 0) + 1;
      return perBucket[k] <= cap;
    });
  }

  return { pitches: ordered, bucketCtx, populationCount: population.length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BUCKET_RATING_EDGE,
    DEFAULT_LOGIC_SETTINGS,
    resolveSettings,
    bucketKey,
    interleave,
    computeBucketRatings,
    getVisiblePitches,
  };
}
