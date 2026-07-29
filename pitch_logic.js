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
 * Bucket colour model: pitches are grouped into (pitch FAMILY × zone) buckets —
 * e.g. "breaking balls in Low-In" — and each is scored on how often a pitch there
 * went the PITCHER's way (whiff, called strike, foul or out; a hit or a BALL is a
 * loss). That bucket rate is then:
 *
 *   1. compared against an expectation for the spot, not a single global average:
 *      the batter's own rate for the regime (in zone / off the edge / well
 *      outside), shifted by how that individual zone plays league-wide;
 *   2. shrunk toward that expectation by sample size, so a 3-pitch bucket sits on
 *      it and cannot shout;
 *   3. coloured green (attack) or red (avoid) once it clears an edge the user can
 *      tune via Color Sensitivity.
 *
 * Together those three steps are what keep the card from stating the obvious.
 * Scoring the ball stops "he has no hits three feet outside" reading as attack
 * here; the regime split and zone offset stop "don't throw it where everything is
 * called a ball" — true of every hitter alive — from burning a slot; and the
 * shrinkage stops one 2-for-3 from painting a zone red. See WIN_OUTCOMES,
 * REGIME_PRIOR and ZONE_LEAGUE_OFFSET for the fitted constants and the data
 * behind them.
 *
 * Buckets with fewer than the user-set Min Pitches per Bucket are eliminated from
 * the grid entirely — too small a sample to draw at all.
 */

/**
 * Bucket rating model.
 *
 * A bucket is scored on how often a pitch there went the PITCHER's way, not on
 * the batter's hit rate. Hit rate was the original metric and it failed badly:
 * hits are only 5.6% of pitches, and — because a take is invisible to
 * hits/pitches — a pitch three feet outside scored a perfect 0.000 and rated
 * "attack here". Measured across 45 batters, 53% of all advice the card gave was
 * "throw it out of the zone". Counting a ball as a loss for the pitcher is what
 * fixes that.
 *
 * 'other' (HBP and anything unclassified, ~1% of pitches) is neutral: it counts
 * toward neither, so it cannot drag a bucket either way.
 *
 * A foul is scored as a win. It is a strike, though a weaker one with two
 * strikes — the one real simplification here.
 */
const WIN_OUTCOMES = ['whiff', 'strike', 'foul', 'out'];
const LOSS_OUTCOMES = ['hit', 'ball'];

/**
 * Buckets are rated against a baseline for their REGIME — how far outside the
 * zone the pitch was — never against one global average.
 *
 *   zone  the 9 in-zone boxes                       84.4% pitcher-win
 *   edge  chase missing on ONE axis (Chase Mid-Out,  32.7%
 *         Chase High-Mid, ...) — just off the plate
 *   deep  chase missing on BOTH axes (Chase High-In, 10.5%
 *         the four diagonal corners) — nowhere near
 *
 * Two regimes were not enough. With all 8 chase regions sharing one 27%
 * baseline, that baseline was set by the edge bands where hitters actually
 * chase, so the diagonal corners — sitting at 3-14% — came out red for
 * practically everyone: Chase High-Out was red for 91% of batters, Chase High-In
 * 80%, Chase Low-Out 76%. That is not scouting, it is geometry. "Don't throw it
 * where everything is a ball" is true of every hitter alive and was burning a
 * slot on a card that only shows four.
 *
 * Splitting them means a corner bucket is judged against other corner buckets.
 * Deep chase still carries 7.5 points of genuine spread, so a batter who really
 * does expand out there can still light up — but the universal case goes gray.
 *
 * PRIOR is the empirical-Bayes shrinkage constant k = p(1-p)/tau^2, tau being the
 * genuine (noise-corrected) between-bucket spread: 5.0 points in the zone, 11.2
 * on the edge, 7.5 deep. A bucket is pulled toward its regime baseline with
 * weight k, so a 3-pitch bucket barely moves off it and cannot shout — this is
 * what stops "he went 2-for-3 here" from painting a zone red. Where a pitch
 * lands IN the zone barely matters, so in-zone evidence is discounted hardest.
 *
 * EDGE is one standard deviation of the shrunk deltas — the scale ratings
 * actually live on. Scaled at display time by SENSITIVITY_MULTIPLIER.
 */
const REGIME_PRIOR = { zone: 54, edge: 18, deep: 17 };
const REGIME_EDGE = { zone: 0.021, edge: 0.067, deep: 0.036 };
const REGIME_LABEL = { zone: 'in zone', edge: 'off the edge', deep: 'well outside' };
const REGIMES = ['zone', 'edge', 'deep'];

/**
 * How much easier or harder each individual zone is for the pitcher than its
 * regime as a whole, in win-rate points, measured league-wide.
 *
 * Regimes alone still left geometry in the ratings. Inside `deep`, Chase
 * High-Out runs a 3.5% pitcher-win rate against a 10.5% regime baseline — a
 * fastball at the letters and off the plate is the easiest pitch in baseball to
 * lay off — so it stayed red for 57% of batters even after the regime split.
 * Same story for Chase High-Mid on the edge. Subtracting the league's own
 * expectation for a spot leaves only the part that is about THIS batter, and
 * flattens %red across all 17 zones to a 16-46% band with no zone universal.
 *
 * These are league constants, not per-batter: they describe the location, and a
 * batter is then measured against what a league-average hitter does there.
 * Fitted on 45 batters / ~40k pitches, same sample as REGIME_PRIOR.
 */
const ZONE_LEAGUE_OFFSET = {
  'High-In': 0.024, 'High-Mid': 0.023, 'High-Out': -0.011,
  'Mid-In': 0.024, 'Mid-Mid': -0.001, 'Mid-Out': 0.031,
  'Low-In': -0.030, 'Low-Mid': -0.025, 'Low-Out': -0.038,
  'Chase High-In': -0.009, 'Chase High-Mid': -0.048, 'Chase High-Out': -0.069,
  'Chase Mid-In': 0.042, 'Chase Mid-Out': 0.007,
  'Chase Low-In': 0.038, 'Chase Low-Mid': -0.005, 'Chase Low-Out': 0.019,
};

/**
 * What this batter would be expected to yield in this spot: his own level for
 * the regime, shifted by how the location plays league-wide. Clamped away from
 * 0 and 1 so a shrinkage target is always a usable probability.
 */
function expectedWinRate(zone, regimeBaseline) {
  if (regimeBaseline === null || regimeBaseline === undefined) return null;
  const offset = ZONE_LEAGUE_OFFSET[zone] || 0;
  return Math.min(Math.max(regimeBaseline + offset, 0.01), 0.99);
}

/**
 * How small a genuine difference is worth colouring, as a multiplier on
 * REGIME_EDGE. Lower = more colour.
 *
 * This is a display preference, not a statistical one: shrinkage has already
 * pulled thin buckets onto the baseline, so loosening the edge surfaces smaller
 * REAL differences rather than resurrecting noise. At 1.0 (one full SD) about
 * 68% of buckets come out gray, which reads as washed out once the Max Pitches
 * slider is opened up. Measured over 45 batters:
 *
 *   1.00  13% green  19% red  68% gray     0.50  29% green  35% red  36% gray
 *   0.70  21%        28%      51%          0.35  35%        40%      25%
 *
 * Level 3 (0.5) is the default. Below about 0.4 an all-win 3-pitch in-zone
 * bucket starts to clear the bar, so the looser settings lean on
 * bucketMinPitches to hold the line.
 */
const SENSITIVITY_MULTIPLIER = { 1: 1.0, 2: 0.7, 3: 0.5, 4: 0.35, 5: 0.2 };
const DEFAULT_SENSITIVITY = 3;

/** Resolves the configured sensitivity level to an edge multiplier. */
function sensitivityMultiplier(cfg) {
  const level = (cfg && cfg.ratingSensitivity) || DEFAULT_SENSITIVITY;
  return SENSITIVITY_MULTIPLIER[level] || SENSITIVITY_MULTIPLIER[DEFAULT_SENSITIVITY];
}

/**
 * Which baseline a zone label is rated against: 'zone', 'edge' or 'deep'.
 * A chase label missing on both axes ('Chase High-In') is a diagonal corner and
 * counts as deep; missing on one ('Chase Mid-Out') is just off the plate.
 */
function zoneRegime(zone) {
  if (!isChaseZone(zone)) return 'zone';
  const [vertical, horizontal] = String(zone).slice(CHASE_PREFIX.length).split('-');
  return (vertical !== 'Mid' && horizontal !== 'Mid') ? 'deep' : 'edge';
}

/**
 * Strike zone geometry in feet, matching Trackman's plate_loc_side /
 * plate_loc_height. This is the single source of truth for BOTH the zone labels
 * (getZoneFromLocation) and the drawn grid (plateToPercent + ZONE_PCT), so the
 * two cannot drift apart the way they used to: the labels split at ±0.33 ft and
 * 2.0/3.0 ft while the overlay drew a flat 33%/66% grid over a ±2 ft × 1.5–3.5 ft
 * box, so a circle could sit in the middle cell but be bucketed as High-In.
 *
 * HALF_WIDTH: half the 17" plate (0.708 ft) plus a ball radius (0.125 ft).
 * BOTTOM/TOP: the conventional 1.5–3.5 ft vertical zone.
 */
const STRIKE_ZONE = { HALF_WIDTH: 0.8333, BOTTOM: 1.5, TOP: 3.5 };

/**
 * Fraction of the drawing canvas the strike zone occupies on each axis. The
 * canvas is deliberately larger than the zone so balls and chase pitches have
 * somewhere to land outside it. 0.6 puts the zone edges on exactly 20%/80% and
 * the in-zone thirds on 40%/60% of the canvas — round numbers the CSS overlay
 * can rely on.
 */
const ZONE_SPAN_FRACTION = 0.6;

const ZONE_CENTER_HEIGHT = (STRIKE_ZONE.TOP + STRIKE_ZONE.BOTTOM) / 2;
const PCT_PER_FOOT_X = (ZONE_SPAN_FRACTION * 100) / (STRIKE_ZONE.HALF_WIDTH * 2);
const PCT_PER_FOOT_Y = (ZONE_SPAN_FRACTION * 100) / (STRIKE_ZONE.TOP - STRIKE_ZONE.BOTTOM);

/**
 * Canvas-relative percentages of the drawn strike zone: its edges and the two
 * interior lines that split it into the 9 boxes. Consumed by the renderer so the
 * drawn rectangle always lands exactly where plateToPercent puts an on-the-edge
 * pitch, whatever the element's pixel size or aspect ratio.
 */
const ZONE_PCT = {
  left:   50 - ZONE_SPAN_FRACTION * 50,
  right:  50 + ZONE_SPAN_FRACTION * 50,
  top:    50 - ZONE_SPAN_FRACTION * 50,
  bottom: 50 + ZONE_SPAN_FRACTION * 50,
};

/**
 * Projects a pitch's plate coordinates onto the canvas as [x%, y%].
 *
 * Pitcher's perspective: positive plate_loc_side = the catcher's left = the
 * pitcher's RIGHT (see getZoneFromLocation), so it renders on the right of the
 * graphic. Values are clamped to the canvas, so a pitch thrown well outside it
 * pins to the border rather than escaping the box, and rounded to one decimal —
 * plenty for a %-based layout, and it keeps the JSON payload small enough for
 * the ALB's 1 MB response limit.
 *
 * @param {number} plateSide - Horizontal plate position in feet.
 * @param {number} plateHeight - Height above the ground in feet.
 * @returns {[number, number]} [x, y] as percentages of the canvas.
 */
function plateToPercent(plateSide, plateHeight) {
  const x = 50 + plateSide * PCT_PER_FOOT_X;
  const y = 50 - (plateHeight - ZONE_CENTER_HEIGHT) * PCT_PER_FOOT_Y;
  const clamp = v => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
  return [clamp(x), clamp(y)];
}

/**
 * Maps a pitch's plate coordinates to a named zone.
 *
 * In-zone pitches get one of the 9 boxes the strike zone is split into, e.g.
 * 'High-In' or 'Mid-Mid'. Pitches outside the zone get a 'Chase ' prefix and are
 * named by how they missed — 'Chase Low-Out' is below and off the outer edge,
 * 'Chase Mid-In' is at a hittable height but inside off the plate. The two label
 * families are bucketed separately, so in-zone samples stay uncontaminated by
 * pitches the batter had no obligation to swing at.
 *
 * Sign convention (verified empirically on the full 2026 feed, ~107k pitches):
 * positive plate_loc_side = the CATCHER'S LEFT = third-base side = where a
 * right-handed batter stands. Two independent checks agree: (1) pitchers work
 * away — pitches to RHB lean negative, to LHB positive; (2) pitch physics —
 * RHP sliders (glove-side break, catcher's right) average -0.36 while RHP
 * sinkers/changeups (arm-side run, catcher's left) average +0.22/+0.27, with
 * LHP exactly mirrored. Earlier code assumed the opposite sign, which mirrored
 * every In/Out label (and the dot positions that were later flipped to match).
 *
 * @param {number} plateSide - Horizontal plate position in feet (positive = catcher's left).
 * @param {number} plateHeight - Vertical plate position in feet above the ground.
 * @param {string} handedness - Batter handedness: 'LHB' or 'RHB'.
 * @returns {string} '<Vertical>-<Horizontal>' in zone, 'Chase <Vertical>-<Horizontal>' outside it.
 */
function getZoneFromLocation(plateSide, plateHeight, handedness) {
  // Signed distance toward the batter, so one set of comparisons covers both hands.
  const towardBatter = handedness === 'LHB' ? -plateSide : plateSide;
  const inZone = Math.abs(plateSide) <= STRIKE_ZONE.HALF_WIDTH &&
    plateHeight >= STRIKE_ZONE.BOTTOM && plateHeight <= STRIKE_ZONE.TOP;

  if (inZone) {
    // Column/row edges are the zone split into equal thirds.
    const colEdge = STRIKE_ZONE.HALF_WIDTH / 3;
    const rowHeight = (STRIKE_ZONE.TOP - STRIKE_ZONE.BOTTOM) / 3;
    const horizontal = towardBatter > colEdge ? 'In' : (towardBatter < -colEdge ? 'Out' : 'Mid');
    const vertical = plateHeight > STRIKE_ZONE.TOP - rowHeight ? 'High'
      : (plateHeight < STRIKE_ZONE.BOTTOM + rowHeight ? 'Low' : 'Mid');
    return `${vertical}-${horizontal}`;
  }

  // Outside: name the miss relative to the zone edges. At least one axis is
  // non-Mid by construction, so this never collides with an in-zone label.
  const horizontal = towardBatter > STRIKE_ZONE.HALF_WIDTH ? 'In'
    : (towardBatter < -STRIKE_ZONE.HALF_WIDTH ? 'Out' : 'Mid');
  const vertical = plateHeight > STRIKE_ZONE.TOP ? 'High'
    : (plateHeight < STRIKE_ZONE.BOTTOM ? 'Low' : 'Mid');
  return `Chase ${vertical}-${horizontal}`;
}

const CHASE_PREFIX = 'Chase ';

/** True for zone labels produced for pitches outside the strike zone. */
function isChaseZone(zone) {
  return typeof zone === 'string' && zone.startsWith(CHASE_PREFIX);
}

// Logic-relevant subset of app.js DEFAULT_SETTINGS. Only used as a fallback when
// neither an explicit settings arg nor the app.js CURRENT_SETTINGS global exists
// (i.e. under node:test). Keep the shared keys in sync with DEFAULT_SETTINGS.
const DEFAULT_LOGIC_SETTINGS = {
  bucketMinPitches: 3,
  hiddenPitchTypes: [],
  pitcherHandFilter: 'All',
  circleColorMode: 'both', // 'both' | 'green' | 'red'
  maxCirclesPerBucket: 1,  // number (1..10) or 'All'
  swingsOnly: false,       // restrict the population to swings (drop called strikes/balls + other)
  ratingSensitivity: 3,    // 1 (strict, most gray) .. 5 (loose, most colour)
};

// Per-pitch outcomes counted as a swing. Taken pitches split by the umpire's
// call ('strike' / 'ball'); 'other' (HBP, etc.) is neither a swing nor a take.
const SWING_OUTCOMES = ['whiff', 'foul', 'hit', 'out'];

/**
 * Pitch family — the bucketing unit for the zone grid.
 *
 * Measured on a season of ALPB data (45 batters with 400+ located pitches), a
 * batter's whiff rate varies 14.9 points BETWEEN families but only 7.2 points
 * WITHIN one — 2.1x. Types inside a family behave alike; families do not. So
 * bucketing by family costs almost nothing in resolution and roughly doubles the
 * sample per bucket (94.9 buckets/batter down to 49.1, and the count with a
 * usable 25+ pitch sample up from 7.4 to 13.3).
 *
 * It also isn't a judgement call we could have avoided: per (family x zone)
 * bucket there are only ~6-10 swings of any one pitch type, where a whiff rate
 * carries a +/-28 to +/-37 point confidence interval. A permutation test over
 * those buckets could not distinguish real type-to-type variation from noise
 * (p=0.46), so the finer grid was never carrying information to begin with.
 *
 * Type-level signal IS real when pooled across zones (~92 swings per type,
 * +/-9 points, p<0.001) — that is what computeArsenal reports.
 *
 * FC (cutter) sits with the fastballs; it is the one genuinely arguable call,
 * at ~2% of pitches.
 */
const PITCH_FAMILY = {
  '4S': 'FB', '2S': 'FB', 'Si': 'FB', 'FC': 'FB', 'FB': 'FB',
  'SL': 'BB', 'CB': 'BB',
  'CH': 'OS', 'SP': 'OS', 'KN': 'OS',
};
const FAMILY_ORDER = ['FB', 'BB', 'OS'];
const FAMILY_LABEL = { FB: 'Fastball', BB: 'Breaking', OS: 'Offspeed' };

// Below this many swings a whiff rate carries a +/-25pt or wider interval, which
// is too loose to show as a number. Rows under the bar keep their counts but
// report no rate.
const ARSENAL_MIN_SWINGS = 15;

/** Maps a pitch-type abbreviation to its family. Unknown types read as fastball,
 *  matching getPitchAbbreviation's own fallback. */
function pitchFamily(pitch) {
  return PITCH_FAMILY[pitch] || 'FB';
}

/**
 * Renders a bucket's `types` tally as "28 4S · 16 Si", commonest first.
 * Counts only — see PITCH_FAMILY for why no rates appear at this level.
 */
function formatComposition(types) {
  return Object.entries(types || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t, n]) => `${n} ${t}`)
    .join(' · ');
}

/** 95% confidence half-width on a proportion (normal approximation). */
function ciHalfWidth(rate, n) {
  if (!n || rate === null || rate === undefined) return null;
  return 1.96 * Math.sqrt((rate * (1 - rate)) / n);
}

/**
 * Per-pitch-type profile for a batter, pooled across ALL zones — the level at
 * which pitch type demonstrably carries signal. Answers "what can't he handle",
 * where the zone grid answers "where".
 *
 * Respects the pitcher-hand filter (an arsenal read should match the hand you
 * are planning against) but deliberately ignores the bucket/colour/display
 * settings, which exist to thin the zone grid, not to describe the batter.
 *
 * @param {Object} batterData - A batter object carrying pitchZones.
 * @param {Object} [settings] - Effective settings (pitcherHandFilter used here).
 * @returns {{families: Array, totalSwings: number, minSwings: number}}
 */
function computeArsenal(batterData, settings) {
  const cfg = resolveSettings(settings);
  const hand = cfg.pitcherHandFilter;
  const population = (batterData.pitchZones || []).filter(z =>
    (hand === 'L' || hand === 'R') ? z.pitcherThrows === hand : true);

  const types = {};
  population.forEach(z => {
    const t = z.pitch;
    if (!types[t]) types[t] = { pitch: t, family: pitchFamily(t), pitches: 0, swings: 0, whiffs: 0 };
    const e = types[t];
    e.pitches++;
    if (SWING_OUTCOMES.includes(z.outcome)) {
      e.swings++;
      if (z.outcome === 'whiff') e.whiffs++;
    }
  });

  const finish = (e) => {
    e.whiffRate = e.swings >= ARSENAL_MIN_SWINGS ? e.whiffs / e.swings : null;
    e.ci = e.whiffRate === null ? null : ciHalfWidth(e.whiffRate, e.swings);
    return e;
  };

  const families = FAMILY_ORDER.map(fam => {
    // A type he never offered at contributes nothing to a whiff-rate table; it
    // would render as an empty "— (0 sw)" row. Its pitches still count toward the
    // family's `pitches` total via the aggregate below.
    const members = Object.values(types)
      .filter(e => e.family === fam && e.swings > 0)
      .sort((a, b) => b.swings - a.swings)
      .map(finish);
    const seen = Object.values(types).filter(e => e.family === fam);
    if (seen.length === 0) return null;
    // Aggregate over everything seen, including never-offered-at types.
    const agg = seen.reduce((a, e) => ({
      pitches: a.pitches + e.pitches, swings: a.swings + e.swings, whiffs: a.whiffs + e.whiffs,
    }), { pitches: 0, swings: 0, whiffs: 0 });
    return finish({ family: fam, label: FAMILY_LABEL[fam], ...agg, types: members });
  }).filter(Boolean);

  return {
    families,
    totalSwings: families.reduce((n, f) => n + f.swings, 0),
    minSwings: ARSENAL_MIN_SWINGS,
  };
}

/**
 * Resolves the effective settings object: explicit arg > app.js global > defaults.
 */
function resolveSettings(settings) {
  if (settings) return settings;
  if (typeof CURRENT_SETTINGS !== 'undefined' && CURRENT_SETTINGS) return CURRENT_SETTINGS;
  return DEFAULT_LOGIC_SETTINGS;
}

// Buckets are (pitch FAMILY x zone) — see PITCH_FAMILY for why the finer
// per-type grid was measuring noise.
function bucketKey(p) { return `${pitchFamily(p.pitch)}|${p.zone}`; }

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
 * Buckets a pitch population by (pitch FAMILY × zone) and rates each bucket on
 * how often a pitch there went the PITCHER's way, against the batter's own
 * baseline for that regime (in-zone or chase). See WIN_OUTCOMES and REGIME_PRIOR.
 *
 * Each bucket keeps a `types` tally of the specific pitch types that composed it
 * (e.g. { '4S': 28, 'Si': 16 }). That composition is reported as raw counts only:
 * per-type RATES inside a single bucket rest on ~6-10 swings and are not
 * distinguishable from noise — see PITCH_FAMILY.
 *
 * Per bucket: `win`/`loss` counts, `winRate` (raw), `shrunkRate` (pulled toward
 * the regime baseline by sample size — this is what the colour is read off),
 * `baseline`, and `delta` (shrunkRate − baseline).
 *
 * @param {Array<Object>} pitches - pitchZone objects ({ pitch, zone, outcome, ... }).
 * @param {Object} [settings] - Effective settings (bucketMinPitches used here).
 * @returns {{ buckets: Object, baselines: {zone: number|null, chase: number|null} }}
 */
function computeBucketRatings(pitches, settings) {
  const cfg = resolveSettings(settings);
  const buckets = {};
  const tally = {};
  REGIMES.forEach(r => { tally[r] = { win: 0, loss: 0 }; });

  pitches.forEach(p => {
    const k = bucketKey(p);
    if (!buckets[k]) {
      const family = pitchFamily(p.pitch);
      buckets[k] = {
        family, label: FAMILY_LABEL[family] || family, zone: p.zone,
        regime: zoneRegime(p.zone), types: {},
        total: 0, hit: 0, out: 0, whiff: 0, strike: 0, ball: 0, foul: 0, other: 0,
        win: 0, loss: 0,
      };
    }
    const b = buckets[k];
    b.total++;
    b.types[p.pitch] = (b.types[p.pitch] || 0) + 1;
    if (b[p.outcome] !== undefined && p.outcome !== 'total') b[p.outcome]++;
    else b.other++;

    if (WIN_OUTCOMES.includes(p.outcome)) { b.win++; tally[b.regime].win++; }
    else if (LOSS_OUTCOMES.includes(p.outcome)) { b.loss++; tally[b.regime].loss++; }
  });

  // The batter's own pitcher-win rate in each regime — what buckets are judged
  // against. Recomputed on whatever population was passed in, so the hand filter
  // and swings-only mode move the baseline with the data.
  const baselines = {};
  REGIMES.forEach(r => {
    const decisive = tally[r].win + tally[r].loss;
    baselines[r] = decisive > 0 ? tally[r].win / decisive : null;
  });

  Object.values(buckets).forEach(b => {
    const decisive = b.win + b.loss;
    const base = baselines[b.regime];
    // What a league-average hitter would give up in this exact spot, at this
    // batter's overall level for the regime.
    const expected = expectedWinRate(b.zone, base);
    b.winRate = decisive > 0 ? b.win / decisive : null;
    b.baseline = base;
    b.expected = expected;
    b.shrunkRate = null;
    b.delta = null;
    b.eliminated = b.total < cfg.bucketMinPitches;
    b.rating = 'neutral';
    b.extremity = -1;

    if (!b.eliminated && expected !== null && decisive > 0) {
      // Empirical-Bayes: pull toward the expectation for this spot with weight k,
      // so thin buckets sit on it and only weight of evidence moves a colour.
      const k = REGIME_PRIOR[b.regime];
      b.shrunkRate = (b.win + k * expected) / (decisive + k);
      b.delta = b.shrunkRate - expected;
      const edge = REGIME_EDGE[b.regime] * sensitivityMultiplier(cfg);
      // Higher pitcher-win rate than his norm = a good place to attack.
      if (b.delta >= edge) b.rating = 'green';
      else if (b.delta <= -edge) b.rating = 'red';
      // Normalised by the regime's edge so in-zone and chase buckets are
      // ordered on one comparable scale.
      b.extremity = Math.abs(b.delta) / edge;
    }
  });
  return { buckets, baselines };
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
    WIN_OUTCOMES,
    LOSS_OUTCOMES,
    REGIME_PRIOR,
    REGIME_EDGE,
    REGIME_LABEL,
    REGIMES,
    ZONE_LEAGUE_OFFSET,
    expectedWinRate,
    SENSITIVITY_MULTIPLIER,
    DEFAULT_SENSITIVITY,
    sensitivityMultiplier,
    zoneRegime,
    DEFAULT_LOGIC_SETTINGS,
    PITCH_FAMILY,
    FAMILY_ORDER,
    FAMILY_LABEL,
    ARSENAL_MIN_SWINGS,
    pitchFamily,
    formatComposition,
    ciHalfWidth,
    computeArsenal,
    STRIKE_ZONE,
    ZONE_SPAN_FRACTION,
    ZONE_PCT,
    plateToPercent,
    getZoneFromLocation,
    isChaseZone,
    resolveSettings,
    bucketKey,
    interleave,
    computeBucketRatings,
    getVisiblePitches,
  };
}
