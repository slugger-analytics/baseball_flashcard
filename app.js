let TEAMS_DATA = {};
let METADATA = null;
// Distinct-batter index for the batter-first flow, from GET /api/batters (cheap,
// no pitch-space scan). Array of { name, ids:[...], team, bats }, sorted by name.
let BATTERS_INDEX = [];
let cachedSeasonData = null;
let cachedDateRange = { start: null, end: null, maxVelocity: null, pitchGroup: null };
// Default settings
const DEFAULT_SETTINGS = {
  // Zone analysis thresholds
  vulnerableZoneMinSwings: 3,
  vulnerableZoneThreshold: 60,
  hotZoneMinHardHits: 2,
  hotZoneHardHitThreshold: 40,
  // Pitch display settings
  maxPitchesDisplayed: 4,
  circleColorMode: 'both',     // 'both' | 'green' | 'red' — which rated circles to show
  pitcherHandFilter: 'All',   // 'All' | 'L' | 'R' — restrict circles to one pitcher hand
  hiddenPitchTypes: [],       // pitch abbreviations (e.g. 'SL') currently hidden from the grid
  bucketMinPitches: 3,        // (pitch family × zone) buckets under this size are dropped from the grid
  ratingSensitivity: 3,       // 1 (strict, most gray) .. 5 (loose, most colour)
  maxCirclesPerBucket: 1,     // circles kept per (pitch type × zone) bucket; 'All' = uncapped
  swingsOnly: false,          // restrict the population to swings (drop takes + other)
  pitchCircleSize: 38
};
let CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };

// Tracks which expandable info sections are open
const EXPANDED_SECTIONS = {
  firstPitch: false,
  outPitch: false,
  threats: false,
  vulnerableZones: false,
  hotZones: false,
};

// When set, the info modal will scroll-highlight this entry after opening
let INFO_MODAL_TARGET = null;

function openInfoModal(sectionId) {
  if (!app) return;
  app.showInfoPanel = true;
  app.render();
  requestAnimationFrame(() => {
    const el = document.getElementById('info-entry-' + sectionId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('info-entry--highlight');
    setTimeout(() => el.classList.remove('info-entry--highlight'), 2000);
  });
}

// Known ALPB season boundaries
const SEASON_2025 = { start: '2025-04-25', end: '2025-09-18' };
const SEASON_2026 = { start: '2026-04-21', end: '2026-09-13' };

/**
 * Computes the default date range for the UI date picker inputs.
 * The start date is always the 2026 season opener (April 21, 2026).
 * - Before the 2026 season: end = season start (placeholder; no data yet).
 * - During the 2026 season: end = today's date (grows dynamically).
 * - After the 2026 season: end = season close.
 * @returns {{ start: string, end: string }} ISO date strings (YYYY-MM-DD).
 */
function getDefaultSeasonDates() {
  const todayStr = new Date().toISOString().slice(0, 10);
  const start = SEASON_2026.start;

  if (todayStr < SEASON_2026.start) {
    // Pre-season: both dates sit at the upcoming season open
    return { start, end: SEASON_2026.start };
  }
  if (todayStr <= SEASON_2026.end) {
    // In-season: end grows with today
    return { start, end: todayStr };
  }
  // Post-season: full 2026 season
  return { start, end: SEASON_2026.end };
}

/**
 * Returns the date range and year label for the "Load Full Season" button.
 * Pre-season loads the last completed season (2025); during the 2026 season it
 * loads opening day through today; after the season it loads the full 2026 run.
 * @returns {{ start: string, end: string, year: number }}
 */
function getFullSeasonRange() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr < SEASON_2026.start) {
    return { start: SEASON_2025.start, end: SEASON_2025.end, year: 2025 };
  }
  const end = todayStr <= SEASON_2026.end ? todayStr : SEASON_2026.end;
  return { start: SEASON_2026.start, end, year: 2026 };
}
/**
 * JSX-like helper that creates a DOM element with props and children.
 * Handles className, style objects, event listeners (onXxx), boolean attributes, and text nodes.
 * @param {string} tag - HTML tag name (e.g. 'div', 'button').
 * @param {Object} [props={}] - Attributes, event handlers, and style overrides.
 * @param {...(Node|string|number|null)} children - Child nodes or text content (flattened).
 * @returns {HTMLElement}
 */
function createElement(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'className') {
      el.className = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.substring(2).toLowerCase(), value);
    } else if (key === 'checked' || key === 'disabled') {
      el[key] = Boolean(value);
    } else {
      el.setAttribute(key, value);
    }
  });
  children.flat().forEach(child => {
    if (child != null) {
      if (typeof child === 'string' || typeof child === 'number') {
        el.appendChild(document.createTextNode(String(child)));
      } else if (child instanceof Node) {
        el.appendChild(child);
      }
    }
  });
  return el;
}
// BUCKET_RATING_EDGE, bucketKey, computeBucketRatings, getVisiblePitches and the
// strike zone geometry (STRIKE_ZONE, ZONE_PCT, plateToPercent, getZoneFromLocation)
// now live in pitch_logic.js (loaded before app.js) so they can be unit-tested
// under node:test and shared with the server. app.js calls them as globals.

/**
 * Builds the strike zone overlay: the zone rectangle plus the two interior lines
 * on each axis that split it into the 9 boxes getZoneFromLocation names.
 *
 * Positioned from ZONE_PCT, the same geometry the server's plateToPercent uses to
 * plot circles, so the drawn rectangle lands exactly where an on-the-edge pitch
 * plots no matter the element's pixel size or aspect ratio. Built from real
 * elements with inline styles rather than a CSS background gradient because iOS
 * Safari drops background images when printing — the same reason the print path
 * used to inject a second, hard-coded set of gridlines.
 */
function createStrikeZoneOverlay() {
  const line = (style) => createElement('div', {
    className: 'strike-zone__line',
    style: { position: 'absolute', backgroundColor: '#cbd5e1', ...style }
  });
  return createElement('div', {
    className: 'strike-zone',
    style: {
      left: `${ZONE_PCT.left}%`,
      top: `${ZONE_PCT.top}%`,
      width: `${ZONE_PCT.right - ZONE_PCT.left}%`,
      height: `${ZONE_PCT.bottom - ZONE_PCT.top}%`
    }
  },
    // Interior thirds, expressed relative to the zone box rather than the canvas.
    line({ top: '0', bottom: '0', left: '33.333%', width: '1px' }),
    line({ top: '0', bottom: '0', left: '66.666%', width: '1px' }),
    line({ left: '0', right: '0', top: '33.333%', height: '1px' }),
    line({ left: '0', right: '0', top: '66.666%', height: '1px' })
  );
}

/**
 * Builds the arsenal table: how the batter handles each pitch type, pooled across
 * all zones.
 *
 * This is the breakdown behind the family labels on the zone graphic. It lives at
 * the batter level rather than per-bucket because that is the only level the data
 * supports — pooled over zones a type carries ~92 swings (+/-9 points, p<0.001);
 * inside one bucket it carries ~6-10 (+/-28 to +/-37, indistinguishable from
 * noise). So the zone graphic answers "where", this answers "what", and neither
 * claims to answer both.
 *
 * Rows under computeArsenal's swing minimum show their counts but no rate.
 * Rendered as real elements (not a hover surface) so it prints — the dugout copy
 * is paper, where there is no hover.
 */
function createArsenal(batterData) {
  const { families, totalSwings, minSwings } = computeArsenal(batterData);
  if (!families.length || totalSwings === 0) return null;

  const pct = (r) => `${(r * 100).toFixed(0)}%`;
  const rateCells = (e) => e.whiffRate === null
    ? [createElement('td', { className: 'arsenal__rate arsenal__rate--thin' }, '—'),
       createElement('td', { className: 'arsenal__ci' }, `${e.swings} sw`)]
    : [createElement('td', { className: 'arsenal__rate' }, pct(e.whiffRate)),
       createElement('td', { className: 'arsenal__ci' }, `±${(e.ci * 100).toFixed(0)} · ${e.swings} sw`)];

  const rows = [];
  families.forEach(f => {
    rows.push(createElement('tr', { className: 'arsenal__family-row' },
      createElement('td', { className: 'arsenal__family' }, f.label),
      ...rateCells(f)
    ));
    // Only worth listing members when the family is actually a mix.
    if (f.types.length > 1) {
      f.types.forEach(e => rows.push(createElement('tr', { className: 'arsenal__type-row' },
        createElement('td', { className: 'arsenal__type' }, e.pitch),
        ...rateCells(e)
      )));
    }
  });

  return createElement('div', { className: 'arsenal' },
    createElement('div', { className: 'arsenal__title' }, 'How he handles each pitch'),
    createElement('table', { className: 'arsenal__table' }, createElement('tbody', {}, ...rows)),
    createElement('div', { className: 'arsenal__foot' },
      `whiff per swing · all zones · rate hidden under ${minSwings} swings`)
  );
}

/**
 * Decodes the server's columnar pitchZones ("pz" columns + metadata.pzLegend)
 * back into the row objects the rest of the app consumes ({ position, pitch,
 * outcome, zone, pitcherThrows } per pitch). The server ships columns because a
 * full-season row-form response overflowed the ALB's 1 MB Lambda-response limit
 * (reaching users as a 502); decoding happens once here so nothing downstream
 * changes. Batters that already carry row-form pitchZones (older server during a
 * deploy) pass through untouched.
 * @param {Object} teamsData - Wire teamsData from GET /api/teams/range.
 * @param {Object|undefined} legend - metadata.pzLegend from the same response.
 * @returns {Object} The same teamsData object with pitchZones materialized.
 */
function decodePitchZones(teamsData, legend) {
  if (!legend) return teamsData;
  Object.values(teamsData).forEach(batters => {
    batters.forEach(batter => {
      if (!batter.pz) {
        if (!batter.pitchZones) batter.pitchZones = [];
        return;
      }
      const { x, y, t, o, z, h } = batter.pz;
      const pitchZones = new Array(x.length);
      for (let i = 0; i < x.length; i++) {
        pitchZones[i] = {
          position: [x[i] / 10, y[i] / 10],
          pitch: legend.t[t[i]],
          outcome: legend.o[o[i]],
          zone: legend.z[z[i]],
          pitcherThrows: legend.h[h[i]],
        };
      }
      batter.pitchZones = pitchZones;
      delete batter.pz;
    });
  });
  return teamsData;
}

function createPitchZone(preFilteredZones, handedness, bucketCtx) {
  const filteredZones = Array.isArray(preFilteredZones) ? preFilteredZones : [];
  const displayZones = filteredZones.slice(0, CURRENT_SETTINGS.maxPitchesDisplayed);

  function showZoneTooltip(circleEl, zone) {
    const b = bucketCtx && bucketCtx.buckets ? bucketCtx.buckets[bucketKey(zone)] : null;
    if (!b) return;
    const existing = document.getElementById('zone-hover-tooltip');
    if (existing) existing.remove();
    const tip = document.createElement('div');
    tip.id = 'zone-hover-tooltip';
    tip.className = 'zone-hover-tooltip';
    const rating = zone.rating || 'neutral';
    const ratingPill = rating === 'green'
      ? `<span class="zone-tooltip-pill zone-tooltip-pill--good">Green · Attack here</span>`
      : rating === 'red'
        ? `<span class="zone-tooltip-pill zone-tooltip-pill--bad">Red · Avoid here</span>`
        : `<span class="zone-tooltip-pill zone-tooltip-pill--neutral">Near average</span>`;
    const handPill = zone.pitcherThrows
      ? `<span class="zone-tooltip-pill zone-tooltip-pill--hand">${zone.pitcherThrows}HP</span>`
      : '';
    // Name the regime, not just "out of zone": a pitch just off the plate and one
    // in the diagonal corner are rated against different baselines.
    const chasePill = b.regime === 'edge'
      ? `<span class="zone-tooltip-pill zone-tooltip-pill--chase">Off the edge</span>`
      : b.regime === 'deep'
        ? `<span class="zone-tooltip-pill zone-tooltip-pill--chase">Well outside</span>`
        : '';
    const pc = (v) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(1)}%`;
    // Colour is read off the SHRUNK rate, so that is the number shown against the
    // baseline. The raw tally sits beside it so a thin bucket is self-evident.
    const decisive = b.win + b.loss;
    const expectedLabel = `Expected here (${REGIME_LABEL[b.regime] || 'overall'})`;
    const deltaTxt = b.delta === null ? '—'
      : `${b.delta >= 0 ? '+' : ''}${(b.delta * 100).toFixed(1)} pts`;
    tip.innerHTML = `
      <div class="zone-tooltip-header">
        <span class="zone-tooltip-title">${b.label} · ${b.zone}</span>
        <span class="zone-tooltip-pills">${ratingPill}${chasePill}${handPill}</span>
      </div>
      <div class="zone-tooltip-composition">${formatComposition(b.types)}</div>
      <table class="zone-tooltip-table">
        <tr><td>Total</td><td>${b.total}</td></tr>
        <tr><td>Whiff (K↩)</td><td>${b.whiff}</td></tr>
        <tr><td>Called strike</td><td>${b.strike}</td></tr>
        <tr><td>Ball</td><td>${b.ball}</td></tr>
        <tr><td>Contact out</td><td>${b.out}</td></tr>
        <tr><td>Contact hit</td><td>${b.hit}</td></tr>
        <tr><td>Foul</td><td>${b.foul}</td></tr>
        ${b.other > 0 ? `<tr><td>Other</td><td>${b.other}</td></tr>` : ''}
        <tr class="zone-tooltip-rate"><td>Pitcher wins</td><td>${b.win}/${decisive} = ${pc(b.winRate)}</td></tr>
        <tr class="zone-tooltip-rate"><td>Adjusted</td><td>${pc(b.shrunkRate)}</td></tr>
        <tr class="zone-tooltip-rate"><td>${expectedLabel}</td><td>${pc(b.expected)}</td></tr>
        <tr class="zone-tooltip-delta"><td>Difference</td><td>${deltaTxt}</td></tr>
      </table>
      <div class="zone-tooltip-note">Win = whiff, called strike, foul or out. A ball counts against the pitcher.
        "Expected" is his level for this part of the plate, corrected for how hard that spot is league-wide —
        so a colour here means this batter is unusual, not that the spot is.</div>`;
    document.body.appendChild(tip);
    const rect = circleEl.getBoundingClientRect();
    const tipW = 180;
    let left = rect.right + 8;
    if (left + tipW > window.innerWidth) left = rect.left - tipW - 8;
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${rect.top + window.scrollY}px`;
  }

  function hideZoneTooltip() {
    const tip = document.getElementById('zone-hover-tooltip');
    if (tip) tip.remove();
  }

  const pitchElements = displayZones.map((zone, idx) => {
    const [x, y] = zone.position || [50, 50];
    // Circles are labelled by FAMILY, the unit buckets are built on. The specific
    // type that produced this particular circle lives in the tooltip composition.
    const pitchType = pitchFamily(zone.pitch);
    const rating = zone.rating || 'neutral';
    const colorClass = rating === 'green' ? 'pitch-circle--good'
      : rating === 'red' ? 'pitch-circle--bad'
      : 'pitch-circle--neutral';
    const pitcherHand = zone.pitcherThrows || '';
    const handClass = pitcherHand === 'L' ? 'pitch-circle__hand--left' : 'pitch-circle__hand--right';
    const isPriority = idx < 4;
    const circleSize = isPriority
      ? Math.round(CURRENT_SETTINGS.pitchCircleSize * 1.25) + 'px'
      : CURRENT_SETTINGS.pitchCircleSize + 'px';
    const el = createElement('div', {
      className: `pitch-circle ${colorClass}`,
      style: { left: `${x}%`, top: `${y}%`, '--pitch-circle-size': circleSize },
      onmouseenter: (e) => showZoneTooltip(e.currentTarget, zone),
      onmouseleave: () => hideZoneTooltip()
    },
      createElement('span', { className: 'pitch-circle__type' }, pitchType),
      pitcherHand ? createElement('span', { className: `pitch-circle__hand ${handClass}` }, pitcherHand) : null
    );
    return el;
  });
  const isLeftHanded = handedness === 'LHB';
  const batterClass = isLeftHanded ? 'batter-graphic-left-handed' : 'batter-graphic-right-handed';
  // Relative paths (matching ./api and ./styles.css) so the batter SVG resolves
  // under the widget base path on Lambda (/widgets/flashcard/) as well as at the
  // Vercel root. Absolute '/rhb.svg' 404'd on the Lambda host.
  const svgPath = isLeftHanded ? './lhb.svg' : './rhb.svg';
  const svgImg = createElement('img', {
    src: svgPath,
    alt: isLeftHanded ? 'Left-Handed Batter' : 'Right-Handed Batter',
    style: { width: '100%', height: '100%', 'object-fit': 'contain' }
  });
  const batterGraphic = createElement('div', {
    className: `batter-graphic ${batterClass}`,
    title: isLeftHanded ? 'Left-Handed Batter' : 'Right-Handed Batter'
  }, svgImg);
  const pitchZone = createElement('div', { className: 'pitch-zone' }, createStrikeZoneOverlay(), ...pitchElements);
  pitchZone.style.setProperty('--pitch-circle-size', `${CURRENT_SETTINGS.pitchCircleSize}px`);
  const el = createElement('div', { className: 'pitch-zone-container' },
    batterGraphic,
    pitchZone
  );
  return { el, count: displayZones.length, available: filteredZones.length };
}
/**
 * Builds the batter header block showing handedness badge, name, and total pitch count.
 * @param {string} handedness - 'LHB' or 'RHB'.
 * @param {string} batterName - Display name of the batter.
 * @param {Array} pitchZones - Raw pitch zone array used only to compute total pitch count.
 * @returns {HTMLElement}
 */
function createBatterGraphic(handedness, batterName, renderedCount, availableCount) {
  const isLeftHanded = handedness === 'LHB';
  const handText = isLeftHanded ? 'LEFT-HANDED BATTER' : 'RIGHT-HANDED BATTER';
  const countLabel = availableCount != null && availableCount !== renderedCount
    ? `Showing: ${renderedCount} / ${availableCount} pitches`
    : `Showing: ${renderedCount} pitches`;
  return createElement('div', { className: 'batter-section' },
    createElement('div', { className: 'handedness-badge' }, handText),
    createElement('div', { className: 'batter-info' },
      createElement('div', { className: 'batter-name' }, batterName || 'Unknown'),
      createElement('div', { className: 'batter-stats' }, countLabel)
    )
  );
}

// Creates an inline "Read more / Show less" toggle using direct DOM manipulation (no re-render)
function makeInfoExpand(...contentItems) {
  const expandDiv = createElement('div', { className: 'info-entry__expanded' }, ...contentItems);
  expandDiv.style.display = 'none';
  let btn;
  btn = createElement('button', {
    className: 'info-read-more-btn',
    onclick: () => {
      const open = expandDiv.style.display !== 'none';
      expandDiv.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Read more ▼' : 'Show less ▲';
    }
  }, 'Read more ▼');
  return [expandDiv, btn];
}

function makeReadMore(sectionKey, expandedContent, appRef) {
  const isOpen = EXPANDED_SECTIONS[sectionKey];
  return createElement('div', { className: 'read-more-area' },
    isOpen ? createElement('div', { className: 'read-more-expanded' }, expandedContent) : null,
    createElement('button', {
      className: 'read-more-btn',
      onclick: (e) => {
        e.stopPropagation();
        EXPANDED_SECTIONS[sectionKey] = !isOpen;
        if (appRef) appRef.render();
      }
    }, isOpen ? 'Show less ▲' : 'Read more ▼')
  );
}

function createTendencies(tendencies, stats, zoneAnalysis, powerSequence, powerSequenceBreakdown) {
const stripPercents = (text) => {
    if (typeof text !== 'string') return text;
    return text
      .replace(/\((\d+)\/(\d+)\s*=\s*\d+%\)/g, '($1 of $2 outs)')
      .replace(/\d+\s*%/g, '')
      .replace(/\s*\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  const safeStats = stats || {};

  // Grab the live slider value for the UI
  const vulnThreshold = app ? CURRENT_SETTINGS.vulnerableZoneThreshold : 45;

  const vulnerableZones = [];
  const hotZones = [];
  if (zoneAnalysis) {
    const zoneScores = {};
    const minPitches = CURRENT_SETTINGS.vulnerableZoneMinSwings;

    Object.entries(zoneAnalysis).forEach(([zone, stats]) => {

      if ((stats.pitches || 0) < minPitches) return;
      // No swings in the zone → whiff/chase rates are undefined (0/0 = NaN)
      if ((stats.swings || 0) === 0) return;

      const whiff_percent = (stats.whiffs / stats.swings) * 100;
      const chase_percent = (stats.fouls / stats.swings) * 100;
      const weakConstant_percent = stats.contact > 0 ? (stats.weakContact / stats.contact) * 100 : 0;
      const hardHit_percent = stats.contact > 0 ? (stats.hardHits / stats.contact) * 100 : 0;

      zoneScores[zone] = { whiff_percent, chase_percent, weakConstant_percent, hardHit_percent, stats };
    });

    const zones = Object.keys(zoneScores);

    if (zones.length > 0) {
      const getRank = (metric) => {
        const values = zones.map(z => zoneScores[z][metric]);
        const sorted = [...values].sort((a, b) => b - a);
        const ranks = {};

        zones.forEach(z => {
          const idx = sorted.findIndex(v => Math.abs(v - zoneScores[z][metric]) < 0.0001);
          ranks[z] = zones.length === 1 ? 100 : ((idx === -1 ? 0 : idx) / (zones.length - 1)) * 100;
        });
        return ranks;
      };
    

      const whiffRanks = getRank('whiff_percent');
      const chaseRanks = getRank('chase_percent');
      const weakContactRanks = getRank('weakConstant_percent');
      const hardHitRanks = getRank('hardHit_percent');

      zones.forEach(zone => {
        const vulnerabilityScore = (
          whiffRanks[zone] * 0.45 +
          weakContactRanks[zone] * 0.35 +
          chaseRanks[zone] * 0.20
        );

        let severity = null;

        if (vulnerabilityScore <= 20) severity = 'CRITICAL';
        else if (vulnerabilityScore <= 35) severity = 'MAJOR';
        else if (vulnerabilityScore <= 60) severity = 'MODERATE';

        if (severity) {
          vulnerableZones.push({zone, score : vulnerabilityScore.toFixed(0), severity})
        }

        // hot zone check
        if (hardHitRanks[zone] >= CURRENT_SETTINGS.hotZoneHardHitThreshold && 
          zoneScores[zone].stats.hardHits >= CURRENT_SETTINGS.hotZoneMinHardHits) {
          hotZones.push({zone, hardHitPct: zoneScores[zone].hardHit_percent.toFixed(0)});
        }
      });
    }
  }
  
  vulnerableZones.sort((a, b) => a.score - b.score);
  hotZones.sort((a, b) => b.hardHitPct - a.hardHitPct);

  const filteredVulnerableZones = vulnerableZones.filter(z => z.score <= vulnThreshold);
  const zoneCap = vulnThreshold <= 20 ? 4 : vulnThreshold <= 35 ? 8 : undefined;
  const cappedVulnerableZones = zoneCap !== undefined ? filteredVulnerableZones.slice(0, zoneCap) : filteredVulnerableZones;

  const hotZoneCap = vulnThreshold <= 20 ? 2 : vulnThreshold <= 35 ? 4 : undefined;
  const cappedHotZones = hotZoneCap !== undefined ? hotZones.slice(0, hotZoneCap) : hotZones;

  // First-pitch approach: server ships "Label (NN%)" (swings ÷ PA′ over 0-0 pitches,
  // graded ±25% vs the league). Secondary line carries the league avg or a pending note.
  let firstPitchText = tendencies?.firstStrike || 'Not enough 0-0 pitches yet';
  let firstPitchSubtext = null;
  if (tendencies) {
    if (tendencies.firstStrikePending) firstPitchSubtext = 'league avg pending';
    else if (tendencies.firstStrikeLeagueAvg != null) firstPitchSubtext = `lg avg ${tendencies.firstStrikeLeagueAvg}%`;
  }
  let sprayText = tendencies?.spray || 'All fields';
  const cleanedPowerSequence = stripPercents(
  (powerSequence && powerSequence !== 'Calculating...') ? powerSequence : 'Insufficient data'
);

  return createElement('div', { className: 'info-section' },
    createElement('div', { className: 'power-sequence stats-box' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'First-Pitch Approach',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('first-pitch'); } }, 'ℹ')
      ),
      createElement('div', { className: 'power-sequence-text' }, firstPitchText),
      firstPitchSubtext ? createElement('div', {
        style: { fontSize: '11px', color: '#94a3b8', marginTop: '2px', textAlign: 'center' }
      }, firstPitchSubtext) : null,
    ),
    cappedVulnerableZones.length > 0 ? createElement('div', { className: 'power-sequence vulnerable-zone' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'Vulnerable Zones',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('vulnerable'); } }, 'ℹ')
      ),
      createElement('div', { className: 'power-sequence-text' },
        cappedVulnerableZones.slice(0, 2).map(z => `${z.zone} (${z.score})`).join(', ')),
    ) : null,
    hotZones.length > 0 ? createElement('div', { className: 'power-sequence hot-zone' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'Hot Zones (Avoid)',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('hot'); } }, 'ℹ')
      ),
      createElement('div', { className: 'power-sequence-text' },
        hotZones.slice(0, 2).map(z => z.zone).join(', ') || 'None identified'),
    ) : null,
    createElement('div', { className: 'power-sequence out-sequence' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'Out Pitch / Sequence',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('out-pitch'); } }, 'ℹ')
      ),
      createElement('div', { className: 'power-sequence-text' }, cleanedPowerSequence),
      powerSequenceBreakdown && (powerSequenceBreakdown.kSwinging + powerSequenceBreakdown.kLooking + powerSequenceBreakdown.contactOut) > 0
        ? createElement('div', { className: 'out-breakdown' },
            createElement('span', { className: 'out-breakdown-item out-breakdown-k-s', title: 'Strikeout swinging (swing-and-miss)' }, `K↩ ${powerSequenceBreakdown.kSwinging}`),
            createElement('span', { className: 'out-breakdown-sep' }, '|'),
            createElement('span', { className: 'out-breakdown-item out-breakdown-k-l', title: 'Strikeout looking (called strike 3)' }, `K👁 ${powerSequenceBreakdown.kLooking}`),
            createElement('span', { className: 'out-breakdown-sep' }, '|'),
            createElement('span', { className: 'out-breakdown-item out-breakdown-contact', title: 'Contact out (ball in play)' }, `Contact ${powerSequenceBreakdown.contactOut}`)
          )
        : null,
      // Own element, never routed through cleanedPowerSequence — stripPercents
      // rewrites "(n/m = p%)" and would merge the two denominators.
      powerSequenceBreakdown && powerSequenceBreakdown.finishLocation &&
      typeof powerSequenceBreakdown.finishLocation.band === 'string' &&
      Number.isFinite(powerSequenceBreakdown.finishLocation.total) &&
      powerSequenceBreakdown.finishLocation.total > 0
        ? (() => {
            const loc = powerSequenceBreakdown.finishLocation;
            return createElement('div', {
              className: 'out-location',
              style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px', textAlign: 'center' },
              title: loc.dominant
                ? `${loc.count} of ${loc.total} located ${loc.pitch} out-pitch finishes were in the ${loc.band} band — ${loc.chase} off the plate, ${loc.count - loc.chase} in the zone. Bands merge a strike-zone box with the chase area just outside it.`
                : `${loc.total} located ${loc.pitch} out-pitch finishes, spread out — the most common band was ${loc.band} with ${loc.count}, short of the 6-and-35% needed to call it a pattern.`
            }, loc.dominant
              ? `${loc.pitch} finishes: ${loc.band} (${loc.count} of ${loc.total}${loc.chase ? `, ${loc.chase} off plate` : ''})`
              : `${loc.pitch} finishes: no dominant spot (${loc.total} tracked)`);
          })()
        : null,
    ),
    createElement('div', { className: 'power-sequence threat-box' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'Threats & Tendencies',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('threats'); } }, 'ℹ')
      ),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Steal:'),
        createElement('span', { className: 'threat-value' }, tendencies?.stealThreat || 'Low (no attempts)')
      ),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Bunt:'),
        createElement('span', { className: 'threat-value' }, tendencies?.buntThreat || 'Low (no bunts)')
      ),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Spray:'),
        createElement('span', { className: 'threat-value' }, sprayText)
      ),
    )
  );
}

class FlashcardApp {
  constructor(container) {
    this.container = container;
    // Batter-first flow: start on a loading screen while the cheap batter index
    // loads, then land on the batter picker (not a whole-season date fetch).
    this.currentScreen = 'loading';
    this.selectedTeam = null;
    this.selectedBatterIndex = 0;
    this.selectedBatterInfo = null;   // { name, ids, team, bats } chosen in the picker
    this.batterQuery = '';            // live search text on the batter picker
    this.lastMaxVelocity = 105;       // retained pitch-window scope for Prev/Next + re-scope
    this.showInfoPanel = false;
    this.showSettingsPanel = false;
    // Settings live in an always-visible docked sidebar by default (never printed).
    // On mobile the docked sidebar stacks BELOW the card (see styles.css
    // @media max-width:768px), so it can start docked everywhere without covering
    // the flashcard. Users hide it on demand via the "⚙ Hide Settings" button.
    this.isSettingsDocked = true;
    this.sortBy = 'number';
    this.sortOrder = 'asc';
    const defaults = getDefaultSeasonDates();
    this.lastStartDate = defaults.start;
    this.lastEndDate = defaults.end;
    this.ensurePrintContainers();
    this.loadBattersIndex();
  }
  ensurePrintContainers() {
    if (!document.getElementById('print-container')) {
      const single = document.createElement('div');
      single.id = 'print-container';
      document.body.appendChild(single);
    }
    if (!document.getElementById('lineup-print-container')) {
      const lineup = document.createElement('div');
      lineup.id = 'lineup-print-container';
      document.body.appendChild(lineup);
    }
  }
  getPrintContainer(id) {
    this.ensurePrintContainers();
    return document.getElementById(id);
  }
buildPrintPage(batter, teamName, orderIndex) {
    const metaBits = [];
    if (teamName) metaBits.push(teamName);
    if (typeof orderIndex === 'number') metaBits.push(`#${orderIndex + 1}`);
    if (batter.handedness) metaBits.push(batter.handedness);
    metaBits.push(`${batter.stats?.totalPitches || 0} pitches`);
    const isLowData = (batter.stats?.totalPitches || 0) < 50;
    const header = createElement('div', { className: 'header' },
      createElement('div', { className: 'header__title' },
        createElement('span', { className: 'name' }, batter.batter || 'Unknown'),
        metaBits.length ? createElement('span', { className: 'meta' }, metaBits.join(' • ')) : null,
        isLowData ? createElement('span', { className: 'low-data-badge', title: 'Limited Trackman data' }, '⚠ Low Data') : null
      )
    );
    
    const { pitches: printPitches, bucketCtx: printBucketCtx } = getVisiblePitches(batter);
    const { el: pitchZoneInnerPrint } = createPitchZone(printPitches, batter.handedness, printBucketCtx);
    
    // THE iOS PRINT HACK: force a physical white background block behind everything.
    // The grid itself no longer needs injecting here — createStrikeZoneOverlay already
    // builds it from real elements with inline styles, positioned from the shared
    // ZONE_PCT geometry. The old hard-coded 33.33%/66.66% lines spanned the whole
    // canvas and would now contradict the drawn strike zone.
    const zoneEl = pitchZoneInnerPrint.querySelector('.pitch-zone');
    if (zoneEl) {
      const whiteBase = createElement('div', {
        style: { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', backgroundColor: '#ffffff', zIndex: '0' }
      });
      zoneEl.insertBefore(whiteBase, zoneEl.firstChild);
    }

    const pitchSection = createElement('div', { className: 'pitch-zone-section' }, pitchZoneInnerPrint);
    const infoSection = createTendencies(batter.tendencies, batter.stats, batter.zoneAnalysis, batter.powerSequence, batter.powerSequenceBreakdown);
    const widget = createElement('div', { className: 'widget print-widget' },
      header,
      pitchSection,
      createArsenal(batter),
      infoSection
    );
    return createElement('div', { className: 'print-page' }, widget);
  }
printCurrentCard() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    if (!lineup || lineup.length === 0) return;
    
    // CLEAR BOTH CONTAINERS TO PREVENT GHOST PRINTING
    const singleContainer = this.getPrintContainer('print-container');
    const lineupContainer = this.getPrintContainer('lineup-print-container');
    singleContainer.innerHTML = '';
    lineupContainer.innerHTML = '';

    const batter = lineup[this.selectedBatterIndex];
    singleContainer.appendChild(this.buildPrintPage(batter, this.selectedTeam, this.selectedBatterIndex));

    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 0.75);
    singleContainer.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`)
    });

    const savedScroll = window.scrollY;
    setTimeout(() => {
      window.print();
      setTimeout(() => window.scrollTo(0, savedScroll), 500); 
    }, 150); 
  }

  printLineup() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    if (!lineup || lineup.length === 0) return;
    
    // CLEAR BOTH CONTAINERS TO PREVENT GHOST PRINTING
    const singleContainer = this.getPrintContainer('print-container');
    const lineupContainer = this.getPrintContainer('lineup-print-container');
    singleContainer.innerHTML = '';
    lineupContainer.innerHTML = '';

    lineup.forEach((batter, idx) => {
      lineupContainer.appendChild(this.buildPrintPage(batter, this.selectedTeam, idx));
    });

    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 0.75);
    lineupContainer.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`)
    });

    const savedScroll = window.scrollY;
    setTimeout(() => {
      window.print();
      setTimeout(() => window.scrollTo(0, savedScroll), 500); 
    }, 150);
  }
  toggleInfo() {
    this.showInfoPanel = !this.showInfoPanel;
    this.render();
  }
  toggleSettings() {
    if (this.isSettingsDocked) {
      this.isSettingsDocked = false;
    } else {
      this.isSettingsDocked = true;
      this.showSettingsPanel = false;
    }
    this.render();
  }
  toggleDock() {
    this.isSettingsDocked = !this.isSettingsDocked;
    // When docking, ensure panel is open; when undocking, close panel
    this.showSettingsPanel = this.isSettingsDocked ? false : false;
    this.render();
  }
  updateSetting(key, value) {
    CURRENT_SETTINGS[key] = value;
    this.render();
  }
  updatePitchZone() {
    const pzSection = this.container.querySelector('.pitch-zone-section');
    if (!pzSection) return;
    const lineup = TEAMS_DATA[this.selectedTeam];
    if (!lineup) return;
    const data = lineup[this.selectedBatterIndex];
    if (!data) return;
    const { pitches: visiblePitches, bucketCtx } = getVisiblePitches(data);
    const { el } = createPitchZone(visiblePitches, data.handedness, bucketCtx);
    pzSection.innerHTML = '';
    pzSection.appendChild(el);
  }
  resetSettings() {
    CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };
    this.render();
  }

  /**
   * Clears the pitch-scoped display selections so one batter's choices never
   * carry over to the next (hidden pitch types, pitcher-hand split, good/bad-only).
   * Purely visual prefs (circle size, max displayed) are intentionally kept.
   */
  resetBatterScopedSettings() {
    CURRENT_SETTINGS.pitcherHandFilter = 'All';
    CURRENT_SETTINGS.hiddenPitchTypes = [];
    CURRENT_SETTINGS.circleColorMode = 'both';
    CURRENT_SETTINGS.maxCirclesPerBucket = 1;
    CURRENT_SETTINGS.swingsOnly = false;
  }

  /**
   * Loads the distinct-batter index from GET /api/batters (cheap — built from the
   * server's in-memory player cache, no pitch-space scan) and lands on the picker.
   */
  async loadBattersIndex() {
    try {
      this.currentScreen = 'loading';
      this.loadingParams = null; // null => "loading the batter list" variant
      this.render();

      const response = await fetch('./api/batters');
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.batters)) {
        throw new Error(data.message || `Failed to load batters (${response.status})`);
      }

      BATTERS_INDEX = data.batters;
      this.currentScreen = 'batterSelect';
      this.render();
    } catch (err) {
      console.error(err);
      this.error = `Could not load the batter list: ${err.message}`;
      this.currentScreen = 'error';
      this.render();
    }
  }

  /**
   * Selects a batter from the picker and loads their card for the default full-season
   * window. This is step 1 of the inverted flow — every pitch query after this is
   * scoped to the chosen batter.
   * @param {{name:string, ids:string[], team:string, bats:string}} batter
   */
  selectBatter(batter) {
    this.selectedBatterInfo = batter;
    this.resetBatterScopedSettings();
    const season = getFullSeasonRange();
    const dateLabel = season.year === 2026 ? '2026 Season' : `Full ${season.year} Season`;
    this.loadBatterCard(season.start, season.end, 105, 'All', dateLabel);
  }

  /**
   * Fetches the scoped scouting card for the currently selected batter from
   * GET /api/batter/card (filtered by batter_id — never the whole pitch space).
   * @param {string} startDate - ISO date (YYYY-MM-DD).
   * @param {string} endDate - ISO date (YYYY-MM-DD).
   * @param {number} [maxVelocity=105] - Upper velocity cap (mph).
   * @param {string} [pitchGroup='All'] - 'All' | 'Fastballs' | 'Breaking' | 'Offspeed'.
   * @param {string|null} [dateLabel=null] - Friendly window label for the loading screen.
   */
  async loadBatterCard(startDate, endDate, maxVelocity = 105, pitchGroup = 'All', dateLabel = null) {
    const batter = this.selectedBatterInfo;
    if (!batter || !batter.ids || batter.ids.length === 0) {
      this.currentScreen = 'batterSelect';
      this.render();
      return;
    }

    // Retain the window so Prev/Next and re-scopes reuse it.
    this.lastStartDate = startDate;
    this.lastEndDate = endDate;
    this.lastMaxVelocity = maxVelocity;
    this.lastPitchGroup = pitchGroup;

    try {
      this.currentScreen = 'loading';
      const pitchLabel = { All: 'All Pitches', Fastballs: 'Fastballs', Breaking: 'Breaking Balls', Offspeed: 'Offspeed' }[pitchGroup] || 'All Pitches';
      this.loadingParams = { pitchGroup: pitchLabel, maxVelocity, startDate, endDate, dateLabel, batterName: batter.name };
      this.render();

      const ids = encodeURIComponent(batter.ids.join(','));
      const response = await fetch(
        `./api/batter/card?batterIds=${ids}&startDate=${startDate}&endDate=${endDate}&maxVelocity=${maxVelocity}&pitchGroup=${pitchGroup}`
      );
      const data = await response.json();

      if (!response.ok) {
        const code = data.error || 'unknown';
        if (code === 'no_data' || code === 'no_data_velocity') {
          this.noDataMessage = data.message || 'No pitch data found for this batter in the selected window.';
          this.currentScreen = 'batterNoData';
          this.render();
          return;
        }
        this.error = data.message || `Error loading data (${response.status})`;
        this.currentScreen = 'error';
        this.render();
        return;
      }

      if (!data.teamsData || Object.keys(data.teamsData).length === 0) {
        this.noDataMessage = 'No pitch data found for this batter in the selected window.';
        this.currentScreen = 'batterNoData';
        this.render();
        return;
      }

      decodePitchZones(data.teamsData, data.metadata && data.metadata.pzLegend);
      TEAMS_DATA = data.teamsData;
      METADATA = data.metadata;

      // The scoped response holds only this batter (two profiles if a switch hitter,
      // split across teams only if traded mid-season). Show the profile with the most
      // pitches so a switch hitter opens on his primary side.
      const teamKeys = Object.keys(TEAMS_DATA);
      this.selectedTeam = teamKeys.reduce((best, t) => {
        const tp = TEAMS_DATA[t].reduce((s, b) => s + (b.stats?.totalPitches || 0), 0);
        const bp = TEAMS_DATA[best].reduce((s, b) => s + (b.stats?.totalPitches || 0), 0);
        return tp > bp ? t : best;
      }, teamKeys[0]);
      const roster = TEAMS_DATA[this.selectedTeam];
      this.selectedBatterIndex = roster.reduce((best, b, i) =>
        (b.stats?.totalPitches || 0) > (roster[best].stats?.totalPitches || 0) ? i : best, 0);

      this.currentScreen = 'flashcard';
      this.setupKeyboard();
      this.render();
    } catch (err) {
      console.error(err);
      this.error = `Error loading data: ${err.message}`;
      this.currentScreen = 'error';
      this.render();
    }
  }

  /**
   * Moves to the previous/next batter in the alphabetical index, reusing the
   * current pitch window. Each hop is a fresh scoped query for that batter only.
   * @param {number} delta - +1 for next, -1 for previous.
   */
  gotoAdjacentBatter(delta) {
    if (!BATTERS_INDEX.length || !this.selectedBatterInfo) return;
    const cur = this.selectedBatterInfo;
    let idx = BATTERS_INDEX.findIndex(b => b.name === cur.name && b.ids[0] === cur.ids[0]);
    if (idx < 0) idx = BATTERS_INDEX.findIndex(b => b.name === cur.name);
    if (idx < 0) return;
    const next = BATTERS_INDEX[(idx + delta + BATTERS_INDEX.length) % BATTERS_INDEX.length];
    this.selectedBatterInfo = next;
    this.resetBatterScopedSettings();
    this.loadBatterCard(this.lastStartDate, this.lastEndDate, this.lastMaxVelocity, this.lastPitchGroup || 'All');
  }

  showBatterSelect() {
    this.currentScreen = 'batterSelect';
    this.validationError = null;
    this.noDataError = null;
    this.render();
  }

  showWindowSelect() {
    this.currentScreen = 'dateSelect';
    this.validationError = null;
    this.noDataError = null;
    this.render();
  }

/**
   * Fetches processed pitch data for the given date range from GET /api/teams/range.
   * Transitions the app through loading → teamSelect on success, or shows contextual error messages
   * for future dates, empty results, or velocity-filtered empty results.
   * @param {string} startDate - ISO date string (YYYY-MM-DD).
   * @param {string} endDate - ISO date string (YYYY-MM-DD).
   * @param {number} [maxVelocity=105] - Upper velocity cap in mph.
   * @param {string|null} [customLoadingMessage=null] - Override for the loading screen message.
   * @param {string} [pitchGroup='All'] - Pitch type filter: 'All', 'Fastballs', 'Breaking', or 'Offspeed'.
   * @returns {Promise<void>}
   */
  async loadDataRange(startDate, endDate, maxVelocity = 105, seasonYear = null, pitchGroup = 'All', dateLabel = null) {
    // Season-scale loads work but take a while; if one still fails (timeout,
    // transient error), show a clear message instead of a raw 502.
    const spanDays = Math.round((new Date(endDate) - new Date(startDate)) / 86400000);
    const tooLargeMessage = 'This large date range could not finish loading. Season-scale loads can take a couple of minutes — please try again, or pick a shorter range.';
try {
      this.currentScreen = 'loading';

      const pitchLabel = { All: 'All Pitches', Fastballs: 'Fastballs', Breaking: 'Breaking Balls', Offspeed: 'Offspeed' }[pitchGroup] || 'All Pitches';
      // --- CACHE CHECK ---
      const cacheCoversRange =
        cachedSeasonData !== null &&
        cachedDateRange.start !== null &&
        startDate >= cachedDateRange.start &&
        endDate <= cachedDateRange.end &&
        cachedDateRange.maxVelocity === String(maxVelocity) &&
        cachedDateRange.pitchGroup === pitchGroup;

      if (cacheCoversRange) {
        TEAMS_DATA = cachedSeasonData.teamsData;
        METADATA = cachedSeasonData.metadata;
        this.currentScreen = 'teamSelect';
        this.render();
        return;
      }

      this.loadingParams = { pitchGroup: pitchLabel, maxVelocity, seasonYear, startDate, endDate, dateLabel };
      this.render();

      const response = await fetch(
        `./api/teams/range?startDate=${startDate}&endDate=${endDate}&maxVelocity=${maxVelocity}&pitchGroup=${pitchGroup}`
      );

      const data = await response.json();

      if (!response.ok) {
        // Parse error response and set contextual message
        this.currentScreen = 'error';
        const errorCode = data.error || 'unknown';

        if (errorCode === 'future_date') {
          this.error = 'The selected end date is in the future. Please select a date up to today.';
          this.currentScreen = 'error';
        } else if (errorCode === 'no_data') {
          this.noDataError = 'No pitch data found for this date range. The season may not have started yet.';
          this.currentScreen = 'dateSelect';
        } else if (errorCode === 'no_data_velocity') {
          this.noDataError = `No pitch data found for the velocity range you selected (≤${maxVelocity} MPH). Try increasing the maximum velocity.`;
          this.currentScreen = 'dateSelect';
        } else {
          this.error = spanDays > 65
            ? tooLargeMessage
            : (data.message || `Error loading data (${response.status})`);
          this.currentScreen = 'error';
        }

        this.render();
        return;
      }

      if (!data.teamsData || Object.keys(data.teamsData).length === 0) {
        this.noDataError = 'No pitch data found for this date range. The season may not have started yet.';
        this.currentScreen = 'dateSelect';
        this.render();
        return;
      }

      decodePitchZones(data.teamsData, data.metadata && data.metadata.pzLegend);

      // --- CACHE WRITE ---
      cachedSeasonData = { teamsData: data.teamsData, metadata: data.metadata };
      cachedDateRange  = { start: startDate, end: endDate, maxVelocity: String(maxVelocity), pitchGroup };

      TEAMS_DATA = data.teamsData;
      METADATA = data.metadata;
      this.currentScreen = 'teamSelect';
      this.render();
    } catch (err) {
      console.error(err);
      this.currentScreen = 'error';
      this.error = spanDays > 65 ? tooLargeMessage : `Error loading data: ${err.message}`;
      this.render();
    }
  }

  /**
   * Resolves a smart date range from a day-count shortcut or the full season default,
   * then delegates to loadDataRange. Reads maxVelocity and pitchGroup from the DOM.
   * @param {number|null} days - Number of trailing days to load (7 or 30), or null for full season.
   */
  fetchSmartData(days) {
      const maxVel = document.getElementById('maxVelocity').value;
      const pitchGroup = document.getElementById('pitchGroup').value;
      let startStr = '';
      let endStr = '';
      let seasonYear = null;

      if (days) {
          const end = new Date();
          const start = new Date();
          start.setDate(end.getDate() - days);

          const formatDate = (d) => {
              const year = d.getFullYear();
              const month = String(d.getMonth() + 1).padStart(2, '0');
              const day = String(d.getDate()).padStart(2, '0');
              return `${year}-${month}-${day}`;
          };
          startStr = formatDate(start);
          endStr = formatDate(end);

          if (startStr < SEASON_2026.start) {
              this.validationError = `Insufficient data for ${days} days. The current season started on ${SEASON_2026.start}. Please select a Custom Date Range.`;
              this.noDataError = null;
              this.render();
              return;
          }
      } else {
          const season = getFullSeasonRange();
          startStr  = season.start;
          endStr    = season.end;
          seasonYear = season.year;
      }

      // retain the dates in the calendar memory
      this.lastStartDate = startStr;
      this.lastEndDate = endStr;
      const dateLabel = days === 7 ? 'Last 7 Days' : days === 30 ? 'Last 30 Days' : null;
      // Batter-first flow: the window fetch is scoped to the already-chosen batter.
      this.loadBatterCard(startStr, endStr, maxVel, pitchGroup, dateLabel);
}

  showDateSelect() {
    this.currentScreen = 'dateSelect';
    this.validationError = null;
    this.noDataError = null;
    cachedSeasonData = null;
    cachedDateRange = { start: null, end: null, maxVelocity: null, pitchGroup: null };
    this.render();
  }
  showTeamSelect() { this.currentScreen = 'teamSelect'; this.selectedTeam = null; this.render(); }
  showLineup(team) {
    this.currentScreen = 'lineup';
    this.selectedTeam = team;
    this.render();
  }
  showFlashcard(index) { this.currentScreen = 'flashcard'; this.selectedBatterIndex = index; this.setupKeyboard(); this.render(); }
  setupKeyboard() {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = e => {
      if (this.currentScreen !== 'flashcard') return;
      // Arrows now browse the batter index (each hop is a fresh scoped query).
      if (e.key === 'ArrowRight') {
        this.gotoAdjacentBatter(1);
      } else if (e.key === 'ArrowLeft') {
        this.gotoAdjacentBatter(-1);
      }
    };
    window.addEventListener('keydown', this.keyHandler);
  }
  renderLoading() {
    const dotsSpan = createElement('span', { id: 'loading-dots' }, '');
    let dotCount = 0;
    const interval = setInterval(() => {
      const el = document.getElementById('loading-dots');
      if (!el) { clearInterval(interval); return; }
      dotCount = (dotCount + 1) % 4;
      el.textContent = '.'.repeat(dotCount);
    }, 500);

    // Initial batter-index load has no window params — show a lightweight message.
    if (!this.loadingParams) {
      return createElement('div', { className: 'team-select-screen loading-screen' },
        createElement('h1', {}, 'Loading Batters', dotsSpan),
        createElement('p', { className: 'loading-subtitle' }, 'Fetching the batter list')
      );
    }

    const params = this.loadingParams || {};
    const pillRow = [
      params.batterName ? createElement('div', { className: 'filter-pill pill-season' }, params.batterName) : null,
      createElement('div', { className: 'filter-pill pill-pitch' }, params.pitchGroup || 'All Pitches'),
      createElement('div', { className: 'filter-pill pill-velo' }, `≤ ${params.maxVelocity || 105} MPH`),
    ].filter(Boolean);
    let seasonText;
    if (params.dateLabel) {
      seasonText = params.dateLabel;
    } else if (params.seasonYear) {
      seasonText = `${params.seasonYear} Season`;
    } else {
      const fmt = d => { if (!d) return '?'; const [y,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`; };
      seasonText = `${fmt(params.startDate)} → ${fmt(params.endDate)}`;
    }
    pillRow.push(createElement('div', { className: 'filter-pill pill-season' }, seasonText));

    return createElement('div', { className: 'team-select-screen loading-screen' },
      createElement('h1', {}, 'Loading', dotsSpan),
      createElement('p', { className: 'loading-subtitle' }, 'This may take a few minutes'),
      createElement('div', { className: 'filter-pill-row' }, ...pillRow)
    );
  }
  renderError() {
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Error Loading Data'),
      createElement('div', {
        style: {
          backgroundColor: '#ffe6e6',
          border: '2px solid #d32f2f',
          borderRadius: '8px',
          padding: '20px',
          marginBottom: '20px',
          color: '#c62828',
          fontSize: '16px',
          lineHeight: '1.5'
        }
      }, this.error),
      createElement('button', { className: 'team-btn', onclick: () => (BATTERS_INDEX.length ? this.showBatterSelect() : this.loadBattersIndex()) }, 'Back to Batters')
    );
  }
  renderDateSelect() {
    // Reached AFTER a batter is chosen: this narrows the pitch window for that
    // one batter (every load here is scoped to the selected batter's pitches).
    const batterName = this.selectedBatterInfo ? this.selectedBatterInfo.name : 'Batter';

    return createElement('div', { className: 'team-select-screen' },
      this.selectedBatterInfo ? createElement('button', { className: 'back-btn', style: { marginBottom: '12px' }, onclick: () => this.loadBatterCard(this.lastStartDate, this.lastEndDate, this.lastMaxVelocity, this.lastPitchGroup || 'All') }, '← Back to Card') : null,
      createElement('h1', {}, `Pitch Window — ${batterName}`),
      createElement('p', { style: { 'margin-bottom': '20px', opacity: '0.8', fontSize: '15px', color: '#64748b', lineHeight: '1.4' } },
        'Adjust the Velocity, Pitch Type, and Timeframe, then reload this batter’s card'
      ),

      createElement('div', {
        style: {
          'max-width': '600px', margin: '0 auto', display: 'flex',
          'flex-direction': 'column', gap: '25px', backgroundColor: '#f8f9fa',
          padding: '25px', borderRadius: '12px', border: '1px solid #e9ecef'
        }
      },
        
        // 1. The Velocity Slider
        createElement('div', {},
          createElement('label', { style: { display: 'block', 'margin-bottom': '10px', 'font-weight': 'bold', 'font-size': '16px' } }, 
            'Maximum Pitch Velocity'
          ),
          createElement('input', {
            id: 'maxVelocity', type: 'range', min: '0', max: '105', value: '105',
            style: { cursor: 'pointer' },
            oninput: (e) => {
              const val = e.target.value;
              const velDisplay = document.getElementById('velValue');
              velDisplay.innerText = val + ' MPH';
              
              // Calculate the exact percentage of the slider (0.0 to 1.0)
              const percent = val / 105;
              
              // Blend Light Blue (59, 130, 246) into Dark Navy (30, 41, 59)
              const r = Math.round(59 - (percent * (59 - 30)));
              const g = Math.round(130 - (percent * (130 - 41)));
              const b = Math.round(246 - (percent * (246 - 59)));
              
              velDisplay.style.color = `rgb(${r}, ${g}, ${b})`;
            }
          }),
          // Make sure the starting color matches the Light Blue exactly
          createElement('div', { id: 'velValue', style: { textAlign: 'center', fontSize: '20px', fontWeight: 'bold', marginTop: '10px', color: '#3b82f6', transition: 'color 0.1s ease' } }, '105 MPH')
          ),

          // 1.5 Pitch Group Selector (Ryan Dull Feature)
// 1.5 Pitch Group Selector (Ryan Dull Feature) - Button Version
        createElement('div', { style: { marginTop: '15px' } },
          createElement('label', { style: { display: 'block', 'margin-bottom': '10px', 'font-weight': 'bold', 'font-size': '16px' } }, 
            'Pitch Type Filter'
          ),
          
          // Hidden input to safely store the selected value for API calls
          createElement('input', { type: 'hidden', id: 'pitchGroup', value: this.lastPitchGroup || 'All' }),

          // The container for the 4 buttons
          createElement('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
            ...['All', 'Fastballs', 'Breaking', 'Offspeed'].map(group => {
              const isSelected = (this.lastPitchGroup || 'All') === group;
              
              // Map the button labels and the spelled-out tooltip text
              let label = '';
              let tooltipText = '';
              let hasIcon = true;
              
              if (group === 'All') { 
                label = 'All Pitches'; 
                hasIcon = false; 
              } else if (group === 'Fastballs') {
                label = 'Fastballs Only';
                tooltipText = 'Includes: 4S (Four-Seam), Si (Sinker), FC (Cutter)';
              } else if (group === 'Breaking') {
                label = 'Breaking Balls Only';
                tooltipText = 'Includes: SL (Slider), CB (Curveball)';
              } else if (group === 'Offspeed') {
                label = 'Offspeed Only';
                tooltipText = 'Includes: CH (Changeup), SP (Splitter)';
              }

              const btnClass = isSelected ? 'pitch-filter-btn active' : 'pitch-filter-btn inactive';

              // Create the info icon with the fully spelled out pitch types in the tooltip
              const icon = hasIcon ? createElement('span', {
                className: 'pitch-info-icon',
                title: tooltipText,
                onclick: (e) => {
                  e.stopPropagation();
                  let tip = document.getElementById('mobile-pitch-tip');
                  if (tip) { tip.remove(); return; }
                  tip = document.createElement('div');
                  tip.id = 'mobile-pitch-tip';
                  tip.textContent = tooltipText;
                  Object.assign(tip.style, { position: 'fixed', background: '#1e293b', color: '#f8fafc', fontSize: '13px', padding: '8px 12px', borderRadius: '8px', zIndex: '9999', maxWidth: '240px', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', top: (e.clientY - 60) + 'px', left: Math.min(e.clientX - 60, window.innerWidth - 260) + 'px' });
                  document.body.appendChild(tip);
                  setTimeout(() => tip && tip.remove(), 3000);
                }
              }, 'ⓘ') : null;

              // Create the individual button
              return createElement('button', {
                className: btnClass,
                onclick: (e) => {
                  // 1. Update the hidden input value
                  document.getElementById('pitchGroup').value = group;
                  this.lastPitchGroup = group; // Remember selection for re-renders

                  // 2. Visually update all buttons in this row
                  const parent = e.currentTarget.parentElement;
                  Array.from(parent.children).forEach(child => {
                    child.className = 'pitch-filter-btn inactive';
                  });
                  e.currentTarget.className = 'pitch-filter-btn active';
                }
              }, label, icon);
            })
          )
        ),



        // 3. Quick Options (Smaller, secondary buttons)
createElement('div', {},
          createElement('label', { style: { display: 'block', 'margin-bottom': '10px', 'font-weight': 'bold', 'font-size': '16px' } }, 
            'Time Period'
          ),
          createElement('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' } },
            // Primary/default load: full-width, Deep Navy, labeled as the default
            createElement('button', {
              className: 'team-btn',
              style: { padding: '12px 10px', fontSize: '15px', flexBasis: '100%', background: 'rgb(26, 71, 143)', border: 'none', boxShadow: 'none' },
              onclick: () => this.fetchSmartData(null)
            },
              ...(() => {
                const fs = getFullSeasonRange();
                const todayStr = new Date().toISOString().slice(0, 10);
                const inSeason = fs.year === 2026 && fs.end === todayStr;
                return [
                  createElement('div', { style: { fontWeight: '700' } },
                    inSeason ? '2026 Season to Date' : `Full ${fs.year} Season`),
                  createElement('div', { style: { fontSize: '11px', fontWeight: '500', opacity: '0.85', marginTop: '2px' } },
                    inSeason ? 'Default · opening day through today' : 'Default · full season')
                ];
              })()
            ),
            createElement('button', {
              // Uses standard "Load Custom Range" blue
              className: 'team-btn', style: { padding: '8px 10px', fontSize: '13px', flex: 1, minWidth: '130px' },
              onclick: () => this.fetchSmartData(7)
            }, 'Load Last 7 Days'),
            createElement('button', {
              // Uses standard "Load Custom Range" blue
              className: 'team-btn', style: { padding: '8px 10px', fontSize: '13px', flex: 1, minWidth: '130px' },
              onclick: () => this.fetchSmartData(30)
            }, 'Load Last 30 Days'),
          )
        ),

// 2. Custom Date Range (Main Feature with Calendar Pickers)
        createElement('div', { style: { padding: '15px', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #dee2e6' } },
          createElement('label', { style: { display: 'block', 'margin-bottom': '15px', 'font-weight': 'bold', 'font-size': '16px' } }, 
            'Custom Date Range'
          ),
          createElement('div', { className: 'date-inputs-row' },
            //TODO: new fix for ios

createElement('div', { style: { flex: 1 } },
              createElement('label', { style: { display: 'block', fontSize: '12px', marginBottom: '5px', color: '#666' } }, 'Start Date'),
              createElement('input', {
                id: 'startDate', type: 'date',
                value: this.lastStartDate || '',
                style: { width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer', fontSize: '14px', boxSizing: 'border-box' }
              })
            ),
            createElement('div', { style: { flex: 1 } },
              createElement('label', { style: { display: 'block', fontSize: '12px', marginBottom: '5px', color: '#666' } }, 'End Date'),
              createElement('input', {
                id: 'endDate', type: 'date',
                value: this.lastEndDate || '',
                style: { width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer', fontSize: '14px', boxSizing: 'border-box' }
              })
            )
          // TODO: end
          ),
          createElement('button', {
            className: 'team-btn', style: { width: '100%', padding: '12px', fontSize: '16px' },
            onclick: () => {
              const maxVel = document.getElementById('maxVelocity').value;
              const pitchGroup = document.getElementById('pitchGroup').value;
              const startRaw = document.getElementById('startDate').value;
              const endRaw = document.getElementById('endDate').value;

              if (!startRaw || !endRaw) {
                this.validationError = 'Please select both a Start Date and an End Date before loading.';
                this.noDataError = null;
                this.render();
                return;
              }

              if (endRaw < startRaw) {
                this.validationError = 'Invalid Date Range: End date cannot be before start date.';
                this.noDataError = null;
                this.render();
                return;
              }

              this.validationError = null;
              this.noDataError = null;
              this.lastStartDate = startRaw;
              this.lastEndDate = endRaw;
              // Batter-first flow: the custom window fetch is scoped to the chosen batter.
              this.loadBatterCard(startRaw, endRaw, maxVel, pitchGroup);
            }
          }, 'Load Custom Range'),
          this.validationError ? createElement('div', {
            style: {
              marginTop: '10px', backgroundColor: '#ffe6e6', border: '2px solid #d32f2f',
              borderRadius: '6px', padding: '12px', color: '#c62828', fontSize: '14px'
            }
          }, this.validationError) : null,
          this.noDataError ? createElement('div', {
            style: {
              marginTop: '10px', backgroundColor: '#ffe6e6', border: '2px solid #d32f2f',
              borderRadius: '6px', padding: '12px', color: '#c62828', fontSize: '14px'
            }
          }, this.noDataError) : null
        )
      )
    );
  }
  
  renderTeamSelect() {
    const teams = Object.keys(TEAMS_DATA);
    
    // --- ERROR/EMPTY DATA LOGIC ---
    if (teams.length === 0) {
      let errorMessage = 'No Data Available Yet For The Selected Period';
      
      if (METADATA && METADATA.startDate && METADATA.endDate) {
        // Strip out the dashes to turn them into pure numbers (e.g., "2024-05-19" becomes 20240519)
        const startNum = parseInt(METADATA.startDate.replace(/-/g, ''), 10);
        const endNum = parseInt(METADATA.endDate.replace(/-/g, ''), 10);

        // 1. Check if they went back in time!
        if (startNum > endNum) {
          errorMessage = 'Error: Invalid Time Selection';
        } 
        // 2. If time flows normally, check if it's the offseason
        else {
          const monthStr = METADATA.startDate.includes('-') 
            ? METADATA.startDate.split('-')[1] 
            : METADATA.startDate.substring(4, 6);
          
          const month = parseInt(monthStr, 10);
          
          // Atlantic League season is ~April (4) to October (10)
          if (month < 4 || month > 10) {
            errorMessage = 'Error: Out of Season';
          }
        }
      }

      return createElement('div', { className: 'team-select-screen' },
        createElement('h1', {}, 'No Data'),
        createElement('p', { style: { fontSize: '20px', fontWeight: 'bold', color: '#d9534f', margin: '20px 0' } }, errorMessage),
        createElement('button', { className: 'team-btn', onclick: () => this.showDateSelect() }, 'Back to Home Page')
      );
    }
    // ----------------------------------

    const teamButtons = teams.map(t => {
      const playerCount = TEAMS_DATA[t].length;
      const totalPitches = TEAMS_DATA[t].reduce((sum, b) => sum + (b.stats?.totalPitches || 0), 0);
      return createElement('div', { className: 'team-card', onclick: () => this.showLineup(t) },
        createElement('div', { className: 'team-card-name' }, t),
        createElement('div', { className: 'team-card-stats' },
          createElement('div', { className: 'stat-item' },
            createElement('span', { className: 'stat-number' }, playerCount),
            createElement('span', { className: 'stat-label' }, 'Players')
          ),
          createElement('div', { className: 'stat-item' },
            createElement('span', { className: 'stat-number stat-pitches' }, totalPitches),
            createElement('span', { className: 'stat-label' }, 'Pitches')
          )
        )
      );
    });
    
    return createElement('div', { className: 'team-select-screen' },
      createElement('div', { className: 'team-select-header' },
        createElement('h1', {}, 'Select a Team'),
        createElement('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', marginBottom: '20px' } },
          createElement('span', { className: 'info-bubble' }, `${teams.length} teams`),
          createElement('span', { style: { fontSize: '18px', lineHeight: '1', alignSelf: 'center' } }, '⚾'),
          createElement('span', { className: 'info-bubble' }, (() => { const fmt = d => { if (!d) return 'N/A'; const [y,m,day] = d.split('-'); return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`; }; return `${fmt(METADATA?.startDate)} → ${fmt(METADATA?.endDate)}`; })())
        ),
        createElement('button', { className: 'back-btn', onclick: () => this.showDateSelect() }, '← Change Dates')
      ),
      createElement('div', { className: 'team-grid' }, ...teamButtons)
    );
  }

  sortRoster(lineup) {
    return [...lineup].sort((a, b) => {
      let cmp = 0;
      if (this.sortBy === 'number') {
        cmp = (a.jerseyNumber || 0) - (b.jerseyNumber || 0);
      } else if (this.sortBy === 'name') {
        cmp = (a.batter || '').localeCompare(b.batter || '');
      } else if (this.sortBy === 'handedness') {
        cmp = (a.handedness || '').localeCompare(b.handedness || '');
        if (cmp === 0) cmp = (a.batter || '').localeCompare(b.batter || '');
      } else if (this.sortBy === 'pitches') {
        cmp = (a.stats?.totalPitches || 0) - (b.stats?.totalPitches || 0);
      }
      return this.sortOrder === 'asc' ? cmp : -cmp;
    });
  }
  renderLineup() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    const sorted = this.sortRoster(lineup);
    const cards = sorted.map((batter) => {
      const origIdx = lineup.indexOf(batter);
      return createElement('div', {
        className: 'mini-card',
        onclick: () => this.showFlashcard(origIdx)
      },
        createElement('div', { className: 'mini-card-order' }, `#${batter.jerseyNumber || (origIdx + 1)}`),
        createElement('div', { className: 'mini-card-name' }, batter.batter),
        createElement('div', { className: `mini-card-hand ${batter.handedness}` }, batter.handedness),
        createElement('div', { className: 'mini-card-pitches' }, `${batter.stats?.totalPitches || 0} pitches`)
      );
    });
    const sortOptions = [
      { value: 'number',   label: 'Default' },
      { value: 'name',     label: 'Name' },
      { value: 'handedness', label: 'Handedness' },
      { value: 'pitches', label: 'Total Pitches' },
    ];
    const self = this;
    return createElement('div', { className: 'lineup-screen' },
      createElement('div', { className: 'lineup-header' },
        createElement('div', { className: 'lineup-header__topbar' },
          createElement('button', { className: 'back-btn', onclick: () => this.showTeamSelect() }, '← Teams'),
          createElement('button', { className: 'print-btn', onclick: () => this.printLineup() }, 'Print Lineup')
        ),
        createElement('h1', {}, `${this.selectedTeam} Lineup`),
        createElement('div', { style: { textAlign: 'center', marginBottom: '8px' } },
          createElement('span', { className: 'info-bubble' }, `${lineup.length} batters`)
        )
      ),
      createElement('div', { className: 'sort-container' },
        createElement('select', {
          className: 'sort-select',
          onchange: (e) => { self.sortBy = e.target.value; self.render(); }
        },
          ...sortOptions.map(opt => createElement('option', { value: opt.value, ...(self.sortBy === opt.value ? { selected: true } : {}) }, opt.label))
        ),
        createElement('button', {
          className: `sort-toggle-btn${self.sortOrder === 'desc' ? ' active' : ''}`,
          disabled: self.sortBy === 'number',
          onclick: () => { self.sortOrder = self.sortOrder === 'asc' ? 'desc' : 'asc'; self.render(); }
        }, '⇅')
      ),
      createElement('div', { className: 'lineup-grid' }, ...cards)
    );
  }

  /**
   * Step 1 of the inverted flow: pick a batter. The list comes from the cheap
   * distinct-batter index (BATTERS_INDEX) — no pitch-space scan. Typing filters
   * the list in place (without a full re-render, so the search box keeps focus).
   */
  renderBatterSelect() {
    const handBadge = (bats) => {
      const short = bats === 'Left' ? 'L' : bats === 'Right' ? 'R' : bats === 'Switch' ? 'S' : '–';
      const bg = bats === 'Left' ? '#dbeafe' : bats === 'Right' ? '#fee2e2' : bats === 'Switch' ? '#ede9fe' : '#e5e7eb';
      const fg = bats === 'Left' ? '#1e40af' : bats === 'Right' ? '#b91c1c' : bats === 'Switch' ? '#6d28d9' : '#475569';
      return createElement('span', {
        style: { flex: '0 0 auto', minWidth: '22px', textAlign: 'center', fontWeight: '700', fontSize: '12px', padding: '2px 7px', borderRadius: '999px', background: bg, color: fg }
      }, short);
    };

    const buildRows = (query) => {
      const q = (query || '').trim().toLowerCase();
      const matches = q
        ? BATTERS_INDEX.filter(b => b.name.toLowerCase().includes(q) || (b.team || '').toLowerCase().includes(q))
        : BATTERS_INDEX;
      if (matches.length === 0) {
        return [createElement('div', { style: { padding: '20px', textAlign: 'center', color: '#64748b' } }, 'No batters match your search.')];
      }
      return matches.map(b => createElement('div', {
        className: 'batter-pick-row',
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 14px', borderBottom: '1px solid #eef2f7', cursor: 'pointer' },
        onclick: () => this.selectBatter(b)
      },
        createElement('span', { style: { flex: '1 1 auto', fontWeight: '600', color: '#1e293b' } }, b.name),
        b.team ? createElement('span', { style: { flex: '0 1 auto', fontSize: '12px', color: '#64748b', textAlign: 'right' } }, b.team) : null,
        handBadge(b.bats)
      ));
    };

    const listEl = createElement('div', {
      id: 'batter-list',
      style: { maxWidth: '620px', margin: '0 auto', textAlign: 'left', background: 'white', border: '1px solid #e9ecef', borderRadius: '12px', overflow: 'hidden', maxHeight: '62vh', overflowY: 'auto' }
    }, ...buildRows(this.batterQuery));

    const searchEl = createElement('input', {
      id: 'batterSearch', type: 'search', value: this.batterQuery || '',
      placeholder: 'Search batter or team…',
      style: { width: '100%', maxWidth: '620px', margin: '0 auto 16px', display: 'block', boxSizing: 'border-box', padding: '12px 14px', fontSize: '15px', border: '1px solid #cbd5e1', borderRadius: '10px' },
      oninput: (e) => {
        this.batterQuery = e.target.value;
        const l = document.getElementById('batter-list');
        if (l) { l.innerHTML = ''; buildRows(this.batterQuery).forEach(r => l.appendChild(r)); }
      }
    });

    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Select a Batter'),
      createElement('p', { style: { 'margin-bottom': '16px', fontSize: '15px', color: '#64748b', lineHeight: '1.4' } },
        'Pick a batter to load their scouting card — pitch data is fetched only for the batter you choose.'
      ),
      createElement('div', { style: { textAlign: 'center', marginBottom: '14px' } },
        createElement('span', { className: 'info-bubble' }, `${BATTERS_INDEX.length} batters`)
      ),
      searchEl,
      listEl
    );
  }

  /**
   * Shown when a chosen batter has no pitches in the selected window — a clear
   * prompt (not an error) with ways forward.
   */
  renderBatterNoData() {
    const name = this.selectedBatterInfo ? this.selectedBatterInfo.name : 'This batter';
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, name),
      createElement('p', { style: { fontSize: '17px', color: '#64748b', margin: '18px auto', maxWidth: '520px', lineHeight: '1.5' } },
        this.noDataMessage || 'No pitch data found for this batter in the selected window.'
      ),
      createElement('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' } },
        createElement('button', { className: 'team-btn', onclick: () => this.showBatterSelect() }, '← Choose Another Batter'),
        createElement('button', { className: 'team-btn', onclick: () => this.showWindowSelect() }, 'Change Pitch Window')
      )
    );
  }

  renderSettingsPanel(rawCount = 0, filteredCount = 0, goodCount = 0, badCount = 0, displayedCount = 0, displayedGoodCount = 0, displayedBadCount = 0, statsTotalPitches = 0, docked = false) {
    const sliderMax = filteredCount;
    // Compute effective display value without mutating the setting — slice(0, N) handles the real cap naturally
    const effectiveMaxPitches = Math.min(CURRENT_SETTINGS.maxPitchesDisplayed, sliderMax);
    const createSlider = (label, key, min, max, step = 1, displayValue = undefined) => {
      const sliderValue = displayValue !== undefined ? displayValue : CURRENT_SETTINGS[key];
      return createElement('div', { className: 'setting-item' },
        createElement('label', { className: 'setting-label' }, label),
        createElement('div', { className: 'setting-input-group' },
          createElement('input', {
            type: 'range',
            min: min,
            max: max,
            step: step,
            value: sliderValue,
            className: 'setting-slider',
            oninput: (e) => {
              const value = parseFloat(e.target.value);
              CURRENT_SETTINGS[key] = value;
              e.target.parentElement.querySelector('.setting-number-input').value = value;
              this.updatePitchZone();
            },
            onchange: (e) => {
              this.updateSetting(key, parseFloat(e.target.value));
            }
          }),
          createElement('input', {
            type: 'number',
            min: min,
            max: max,
            step: step,
            value: sliderValue,
            className: 'setting-number-input',
            oninput: (e) => {
              const value = parseFloat(e.target.value);
              if (value >= min && value <= max) {
                CURRENT_SETTINGS[key] = value;
                e.target.parentElement.querySelector('.setting-slider').value = value;
                this.updatePitchZone();
              }
            },
            onchange: (e) => {
              const value = parseFloat(e.target.value);
              if (value >= min && value <= max) {
                this.updateSetting(key, value);
              }
            }
          })
        )
      );
    };
    const createCheckbox = (label, key, colorClass = '') => {
      return createElement('div', { className: 'setting-item' },
        createElement('label', { className: 'setting-label' }, label),
        createElement('label', { className: 'toggle-switch' },
          createElement('input', {
            type: 'checkbox',
            checked: CURRENT_SETTINGS[key],
            className: 'toggle-input',
            onchange: (e) => {
              this.updateSetting(key, e.target.checked);
            }
          }),
          createElement('span', { className: `toggle-track${colorClass ? ' ' + colorClass : ''}` })
        )
      );
    };
    // Dock toggle row shown in the header
    const dockToggleRow = createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' } },
      createElement('span', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--text)' } }, 'Dock to Sidebar'),
      createElement('label', { className: 'toggle-switch' },
        createElement('input', {
          type: 'checkbox',
          checked: this.isSettingsDocked,
          className: 'toggle-input',
          onchange: () => this.toggleDock()
        }),
        createElement('span', { className: 'toggle-track' })
      )
    );

    // Shared inner content (body + footer) — same in both modal and sidebar modes
    const innerContent = [
      createElement('div', { className: 'settings-modal__body' },
        createElement('div', { className: 'settings-grid' },

          // Pitch Display — full width
          createElement('div', { className: 'settings-card full-width' },
            createElement('div', { className: 'settings-card__header' }, 'Pitch Display'),
            createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginBottom: '12px' } },
              ...[
                { label: 'Total Pitches',                   value: rawCount, bg: '#f1f5f9', border: '#cbd5e1', textColor: '#1e293b' },
                { label: 'Matching Filters',                 value: displayedCount,    bg: '#eff6ff', border: '#93c5fd', textColor: '#1d4ed8', tooltip: 'Pitches currently shown on the grid (limited by Max Pitches Displayed).' },
                { label: 'Green Zone',  value: displayedGoodCount, bg: '#f0fdf4', border: '#86efac', textColor: '#15803d', tooltip: 'Displayed pitches where the pitcher wins meaningfully more often than his average against this batter.' },
                { label: 'Red Zone',   value: displayedBadCount,  bg: '#fef2f2', border: '#fca5a5', textColor: '#b91c1c', tooltip: 'Displayed pitches in zones where the batter hits 25%+ above his overall rate.' },
              ].map(({ label, value, bg, border, textColor, tooltip }) =>
                createElement('div', { className: 'stat-pill', ...(tooltip ? { 'data-tooltip': tooltip } : {}), style: { display: 'inline-flex', flexDirection: 'column', alignItems: 'center', background: bg, border: `1px solid ${border}`, borderRadius: '10px', padding: '6px 14px', minWidth: '80px', position: 'relative' } },
                  createElement('span', { style: { fontSize: '18px', fontWeight: '800', color: textColor, lineHeight: '1.1', textAlign: 'center', width: '100%' } }, value),
                  createElement('span', { style: { fontSize: '11px', fontWeight: '500', color: '#64748b', marginTop: '2px', textAlign: 'center', width: '100%' } },
                    label,
                    tooltip ? createElement('span', { style: { marginLeft: '4px', fontSize: '11px', color: '#93c5fd', cursor: 'default' } }, 'ⓘ') : null
                  )
                )
              )
            ),
            // Plain-language key for the circle colors (bucket = pitch type × zone)
            createElement('div', { style: { fontSize: '12px', color: '#475569', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px 10px', marginBottom: '12px', lineHeight: '1.5' } },
              'Circles are rated by bucket (pitch type + zone): ',
              createElement('b', { style: { color: '#15803d' } }, 'green'),
              ' = the pitcher wins more often there than his average vs this batter (attack), ',
              createElement('b', { style: { color: '#b91c1c' } }, 'red'),
              ' = 25%+ above (avoid), gray = in between or under the minimum sample.'
            ),
            createSlider('Max Pitches Displayed', 'maxPitchesDisplayed', 0, sliderMax, 1, effectiveMaxPitches),
            createSlider('Pitch Circle Size (px)', 'pitchCircleSize', 28, 56, 1),
            // Buckets = pitch type × zone; buckets under this size are dropped
            createSlider('Min Pitches per Bucket', 'bucketMinPitches', 1, 20, 1),
            // How small a difference from his baseline earns a colour. Shrinkage
            // already handles thin samples, so this only trades gray for colour.
            (() => {
              const LABELS = { 1: 'Strict', 2: 'Firm', 3: 'Balanced', 4: 'Loose', 5: 'Very loose' };
              const val = CURRENT_SETTINGS.ratingSensitivity || 3;
              return createElement('div', { className: 'setting-item' },
                createElement('label', { className: 'setting-label' }, 'Color Sensitivity'),
                createElement('div', { className: 'setting-input-group' },
                  createElement('input', {
                    type: 'range', min: '1', max: '5', step: '1', value: String(val), className: 'setting-slider',
                    oninput: (e) => {
                      const v = parseInt(e.target.value, 10);
                      CURRENT_SETTINGS.ratingSensitivity = v;
                      e.target.parentElement.querySelector('.sensitivity-value').textContent = LABELS[v];
                      this.updatePitchZone();
                    },
                    onchange: (e) => this.updateSetting('ratingSensitivity', parseInt(e.target.value, 10))
                  }),
                  createElement('span', {
                    className: 'sensitivity-value setting-number-input',
                    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px' }
                  }, LABELS[val])
                ),
                createElement('div', { className: 'setting-hint' },
                  'Lower = only strong differences get colored. Higher = more circles colored.')
              );
            })(),
            // Max circles drawn per bucket: 1..10, plus an "All" position (slider max = 11).
            (() => {
              const raw = CURRENT_SETTINGS.maxCirclesPerBucket;
              const isAll = raw === 'All' || raw === 'all';
              const sliderVal = isAll ? 11 : raw;
              return createElement('div', { className: 'setting-item' },
                createElement('label', { className: 'setting-label' }, 'Max Circles per Bucket'),
                createElement('div', { className: 'setting-input-group' },
                  createElement('input', {
                    type: 'range', min: '1', max: '11', step: '1', value: String(sliderVal), className: 'setting-slider',
                    oninput: (e) => {
                      const v = parseInt(e.target.value, 10);
                      CURRENT_SETTINGS.maxCirclesPerBucket = v >= 11 ? 'All' : v;
                      e.target.parentElement.querySelector('.max-circles-value').textContent = v >= 11 ? 'All' : String(v);
                      this.updatePitchZone();
                    },
                    onchange: (e) => {
                      const v = parseInt(e.target.value, 10);
                      this.updateSetting('maxCirclesPerBucket', v >= 11 ? 'All' : v);
                    }
                  }),
                  createElement('span', {
                    className: 'max-circles-value setting-number-input',
                    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
                  }, isAll ? 'All' : String(sliderVal))
                )
              );
            })(),
            // Max pitch velocity: reloads the batter's card server-side. onchange
            // ONLY (never oninput) — each change is a fresh scoped fetch. 105 = no cap.
            (() => {
              const cur = this.lastMaxVelocity != null ? this.lastMaxVelocity : 105;
              const fmt = (v) => (v >= 105 ? 'No cap' : v + ' mph');
              return createElement('div', { className: 'setting-item' },
                createElement('label', { className: 'setting-label' }, 'Max Pitch Velocity'),
                createElement('div', { className: 'setting-input-group' },
                  createElement('input', {
                    type: 'range', min: '0', max: '105', step: '1', value: String(cur), className: 'setting-slider',
                    oninput: (e) => {
                      const v = parseInt(e.target.value, 10);
                      e.target.parentElement.querySelector('.max-velo-value').textContent = fmt(v);
                    },
                    onchange: (e) => {
                      const v = parseInt(e.target.value, 10);
                      this.loadBatterCard(this.lastStartDate, this.lastEndDate, v, this.lastPitchGroup || 'All');
                    }
                  }),
                  createElement('span', {
                    className: 'max-velo-value setting-number-input',
                    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
                  }, fmt(cur))
                )
              );
            })(),
            // Pitcher-hand FILTER: restricts circles + zone stats to one hand
            createElement('div', { className: 'setting-item' },
              createElement('label', { className: 'setting-label' }, 'Pitcher Hand'),
              createElement('div', { style: { display: 'flex', gap: '6px' } },
                ...[
                  { value: 'All', label: 'All' },
                  { value: 'L', label: 'vs LHP' },
                  { value: 'R', label: 'vs RHP' },
                ].map(opt => {
                  const isActive = CURRENT_SETTINGS.pitcherHandFilter === opt.value;
                  return createElement('button', {
                    style: {
                      padding: '6px 12px', borderRadius: '8px', fontWeight: '700', fontSize: '12px',
                      cursor: 'pointer', transition: 'all 0.15s ease',
                      border: `2px solid ${isActive ? '#3b82f6' : '#e2e8f0'}`,
                      background: isActive ? '#3b82f6' : '#f8fafc',
                      color: isActive ? 'white' : '#64748b'
                    },
                    onclick: () => this.updateSetting('pitcherHandFilter', opt.value)
                  }, opt.label);
                })
              )
            ),
            // Pitch-type filter: hide pitch types the pitcher doesn't throw
            (() => {
              const batterForTypes = (TEAMS_DATA[this.selectedTeam] || [])[this.selectedBatterIndex];
              const typesPresent = [...new Set((batterForTypes?.pitchZones || []).map(z => z.pitch))].sort();
              if (typesPresent.length === 0) return null;
              return createElement('div', { className: 'setting-item' },
                createElement('label', { className: 'setting-label' }, 'Pitch Types Shown'),
                createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' } },
                  ...typesPresent.map(t => {
                    const hidden = CURRENT_SETTINGS.hiddenPitchTypes.includes(t);
                    return createElement('button', {
                      style: {
                        padding: '4px 10px', borderRadius: '99px', fontWeight: '700', fontSize: '12px',
                        cursor: 'pointer', transition: 'all 0.15s ease',
                        border: `2px solid ${hidden ? '#e2e8f0' : '#3b82f6'}`,
                        background: hidden ? '#f8fafc' : '#3b82f6',
                        color: hidden ? '#94a3b8' : 'white',
                        textDecoration: hidden ? 'line-through' : 'none'
                      },
                      onclick: () => {
                        const next = hidden
                          ? CURRENT_SETTINGS.hiddenPitchTypes.filter(x => x !== t)
                          : [...CURRENT_SETTINGS.hiddenPitchTypes, t];
                        this.updateSetting('hiddenPitchTypes', next);
                      }
                    }, t);
                  })
                )
              );
            })(),
            // Circle color mode: show both colors (default), or isolate one.
            createElement('div', { className: 'setting-item' },
              createElement('label', { className: 'setting-label' }, 'Circle Colors'),
              createElement('div', { style: { display: 'flex', gap: '6px' } },
                ...[
                  { value: 'both', label: 'Both' },
                  { value: 'green', label: 'Green only' },
                  { value: 'red', label: 'Red only' },
                ].map(opt => {
                  const isActive = (CURRENT_SETTINGS.circleColorMode || 'both') === opt.value;
                  return createElement('button', {
                    style: {
                      padding: '6px 12px', borderRadius: '8px', fontWeight: '700', fontSize: '12px',
                      cursor: 'pointer', transition: 'all 0.15s ease',
                      border: `2px solid ${isActive ? '#3b82f6' : '#e2e8f0'}`,
                      background: isActive ? '#3b82f6' : '#f8fafc',
                      color: isActive ? 'white' : '#64748b'
                    },
                    onclick: () => this.updateSetting('circleColorMode', opt.value)
                  }, opt.label);
                })
              )
            ),
            // Swings-only: recompute population, colors, and thresholds over swings only.
            createCheckbox('Swings Only', 'swingsOnly')
          ),

          // Zone Analysis — full width
          createElement('div', { className: 'settings-card full-width' },
            createElement('div', { className: 'settings-card__header' }, 'Zone Analysis'),
            createSlider('Vulnerable Zone Min Swings', 'vulnerableZoneMinSwings', 1, 10, 1),
            createSlider('Hot Zone Min Hard Hits', 'hotZoneMinHardHits', 1, 10, 1),
            createSlider('Hot Zone Hard Hit % Threshold', 'hotZoneHardHitThreshold', 0, 100, 5)
          )
        )
      ),
      createElement('div', { className: 'settings-modal__footer' },
        createElement('button', { className: 'settings-modal__reset-btn', onclick: () => this.resetSettings() }, 'Reset to Defaults'),
        docked
          ? createElement('button', { className: 'settings-modal__close-btn', title: 'Hide the panel — use "Show Settings" at the top to bring it back', onclick: () => { this.isSettingsDocked = false; this.render(); } }, 'Hide Panel')
          : createElement('button', { className: 'settings-modal__close-btn', onclick: () => this.toggleSettings() }, 'Close')
      )
    ];

    const header = createElement('div', { className: 'settings-modal__header' },
      createElement('h3', { className: 'settings-modal__title' }, 'Analysis Settings'),
      createElement('p', { className: 'settings-modal__subtitle' }, 'Adjust thresholds and display preferences'),
      !docked ? dockToggleRow : null
    );

    if (docked) {
      return createElement('div', { id: 'settings-sidebar', className: 'settings-sidebar' },
        header,
        ...innerContent
      );
    }

    return createElement('div', { className: 'settings-overlay', onclick: () => this.toggleSettings() },
      createElement('div', { className: 'settings-modal', onclick: (e) => e.stopPropagation() },
        header,
        ...innerContent
      )
    );
  }
  renderFlashcard() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    const data = lineup[this.selectedBatterIndex];
    return createElement('div', { className: 'widget' },
      createElement('div', { className: 'header' },
        createElement('div', { className: 'header__title' },
          createElement('span', { className: 'name' }, data.batter || 'Unknown'),
          createElement('span', { className: `mini-card-hand ${data.handedness}` }, data.handedness || ''),
          createElement('span', { className: 'meta' }, `• ${data.stats?.totalPitches || 0} pitches`),
          (data.stats?.totalPitches || 0) < 50 ? createElement('span', {
            className: 'low-data-badge',
            title: 'Limited Trackman data — scouting conclusions may be less reliable'
          }, '⚠ Low Data') : null,
          createElement('button', {
            className: 'info-btn',
            onclick: () => this.toggleInfo()
          }, '💡'),
          createElement('button', {
            className: 'settings-btn settings-btn--labeled',
            title: this.isSettingsDocked ? 'Hide the settings panel' : 'Show the settings panel',
            onclick: () => this.toggleSettings()
          }, this.isSettingsDocked ? '⚙ Hide Settings' : '⚙ Show Settings')
        ),
        //test for fork
        createElement('div', { className: 'header__controls' },
          createElement('span', { className: 'chip back-chip', onclick: () => this.showBatterSelect() }, '← Batters'),
          createElement('span', { className: 'chip', onclick: () => this.showWindowSelect() }, '⚙ Filters & Dates'),
          createElement('span', { className: 'chip print-chip', onclick: () => this.printCurrentCard() }, 'Print'),
          createElement('span', {
            className: 'chip', onclick: () => this.gotoAdjacentBatter(-1)
          }, '← Prev'),
          createElement('span', {
            className: 'chip', onclick: () => this.gotoAdjacentBatter(1)
          }, 'Next →')
        )
      ),
      this.showInfoPanel ? createElement('div', { className: 'info-overlay', onclick: () => this.toggleInfo() },
        createElement('div', { className: 'info-modal', onclick: (e) => e.stopPropagation() },

          // Header
          createElement('div', { className: 'info-modal__header' },
            createElement('h3', { className: 'info-modal__title' }, 'Understanding the Widget',), 
            createElement('p', { className: 'info-modal__subtitle' }, 'A guide to reading your batter flashcards')
          ),

          // Body
          createElement('div', { className: 'info-modal__body' },

            // Strike Zone
            createElement('div', { className: 'info-entry' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#dbeafe' } }, '🎯'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Strike Zone'),
                createElement('div', { className: 'info-entry__desc' },
                  'Each circle is one pitch, plotted where it crossed the plate. The bordered rectangle is the strike zone, split into the 9 boxes used for bucketing; circles outside it are pitches out of the zone. Pitches are grouped into buckets by pitch FAMILY and zone — Fastball, Breaking or Offspeed (e.g. breaking balls in Low-In) — and each bucket is scored on how often a pitch there went the PITCHER\'s way: a whiff, called strike, foul or out is a win; a hit or a ball is a loss. Green = he wins there more often than his average against this batter (attack). Red = less often (avoid). Gray = near his average. The small L or R shows the pitcher\'s hand; the view is the pitcher\'s perspective.'
                ),
                ...makeInfoExpand(
                  createElement('p', {}, createElement('strong', {}, 'Green:'), ' Pitches here go the pitcher\'s way more often than his average against this batter — attack.'),
                  createElement('p', {}, createElement('strong', {}, 'Red:'), ' They go his way less often — avoid.'),
                  createElement('p', {}, createElement('strong', {}, 'Gray:'), ' Near his average, or too small a sample to separate from it.'),
                  createElement('p', {}, createElement('strong', {}, 'A ball counts against the pitcher. '), 'That matters most out of the zone, where two buckets can both show zero hits for completely different reasons — he chased and missed, or he simply took it. The first is a put-away pitch, the second is ball one. Scoring only hits could not tell them apart, and rated both "attack".'),
                  createElement('p', {}, createElement('strong', {}, 'In-zone and out-of-zone are scored separately. '), 'About 84% of in-zone pitches go the pitcher\'s way against 27% out of it. Judged on one scale that 57-point gap would swamp everything, so a bucket is only ever compared against this batter\'s own rate in the same regime.'),
                  createElement('p', {}, createElement('strong', {}, 'Small samples are pulled toward his average. '), 'A bucket of three pitches sits essentially on his baseline and stays gray no matter what happened in it; a bucket of a hundred speaks for itself. This is why a lone 2-for-3 no longer paints a zone red.'),
                  createElement('p', {}, 'Buckets with fewer pitches than the ', createElement('strong', {}, 'Min Pitches per Bucket'), ' setting are removed from the grid entirely — too small a sample to trust. Raise it for stricter evidence, lower it to see more pitches.'),
                  createElement('p', {}, 'The Max Pitches Displayed slider reveals circles from the most extreme buckets (furthest above or below the batter\'s average) toward the average. Hover any circle for its bucket\'s breakdown: which specific pitch types made it up, counts split by outcome, the raw pitcher-win tally, the sample-adjusted rate the colour is read from, and this batter\'s baseline for that regime. Out-of-zone buckets are labelled "Chase" and tagged Out of zone, and are kept separate from the 9 in-zone boxes so in-zone samples stay clean. The settings panel filters by pitcher hand and pitch type — stats and colors recompute for the selected hand.'),
                  createElement('p', {}, createElement('strong', {}, 'Why families, not individual pitch types? '), 'Measured on a season of ALPB data, a batter\'s whiff rate varies about twice as much BETWEEN families as it does WITHIN one — a four-seam and a sinker play alike, a fastball and a slider do not. Splitting a zone by individual pitch type leaves only 6–10 swings per bucket, where a whiff rate carries a ±30-point margin; at that size the type-to-type differences could not be told apart from chance. Families roughly double the sample behind every circle. The per-type detail that IS reliable lives in ', createElement('strong', {}, 'How he handles each pitch'), ' below the zone, where each type is pooled across all zones and carries ~90 swings.')
                ),
                createElement('div', { className: 'pitch-badge-row' },
                  ...[
                    { abbr: '4S', name: 'Four-Seam' },
                    { abbr: 'Si', name: 'Sinker' },
                    { abbr: 'FC', name: 'Cutter' },
                    { abbr: 'SL', name: 'Slider' },
                    { abbr: 'CB', name: 'Curveball' },
                    { abbr: 'CH', name: 'Changeup' },
                    { abbr: 'SP', name: 'Splitter' },
                  ].map(p =>
                    createElement('span', { className: 'pitch-badge' },
                      createElement('strong', {}, p.abbr),
                      ` ${p.name}`
                    )
                  )
                )
              )
            ),

            // Vulnerable Zones
            createElement('div', { className: 'info-entry', id: 'info-entry-vulnerable' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#fef9c3' } }, '⚡'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Vulnerable Zones'),
                createElement('div', { className: 'info-entry__desc' },
                  'Locations where the batter struggles most — high whiff rate, weak contact, or excessive fouls. Attack here.'
                ),
                ...makeInfoExpand(
                  createElement('p', {}, 'Each zone gets a vulnerability score from 0 (most vulnerable) to 60 (least) based on whiff rate, weak contact rate, and foul rate.'),
                  createElement('p', {}, 'The ', createElement('strong', {}, 'Vulnerable Zone Min Swings'), ' setting (Analysis Settings → Zone Analysis) controls the minimum sample a zone needs before it can appear here.'),
                  createElement('p', {}, 'When attacking here, stay in the zone — even borderline pitches will produce poor contact.')
                )
              )
            ),

            // Hot Zones
            createElement('div', { className: 'info-entry', id: 'info-entry-hot' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#fee2e2' } }, '🔥'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Hot Zones (Avoid)'),
                createElement('div', { className: 'info-entry__desc' },
                  'Where the batter makes hard contact (95+ mph exit velocity). Pitching here is dangerous — stay out.'
                ),
                ...makeInfoExpand(
                  createElement('p', {}, 'A zone qualifies as a Hot Zone when: hard-hit rate exceeds ', createElement('strong', {}, '40%'), ' AND at least ', createElement('strong', {}, '2 hard hits'), ' (95+ mph) have been recorded there.'),
                  createElement('p', {}, 'These thresholds are adjustable in Analysis Settings → Zone Analysis. Use Hot Zones as a map of where ', createElement('em', {}, 'not'), ' to miss — especially when ahead in the count.')
                )
              )
            ),

            // Out Sequence
            createElement('div', { className: 'info-entry', id: 'info-entry-out-pitch' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#ede9fe' } }, '📋'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Out Pitch / Sequence'),
                createElement('div', { className: 'info-entry__desc' },
                  'The most common pitch sequences that historically get this batter out — groundouts, flyouts, strikeouts. Use this as your blueprint.'
                ),
                ...makeInfoExpand(
                  createElement('p', {}, 'Analyzes the final two pitches (setup pitch → out pitch) of every plate appearance that ended in an out. The most frequent sequence wins.'),
                  createElement('p', {}, 'A single pitch (e.g. "SL") is the out pitch itself. An arrow sequence (e.g. "4S → SL") shows the setup pitch followed by the out pitch.'),
                  createElement('p', {},
                    createElement('strong', {}, 'K↩'), ' = strikeout swinging (swing and miss). ',
                    createElement('strong', {}, 'K👁'), ' = strikeout looking (called strike 3). ',
                    createElement('strong', {}, 'Contact'), ' = ball put in play for an out.'
                  ),
                  createElement('p', {}, 'When enough of this batter’s outs finish on the same pitch with tracked coordinates, a location line appears under the breakdown — e.g. ', createElement('strong', {}, 'SL finishes: Low-Out (6 of 15, 4 off plate)'), '. It pools every out that ENDED on that pitch type (not just the two-pitch sequence above, so the two denominators differ on purpose) and needs at least 15 located finishes, 6 of them in one band, and that band holding 35% or more. A “band” merges a strike-zone box with the chase area just outside it, so a low-away strike and a buried slider count as the same spot; “off plate” then says how many of those were outside the zone — 4 of 6 means he is chasing it, not being beaten in the zone. With 15+ finishes but no band that dominant it reads “no dominant spot”, which is itself useful — location is not the lever for this hitter. Below 15 located finishes nothing is shown, because at that size a location pattern is indistinguishable from random spread. Only the OUT pitch is located; the setup pitch is not.'),
                  createElement('p', { style: { color: '#64748b' } }, 'More outs in the sample = more reliable signal. Low-data batters may show "Insufficient data."')
                )
              )
            ),

            // Threats
            createElement('div', { className: 'info-entry', id: 'info-entry-threats' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#ffedd5' } }, '⚠️'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Threats'),
                createElement('div', { className: 'info-entry__desc' },
                  createElement('span', { className: 'info-threat-row' },
                    createElement('strong', {}, 'Steal:'), ' Base running ability based on infield hits and speed indicators.'
                  ),
                  createElement('span', { className: 'info-threat-row' },
                    createElement('strong', {}, 'Bunt:'), ' Contact rate and bat control tendency.'
                  ),
                  createElement('span', { className: 'info-threat-row' },
                    createElement('strong', {}, 'Spray:'), ' Pull hitter (>60% pull direction), Opposite field (>40% opposite direction), or All fields (neither threshold met). Percentage = share of batted balls in that direction.'
                  )
                ),
                ...makeInfoExpand(
                  createElement('p', {}, createElement('strong', {}, 'Steal — '), 'High = 4+ indicators (stolen base attempts, infield hits, speed data). Moderate = 2–3 indicators. Low = no evidence of above-average speed. Hold the runner carefully when steal is Moderate or High.'),
                  createElement('p', {}, createElement('strong', {}, 'Bunt — '), 'Based on recorded bunt attempts and contact rates. High = 3+ bunts or a consistent pattern. Corner infielders should be aware and not play deep.'),
                  createElement('p', {}, createElement('strong', {}, 'Spray — '), 'Pull hitter (>60% to pull side): shift your defense and attack the outer half. Opposite field (>40% oppo): be careful with inside pitches. All fields: balanced — no strong tendency, pitch to weakness.')
                )
              )
            ),

            // First Pitch
            createElement('div', { className: 'info-entry info-entry--last', id: 'info-entry-first-pitch' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#dbeafe' } }, '🔵'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'First-Pitch Approach'),
                createElement('div', { className: 'info-entry__desc' },
                  'How often the batter swings on 0-0 counts, as a share of true first-pitch decisions, compared to the league. The rate is judged against the league average: 25%+ above = Aggressive, 25%+ below = Patient, within ±25% = Neutral.'
                ),
                ...makeInfoExpand(
                  createElement('p', {}, 'Rate = first-pitch swings ÷ PA′, where ', createElement('strong', {}, 'PA′'), ' = the batter\'s 0-0 pitches minus hit-by-pitches and no-decision calls (e.g. balls in the dirt). The league average is pooled over every 0-0 pitch in the league, season-to-date.'),
                  createElement('p', {}, createElement('strong', {}, 'Aggressive (25%+ above league): '), 'He\'s hunting the first pitch. Open with a first-pitch strike — he\'ll often swing early and make weak contact or miss. Don\'t waste it on a ball.'),
                  createElement('p', {}, createElement('strong', {}, 'Patient (25%+ below league): '), 'He takes early to get ahead in the count. Get 0-1 without throwing your best pitch — then attack with your out pitch.'),
                  createElement('p', {}, createElement('strong', {}, 'Neutral (within ±25% of league): '), 'Unpredictable — he might swing or take depending on the pitch. Read his recent at-bats and adjust mid-game.'),
                  createElement('p', { style: { color: '#64748b' } }, 'The line under the rate shows the league average, or "league avg pending" until a full-range load has computed it.')
                )
              )
            )
          ),

          // Footer
          createElement('div', { className: 'info-modal__footer' },
            createElement('button', { className: 'info-modal__close-btn', onclick: () => this.toggleInfo() }, 'Got it!')
          )
        )
      ) : null,
      (() => {
        const tendenciesEl = createTendencies(data.tendencies, data.stats, data.zoneAnalysis, data.powerSequence, data.powerSequenceBreakdown);

        const rawZones = data.pitchZones || [];
        const { pitches: visiblePitches, bucketCtx } = getVisiblePitches(data);
        this._tendenciesEl = tendenciesEl;
        this._bucketCtx = bucketCtx;
        this._fullyFilteredPitches = visiblePitches;
        this._rawZoneCount = rawZones.length;
        this._statsTotalPitches = data.stats?.totalPitches || rawZones.length;
        this._goodCount = visiblePitches.filter(z => z.rating === 'green').length;
        this._badCount = visiblePitches.filter(z => z.rating === 'red').length;
        const displayedSlice = visiblePitches.slice(0, CURRENT_SETTINGS.maxPitchesDisplayed);
        this._displayedCount = displayedSlice.length;
        this._displayedGoodCount = displayedSlice.filter(z => z.rating === 'green').length;
        this._displayedBadCount = displayedSlice.filter(z => z.rating === 'red').length;
      })(),
      (!this.isSettingsDocked && this.showSettingsPanel) ? this.renderSettingsPanel(this._rawZoneCount, this._fullyFilteredPitches.length, this._goodCount, this._badCount, this._displayedCount, this._displayedGoodCount, this._displayedBadCount, this._statsTotalPitches) : null,
      (() => {
        const { el: pitchZoneInner, count: renderedCount, available: availableCount } = createPitchZone(this._fullyFilteredPitches, data.handedness, this._bucketCtx);
        const pitchZoneEl = createElement('div', { className: 'pitch-zone-section' }, pitchZoneInner);
        const batterEl = createBatterGraphic(data.handedness, data.batter, renderedCount, availableCount);

        const frag = document.createDocumentFragment();
        frag.appendChild(pitchZoneEl);
        frag.appendChild(batterEl);
        const arsenalEl = createArsenal(data);
        if (arsenalEl) frag.appendChild(arsenalEl);
        frag.appendChild(this._tendenciesEl);
        return frag;
      })()
    );
  }
  render() {
    const _wsy = (this.currentScreen !== 'loading' && this.currentScreen !== 'error') ? window.scrollY : 0;
    if (this.currentScreen === 'loading' || this.currentScreen === 'error') window.scrollTo(0, 0);
    // Save scroll positions before re-render
    const _savedScroll = (this.container.querySelector('.settings-sidebar') || {}).scrollTop || 0;
    const _savedModalBodyScroll = (this.container.querySelector('.settings-modal__body') || {}).scrollTop || 0;
    // Clean up existing sidebar and docked state
    document.getElementById('settings-sidebar')?.remove();
    this.container.classList.remove('app-sidebar-docked');

    this.container.innerHTML = '';
    let content;
    if (this.currentScreen === 'loading') content = this.renderLoading();
    else if (this.currentScreen === 'error') content = this.renderError();
    else if (this.currentScreen === 'batterSelect') content = this.renderBatterSelect();
    else if (this.currentScreen === 'batterNoData') content = this.renderBatterNoData();
    else if (this.currentScreen === 'dateSelect') content = this.renderDateSelect();
    else if (this.currentScreen === 'teamSelect') content = this.renderTeamSelect();
    else if (this.currentScreen === 'lineup') content = this.renderLineup();
    else if (this.currentScreen === 'flashcard') content = this.renderFlashcard();
    this.container.appendChild(content);

    // After renderFlashcard has run (populating this._rawZoneCount etc.), mount sidebar
    if (this.isSettingsDocked && this.currentScreen === 'flashcard') {
      const sidebar = this.renderSettingsPanel(this._rawZoneCount, this._fullyFilteredPitches.length, this._goodCount, this._badCount, this._displayedCount, this._displayedGoodCount, this._displayedBadCount, this._statsTotalPitches, true);
      this.container.insertBefore(sidebar, this.container.firstChild);
      this.container.classList.add('app-sidebar-docked');
    }
    // Restore sidebar scroll position after layout is resolved
    if (_savedScroll > 0) { requestAnimationFrame(() => { const _ns = this.container.querySelector('.settings-sidebar'); if (_ns) _ns.scrollTop = _savedScroll; }); }
    if (_savedModalBodyScroll > 0) { requestAnimationFrame(() => { const _nb = this.container.querySelector('.settings-modal__body'); if (_nb) _nb.scrollTop = _savedModalBodyScroll; }); }
    if (_wsy > 0) requestAnimationFrame(() => window.scrollTo(0, _wsy));
  }
}
let app;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {app =  new FlashcardApp(document.getElementById('app')); });
} else {
  app = new FlashcardApp(document.getElementById('app'));
}

// MOBILE FIX: CONVERT HOVER TOOLTIPS TO TAPS
document.addEventListener('click', (e) => {
  // If the user taps something that has a tooltip message...
  if (e.target && e.target.hasAttribute('title')) {
    // And if it's an info span or an emoji...
    if (e.target.tagName === 'SPAN' || e.target.textContent.includes('ⓘ') || e.target.textContent.includes('🔒')) {
      // Prevent any other button clicks and show the message!
      e.preventDefault();
      alert(e.target.getAttribute('title'));
    }
  }
});