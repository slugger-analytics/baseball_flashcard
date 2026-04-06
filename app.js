let TEAMS_DATA = {};
let METADATA = null;
let cachedSeasonData = null;
let cachedDateRange = { start: null, end: null, maxVelocity: null, pitchGroup: null };
// Default settings
const DEFAULT_SETTINGS = {
  // Zone analysis thresholds
  vulnerableZoneMinSwings: 3,
  vulnerableZoneThreshold: 35,
  hotZoneMinHardHits: 2,
  hotZoneHardHitThreshold: 40,
  // Pitch display settings
  maxPitchesDisplayed: 10,
  showOnlyGoodPitches: false,
  showOnlyBadPitches: false,
  pitchCircleSize: 32
};
let CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };

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
 * Pre-season loads the last completed season (2025); in/post-season loads 2026.
 * @returns {{ start: string, end: string, year: number }}
 */
function getFullSeasonRange() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (todayStr < SEASON_2026.start) {
    return { start: SEASON_2025.start, end: SEASON_2025.end, year: 2025 };
  }
  if (todayStr <= SEASON_2026.end) {
    return { start: SEASON_2026.start, end: todayStr, year: 2026 };
  }
  return { start: SEASON_2026.start, end: SEASON_2026.end, year: 2026 };
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
    } else if (key === 'checked') {
      el.checked = Boolean(value);
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
/**
 * Renders the strike zone SVG as a DOM element, placing pitch circles for each zone.
 * Filters zones by handedness and an optional allowedZones whitelist from the weakness slider.
 * @param {Array<Object>} zones - Array of pitchZone objects ({ position, pitch, good, zone }).
 * @param {string} handedness - 'LHB' or 'RHB' — controls left/right mirroring of the SVG.
 * @param {Array<string>|null} [allowedZones=null] - Zone keys to show; null means show all.
 * @returns {HTMLElement} A div containing the SVG pitch zone graphic.
 */
function createPitchZone(zones, handedness, allowedZones = null) {
  const safeZones = Array.isArray(zones) ? zones : [];
  // Apply pitch filtering based on settings
  let filteredZones = safeZones;

  // if the weakness slider has restricted zones, only show those
  if (allowedZones !== null) {
    if (allowedZones.length > 0) {
      // Filter green circles to allowed vulnerable zones; filter red circles to allowed hot zones
      const allowedBadZones = (typeof app !== 'undefined' && app?.allowedBadZones) ?? null;
      filteredZones = filteredZones.filter(z => {
        if (z.good === true)  return allowedZones.includes(z.zone);
        if (z.good === false) return allowedBadZones === null || allowedBadZones.includes(z.zone);
        return true;
      });
    } else {
      // No vulnerable zones identified — at strict/balanced, show only good pitches
      // At broad (threshold = 60), show everything
      const threshold = CURRENT_SETTINGS.vulnerableZoneThreshold;
      if (threshold <= 35) {
        filteredZones = filteredZones.filter(z => z.good === true);
      }
    }
  }

  if (CURRENT_SETTINGS.showOnlyGoodPitches && !CURRENT_SETTINGS.showOnlyBadPitches) {
    filteredZones = filteredZones.filter(z => z.good === true);
  } else if (CURRENT_SETTINGS.showOnlyBadPitches && !CURRENT_SETTINGS.showOnlyGoodPitches) {
    filteredZones = filteredZones.filter(z => z.good === false);
  }
  // Apply max pitches limit
  let displayZones = filteredZones;
  const maxPitches = CURRENT_SETTINGS.maxPitchesDisplayed;
  if (filteredZones.length > maxPitches) {
    const step = filteredZones.length / maxPitches;
    displayZones = [];
    for (let i = 0; i < maxPitches; i++) {
      const index = Math.floor(i * step);
      displayZones.push(filteredZones[index]);
    }
  }
  const pitchElements = displayZones.map(zone => {
    const [x, y] = zone.position || [50, 50];
    const pitchType = zone.pitch || 'F';
    const isGood = zone.good === true;
    const colorClass = isGood ? 'pitch-circle--good' : 'pitch-circle--bad';
    const pitcherHand = zone.pitcherThrows || '';
    const handClass = pitcherHand === 'L' ? 'pitch-circle__hand--left' : 'pitch-circle__hand--right';
    return createElement('div', {
      className: `pitch-circle ${colorClass}`,
      style: { left: `${x}%`, top: `${y}%` },
      title: `${pitchType} (${pitcherHand}HP) — ${isGood ? 'Attack here' : 'Avoid this location'}`
    },
      createElement('span', { className: 'pitch-circle__type' }, pitchType),
      createElement('span', { className: `pitch-circle__hand ${handClass}` }, pitcherHand)
    );
  });
  const isLeftHanded = handedness === 'LHB';
  const batterClass = isLeftHanded ? 'batter-graphic-left-handed' : 'batter-graphic-right-handed';
  const svgPath = isLeftHanded ? '/lhb.svg' : '/rhb.svg';
  const svgImg = createElement('img', {
    src: svgPath,
    alt: isLeftHanded ? 'Left-Handed Batter' : 'Right-Handed Batter',
    style: { width: '100%', height: '100%', 'object-fit': 'contain' }
  });
  const batterGraphic = createElement('div', {
    className: `batter-graphic ${batterClass}`,
    title: isLeftHanded ? 'Left-Handed Batter' : 'Right-Handed Batter'
  }, svgImg);
  const pitchZone = createElement('div', { className: 'pitch-zone' }, ...pitchElements);
  pitchZone.style.setProperty('--pitch-circle-size', `${CURRENT_SETTINGS.pitchCircleSize}px`);
  return createElement('div', { className: 'pitch-zone-container' },
    batterGraphic,
    pitchZone
  );
}
/**
 * Builds the batter header block showing handedness badge, name, and total pitch count.
 * @param {string} handedness - 'LHB' or 'RHB'.
 * @param {string} batterName - Display name of the batter.
 * @param {Array} pitchZones - Raw pitch zone array used only to compute total pitch count.
 * @returns {HTMLElement}
 */
function createBatterGraphic(handedness, batterName, pitchZones) {
  const isLeftHanded = handedness === 'LHB';
  const totalPitches = Array.isArray(pitchZones) ? pitchZones.length : 0;
  const handText = isLeftHanded ? 'LEFT-HANDED BATTER' : 'RIGHT-HANDED BATTER';
  return createElement('div', { className: 'batter-section' },
    createElement('div', { className: 'handedness-badge' }, handText),
    createElement('div', { className: 'batter-info' },
      createElement('div', { className: 'batter-name' }, batterName || 'Unknown'),
      createElement('div', { className: 'batter-stats' },
        `Total Pitches: ${totalPitches}`)
    )
  );
}

/**
 * Builds the scouting tendencies panel showing spray chart, zone analysis, and power sequence.
 * Strips raw percentage strings from display text for cleaner presentation.
 * @param {Object} tendencies - Batter tendency strings (pull%, oppo%, groundball%, etc.).
 * @param {Object} stats - Aggregate stat counters (K%, BB%, xBA, etc.).
 * @param {Object} zoneAnalysis - Per-zone pitch outcome breakdown.
 * @param {string} powerSequence - Narrative text describing the top pitch sequence vs. this batter.
 * @returns {HTMLElement}
 */
function createTendencies(tendencies, stats, zoneAnalysis, powerSequence) {
const stripPercents = (text) => {
    if (typeof text !== 'string') return text;
    return text
      .replace(/\((\d+)\/(\d+)\s*=\s*\d+%\)/g, '($1 of $2 outs)')
      .replace(/\d+\s*%/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };

  const safeStats = stats || {};
  const firstPitchSwingRate = safeStats.firstPitchPitches > 0
    ? `${(safeStats.firstPitchSwings / safeStats.firstPitchPitches * 100).toFixed(0)}%`
    : 'N/A';

  // Grab the live slider value for the UI
  const vulnThreshold = app ? CURRENT_SETTINGS.vulnerableZoneThreshold : 45;

  const vulnerableZones = [];
  const hotZones = [];
  if (zoneAnalysis) {
    const zoneScores = {};
    const minPitches = CURRENT_SETTINGS.vulnerableZoneMinSwings;

    Object.entries(zoneAnalysis).forEach(([zone, stats]) => {

      if ((stats.pitches || 0) < minPitches) return;

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

  if (app) {
    app.allowedZones = cappedVulnerableZones.map(z => z.zone);
    app.allowedBadZones = cappedHotZones.map(z => z.zone);
  }
  
  // let firstPitchText = stripPercents(tendencies?.firstStrike || `Swings ${firstPitchSwingRate} on first pitch`);
  let firstPitchText = tendencies?.firstStrike || `Swings ${firstPitchSwingRate} on first pitch`;
  let sprayText = tendencies?.spray || 'All fields';
  const cleanedPowerSequence = stripPercents(
  (powerSequence && powerSequence !== 'Calculating...') ? powerSequence : 'Insufficient data'
);

  // The UI Slider (Aaron part)

  // 3 fixed confidence levels: threshold = max vulnerabilityScore allowed through
  // Score 0 = most vulnerable (CRITICAL), score 60 = least (MODERATE)
  const CONFIDENCE_LEVELS = [
    { label: 'Broad',     desc: 'All Weaknesses',   threshold: 60, color: '#ef4444' },
    { label: 'Balanced',  desc: 'Critical + Major',  threshold: 35, color: '#f59e0b' },
    { label: 'Strict',    desc: 'Critical Only',     threshold: 20, color: '#22c55e' },
  ];

const activeLevel = CONFIDENCE_LEVELS.find(l => l.threshold === vulnThreshold) || CONFIDENCE_LEVELS[1];
  const activeColor = activeLevel.color;

const confidenceSlider = app ? createElement('div', { style: { padding: '16px', background: 'white', borderRadius: '12px', border: '1px solid var(--border)', marginBottom: '16px', boxShadow: 'var(--shadow-sm)' } },
    createElement('div', { style: { marginBottom: '10px', textAlign: 'center' } },
      createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '7px', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: '99px', padding: '5px 14px' } },
        createElement('span', { style: { width: '12px', height: '12px', borderRadius: '50%', border: `2.5px solid ${activeColor}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0' } },
          createElement('span', { style: { width: '3px', height: '3px', borderRadius: '50%', background: activeColor, display: 'block' } })
        ),
        createElement('span', { style: { fontSize: '11px', fontWeight: '700', color: '#475569', letterSpacing: '0.09em', textTransform: 'uppercase' } }, 'Weakness Confidence')
      )
    ),
    createElement('div', { style: { display: 'flex', gap: '8px' } },
      ...CONFIDENCE_LEVELS.map(level => {
        const isActive = level.threshold === vulnThreshold;
        return createElement('button', {
          style: {
            flex: '1',
            padding: '8px 4px',
            borderRadius: '8px',
            border: `2px solid ${isActive ? level.color : '#e2e8f0'}`,
            background: isActive ? level.color : '#f8fafc',
            color: isActive ? 'white' : '#64748b',
            fontWeight: '700',
            fontSize: '12px',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            lineHeight: '1.3',
          },
          onclick: () => app.updateSetting('vulnerableZoneThreshold', level.threshold)
        },
          createElement('div', {}, level.label),
          createElement('div', { style: { fontSize: '10px', fontWeight: '500', opacity: isActive ? '0.9' : '0.7' } }, level.desc)
        );
      })
    )
  ) : null;

  // ------- CONFIDENCE SLIDER START OLD -------
  /*
  const confidenceSlider = app ? createElement('div', { style: { padding: '12px', background: '#f8fafc', borderRadius: '12px', border: '1px solid var(--border)', marginBottom: '12px' } },
    createElement('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '8px' } },
      createElement('span', { style: { fontSize: '14px', fontWeight: '700', color: 'var(--text)' } }, 'Weakness Confidence'),
      // Added an ID here so we can update the number smoothly
      createElement('span', { id: 'slider-value-display', style: { fontSize: '14px', fontWeight: '800', color: 'var(--accent)' } }, vulnThreshold)
    ),
    createElement('input', {
      type: 'range', min: '0', max: '100', step: '1',
      value: vulnThreshold,
      className: 'setting-slider',
      style: { width: '100%', cursor: 'pointer' },
      oninput: (e) => {
        app.updateSetting('vulnerableZoneThreshold', parseInt(e.target.value, 10));
      }
    }),

    createElement('div', { style: { fontSize: '11px', color: 'var(--muted)', textAlign: 'center', marginTop: '4px' } },
      vulnThreshold >= 75 ? 'Strict — Critical only' :
      vulnThreshold >= 50 ? 'Balanced — Critical + Major' :
      'Broad — All weaknesses shown'
    )
  ) : null;
*/
  // ------- CONFIDENCE SLIDER END -------

  return createElement('div', { className: 'info-section' },
    confidenceSlider,
    createElement('div', { className: 'power-sequence stats-box' },
      createElement('h4', {}, 'First-Pitch Approach'),
      createElement('div', { className: 'power-sequence-text' }, firstPitchText)
    ),
    cappedVulnerableZones.length > 0 ? createElement('div', { className: 'power-sequence vulnerable-zone' },
    createElement('h4', {}, 'Vulnerable Zones'),
    createElement('div', { className: 'power-sequence-text' },
    cappedVulnerableZones.slice(0, 2).map(z => `${z.zone} (${z.score})`).join(', '))
) : null,
    hotZones.length > 0 ? createElement('div', { className: 'power-sequence hot-zone' },
      createElement('h4', {}, 'Hot Zones (Avoid)'),
      createElement('div', { className: 'power-sequence-text' },
        hotZones.slice(0, 2).map(z => z.zone).join(', ') || 'None identified')
    ) : null,
    createElement('div', { className: 'power-sequence out-sequence' },
      createElement('h4', {}, 'Out Sequence'),
      createElement('div', { className: 'power-sequence-text' }, cleanedPowerSequence)
    ),
    createElement('div', { className: 'power-sequence threat-box' },
      createElement('h4', {}, 'Threats & Tendencies'),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Steal:'),
        createElement('span', { className: 'threat-value' }, tendencies?.stealThreat || 'Low')
      ),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Bunt:'),
        createElement('span', { className: 'threat-value' }, tendencies?.buntThreat || 'Low')
      ),
      createElement('div', { className: 'threat-item' },
        createElement('span', { className: 'threat-label' }, 'Spray:'),
        createElement('span', { className: 'threat-value' }, sprayText)
      )
    )
  );
}

class FlashcardApp {
  constructor(container) {
    this.container = container;
    this.currentScreen = 'dateSelect';
    this.selectedTeam = null;
    this.selectedBatterIndex = 0;
    this.showInfoPanel = false;
    this.showSettingsPanel = false;
    const defaults = getDefaultSeasonDates();
    this.lastStartDate = defaults.start;
    this.lastEndDate = defaults.end;
    this.ensurePrintContainers();
    this.render();
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
    const header = createElement('div', { className: 'header' },
      createElement('div', { className: 'header__title' },
        createElement('span', { className: 'name' }, batter.batter || 'Unknown'),
        metaBits.length ? createElement('span', { className: 'meta' }, metaBits.join(' • ')) : null
      )
    );
    const pitchSection = createElement('div', { className: 'pitch-zone-section' },
      createPitchZone(batter.pitchZones || [], batter.handedness, app?.allowedZones || null)
    );
    const infoSection = createTendencies(batter.tendencies, batter.stats, batter.zoneAnalysis, batter.powerSequence, null);
    const widget = createElement('div', { className: 'widget print-widget' },
      header,
      pitchSection,
      infoSection
    );
    return createElement('div', { className: 'print-page' }, widget);
  }
  printCurrentCard() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    if (!lineup || lineup.length === 0) return;
    const batter = lineup[this.selectedBatterIndex];
    const container = this.getPrintContainer('print-container');
    container.innerHTML = '';
    container.appendChild(this.buildPrintPage(batter, this.selectedTeam, this.selectedBatterIndex));

    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 2);
    container.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`)
    });

    setTimeout(() => window.print(), 30);
  }
  printLineup() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    if (!lineup || lineup.length === 0) return;
    const container = this.getPrintContainer('lineup-print-container');
    container.innerHTML = '';
    lineup.forEach((batter, idx) => {
      container.appendChild(this.buildPrintPage(batter, this.selectedTeam, idx));
    });

    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 2);
    container.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`)
    });

    setTimeout(() => window.print(), 30);
  }
  toggleInfo() {
    this.showInfoPanel = !this.showInfoPanel;
    this.render();
  }
  toggleSettings() {
    this.showSettingsPanel = !this.showSettingsPanel;
    this.render();
  }
  updateSetting(key, value) {
    CURRENT_SETTINGS[key] = value;
    this.render();
  }
  resetSettings() {
    CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };
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
  async loadDataRange(startDate, endDate, maxVelocity = 105, seasonYear = null, pitchGroup = 'All') {
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

      this.loadingParams = { pitchGroup: pitchLabel, maxVelocity, seasonYear };
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
          this.error = data.message || `Error loading data (${response.status})`;
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
      this.error = `Error loading data: ${err.message}`;
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
      } else {
          const season = getFullSeasonRange();
          startStr  = season.start;
          endStr    = season.end;
          seasonYear = season.year;
      }

      // retain the dates in the calendar memory
      this.lastStartDate = startStr;
      this.lastEndDate = endStr;
      this.loadDataRange(startStr, endStr, maxVel, seasonYear, pitchGroup);
}

  showDateSelect() { this.currentScreen = 'dateSelect'; this.validationError = null; this.noDataError = null; this.render(); }
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
      const lineup = TEAMS_DATA[this.selectedTeam];
      if (e.key === 'ArrowRight') {
        this.selectedBatterIndex = (this.selectedBatterIndex + 1) % lineup.length;
        this.render();
      } else if (e.key === 'ArrowLeft') {
        this.selectedBatterIndex = (this.selectedBatterIndex - 1 + lineup.length) % lineup.length;
        this.render();
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

    const params = this.loadingParams || {};
    const tickerChildren = [
      'Loading data for ',
      createElement('span', { className: 'ticker-var--blue' }, params.pitchGroup || 'All Pitches'),
      ' with max velocity ',
      createElement('span', { className: 'ticker-var--red' }, (params.maxVelocity || '105') + ' MPH'),
    ];
    if (params.seasonYear) {
      tickerChildren.push(' for the ');
      tickerChildren.push(createElement('span', { className: 'ticker-var--green' }, params.seasonYear + ' Full Season'));
    }
    tickerChildren.push(' (this may take up to a few minutes...)');

    return createElement('div', { className: 'team-select-screen loading-screen' },
      createElement('h1', {}, 'Loading', dotsSpan),
      createElement('div', { className: 'ticker-wrap' },
        createElement('span', { className: 'ticker-text' }, ...tickerChildren)
      )
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
      createElement('button', { className: 'team-btn', onclick: () => this.showDateSelect() }, 'Back')
    );
  }
  renderDateSelect() {
  
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Batter Flashcard'),
      createElement('p', { style: { 'margin-bottom': '20px', opacity: '0.8' } },
        'Start by Adjusting the Velocity, Pitch Type, and Selecting a Timeframe'
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
            style: { width: '100%', cursor: 'pointer' },
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
                title: tooltipText
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



// 2. Custom Date Range (Main Feature with Calendar Pickers)
        createElement('div', { style: { padding: '15px', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #dee2e6' } },
          createElement('label', { style: { display: 'block', 'margin-bottom': '15px', 'font-weight': 'bold', 'font-size': '16px' } }, 
            'Custom Date Range'
          ),
          createElement('div', { style: { display: 'flex', gap: '15px', marginBottom: '15px' } },
            createElement('div', { style: { flex: 1 } },
              createElement('label', { style: { display: 'block', fontSize: '12px', marginBottom: '5px', color: '#666' } }, 'Start Date'),
              createElement('input', {
                id: 'startDate', type: 'date',
                value: this.lastStartDate || '',
                style: { width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer' }
              })
            ),
            createElement('div', { style: { flex: 1 } },
              createElement('label', { style: { display: 'block', fontSize: '12px', marginBottom: '5px', color: '#666' } }, 'End Date'),
              createElement('input', {
                id: 'endDate', type: 'date',
                value: this.lastEndDate || '',
                style: { width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #ccc', cursor: 'pointer' }
              })
            )
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
              this.loadDataRange(startRaw, endRaw, maxVel, null, pitchGroup);
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
        ),

        // 3. Quick Options (Smaller, secondary buttons)
createElement('div', {},
          createElement('label', { style: { display: 'block', 'margin-bottom': '10px', 'font-weight': 'bold', 'font-size': '14px', color: '#666' } }, 
            'Quick Options'
          ),
          createElement('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center' } },
            createElement('button', {
              // Uses standard "Load Custom Range" blue
              className: 'team-btn', style: { padding: '8px 10px', fontSize: '13px', flex: 1 },
              onclick: () => this.fetchSmartData(7)
            }, 'Load Last 7 Days'),
            createElement('button', {
              // Uses standard "Load Custom Range" blue
              className: 'team-btn', style: { padding: '8px 10px', fontSize: '13px', flex: 1 },
              onclick: () => this.fetchSmartData(30)
            }, 'Load Last 30 Days'),
            createElement('button', {
              // Deep Navy to match the "Filter Trackman Data" Title
              className: 'team-btn', style: { padding: '8px 10px', fontSize: '13px', flex: 1, background: 'rgb(26, 71, 143)', border: 'none', boxShadow: 'none' },
              onclick: () => this.fetchSmartData(null)
            }, 'Load Last Full Season')
          )
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
          createElement('span', { className: 'info-bubble' }, `${METADATA?.startDate || 'N/A'} → ${METADATA?.endDate || 'N/A'}`)
        ),
        createElement('button', { className: 'back-btn', onclick: () => this.showDateSelect() }, '⮜ Change Dates')
      ),
      createElement('div', { className: 'team-grid' }, ...teamButtons)
    );
  }

  renderLineup() {
    const lineup = TEAMS_DATA[this.selectedTeam];
    const cards = lineup.map((batter, i) => {
      return createElement('div', {
        className: 'mini-card',
        onclick: () => this.showFlashcard(i)
      },
        createElement('div', { className: 'mini-card-order' }, `#${i + 1}`),
        createElement('div', { className: 'mini-card-name' }, batter.batter),
        createElement('div', { className: `mini-card-hand ${batter.handedness}` }, batter.handedness),
        createElement('div', { className: 'mini-card-pitches' }, `${batter.stats?.totalPitches || 0} pitches`)
      );
    });
    return createElement('div', { className: 'lineup-screen' },
      createElement('div', { className: 'lineup-header' },
        createElement('button', { className: 'back-btn', onclick: () => this.showTeamSelect() }, '⮜ Teams'),
        createElement('h1', {}, `${this.selectedTeam} Lineup`),
        createElement('span', { className: 'info-bubble' }, `${lineup.length} batters`),
        createElement('button', { className: 'print-btn', onclick: () => this.printLineup() }, 'Print Lineup')
      ),
      createElement('div', { className: 'lineup-grid' }, ...cards)
    );
  }
  renderSettingsPanel(maxPitches = 50) {
    const createSlider = (label, key, min, max, step = 1) => {
      return createElement('div', { className: 'setting-item' },
        createElement('label', { className: 'setting-label' }, label),
        createElement('div', { className: 'setting-input-group' },
          createElement('input', {
            type: 'range',
            min: min,
            max: max,
            step: step,
            value: CURRENT_SETTINGS[key],
            className: 'setting-slider',
            oninput: (e) => {
              const value = parseFloat(e.target.value);
              this.updateSetting(key, value);
              e.target.parentElement.querySelector('.setting-number-input').value = value;
            }
          }),
          createElement('input', {
            type: 'number',
            min: min,
            max: max,
            step: step,
            value: CURRENT_SETTINGS[key],
            className: 'setting-number-input',
            oninput: (e) => {
              const value = parseFloat(e.target.value);
              if (value >= min && value <= max) {
                this.updateSetting(key, value);
                e.target.parentElement.querySelector('.setting-slider').value = value;
              }
            }
          })
        )
      );
    };
    const createCheckbox = (label, key) => {
      return createElement('div', { className: 'setting-item' },
        createElement('label', { className: 'setting-label' }, label),
        createElement('input', {
          type: 'checkbox',
          checked: CURRENT_SETTINGS[key],
          className: 'setting-checkbox',
          onchange: (e) => {
            this.updateSetting(key, e.target.checked);
          }
        })
      );
    };
    return createElement('div', { className: 'settings-overlay', onclick: () => this.toggleSettings() },
      createElement('div', { className: 'settings-modal', onclick: (e) => e.stopPropagation() },

        // Header
        createElement('div', { className: 'settings-modal__header' },
          createElement('h3', { className: 'settings-modal__title' }, 'Analysis Settings'),
          createElement('p', { className: 'settings-modal__subtitle' }, 'Adjust thresholds and display preferences')
        ),

        // Body — cards (only settings that are actually wired up)
        createElement('div', { className: 'settings-modal__body' },
          createElement('div', { className: 'settings-grid' },

            // Pitch Display — full width
            createElement('div', { className: 'settings-card full-width' },
              createElement('div', { className: 'settings-card__header' }, 'Pitch Display'),
              createSlider('Max Pitches Displayed', 'maxPitchesDisplayed', 1, maxPitches, 1),
              createSlider('Pitch Circle Size (px)', 'pitchCircleSize', 32, 50, 1),
              createCheckbox('Show Only Good Pitches', 'showOnlyGoodPitches'),
              createCheckbox('Show Only Bad Pitches', 'showOnlyBadPitches')
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

        // Sticky footer
        createElement('div', { className: 'settings-modal__footer' },
          createElement('button', { className: 'settings-modal__reset-btn', onclick: () => this.resetSettings() }, 'Reset to Defaults'),
          createElement('button', { className: 'settings-modal__close-btn', onclick: () => this.toggleSettings() }, 'Close')
        )
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
          createElement('button', {
            className: 'info-btn',
            onclick: () => this.toggleInfo()
          }, '?'),
          createElement('button', {
            className: 'settings-btn',
            onclick: () => this.toggleSettings()
          }, '⚙')
        ),
        createElement('div', { className: 'header__controls' },
          createElement('span', { className: 'chip back-chip', onclick: () => this.showLineup(this.selectedTeam) }, '⮜ Lineup'),
          createElement('span', { className: 'chip print-chip', onclick: () => this.printCurrentCard() }, 'Print'),
          createElement('span', {
            className: 'chip', onclick: () => {
              this.selectedBatterIndex = (this.selectedBatterIndex - 1 + lineup.length) % lineup.length;
              this.render();
            }
          }, '⮜ Prev'),
          createElement('span', {
            className: 'chip', onclick: () => {
              this.selectedBatterIndex = (this.selectedBatterIndex + 1) % lineup.length;
              this.render();
            }
          }, 'Next ⮞')
        )
      ),
      this.showInfoPanel ? createElement('div', { className: 'info-overlay', onclick: () => this.toggleInfo() },
        createElement('div', { className: 'info-modal', onclick: (e) => e.stopPropagation() },

          // Header
          createElement('div', { className: 'info-modal__header' },
            createElement('h3', { className: 'info-modal__title' }, 'Understanding the Widget'),
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
                  'Green circles = attack (whiffs, weak contact). Red circles = avoid (hard contact, balls in play). The batter icon shows their batting stance. The small L or R indicates if the pitch was thrown by a Left-Handed or Right-Handed pitcher.'
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
            createElement('div', { className: 'info-entry' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#fef9c3' } }, '⚡'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Vulnerable Zones'),
                createElement('div', { className: 'info-entry__desc' },
                  'Locations where the batter struggles most — high whiff rate, weak contact, or excessive fouls. Attack here.'
                )
              )
            ),

            // Hot Zones
            createElement('div', { className: 'info-entry' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#fee2e2' } }, '🔥'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Hot Zones (Avoid)'),
                createElement('div', { className: 'info-entry__desc' },
                  'Where the batter makes hard contact (95+ mph exit velocity). Pitching here is dangerous — stay out.'
                )
              )
            ),

            // Out Sequence
            createElement('div', { className: 'info-entry' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#ede9fe' } }, '📋'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Out Sequence'),
                createElement('div', { className: 'info-entry__desc' },
                  'The most common pitch sequences that historically get this batter out — groundouts, flyouts, strikeouts. Use this as your blueprint.'
                )
              )
            ),

            // Weakness Confidence
            createElement('div', { className: 'info-entry' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#d1fae5' } }, '🎚️'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'Weakness Confidence'),
                createElement('div', { className: 'info-entry__desc' },
                  'Controls how strict the vulnerability filter is. ',
                  createElement('strong', {}, 'Strict'), ' = critical weaknesses only. ',
                  createElement('strong', {}, 'Balanced'), ' = critical + major. ',
                  createElement('strong', {}, 'Broad'), ' = all identified weaknesses.'
                )
              )
            ),

            // Threats
            createElement('div', { className: 'info-entry' },
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
                    createElement('strong', {}, 'Spray:'), ' Pull hitter, opposite field, or all-fields tendency.'
                  )
                )
              )
            ),

            // First Pitch
            createElement('div', { className: 'info-entry info-entry--last' },
              createElement('div', { className: 'info-entry__icon', style: { background: '#dcfce7' } }, '🟢'),
              createElement('div', { className: 'info-entry__content' },
                createElement('div', { className: 'info-entry__title' }, 'First-Pitch Approach'),
                createElement('div', { className: 'info-entry__desc' },
                  'Shows how often the batter swings at the first pitch. Above 50% = Aggressive. Below = Patient. Use this to decide your opening pitch.'
                )
              )
            )
          ),

          // Footer
          createElement('div', { className: 'info-modal__footer' },
            createElement('button', { className: 'info-modal__close-btn', onclick: () => this.toggleInfo() }, 'Got it')
          )
        )
      ) : null,
      this.showSettingsPanel ? this.renderSettingsPanel(data.stats?.totalPitches || 50) : null,
      (() => {
        const tendenciesEl = createTendencies(data.tendencies, data.stats, data.zoneAnalysis, data.powerSequence, this);
        const pitchZoneEl = createElement('div', { className: 'pitch-zone-section' }, createPitchZone(data.pitchZones || [], data.handedness, app?.allowedZones || null));
        const batterEl = createBatterGraphic(data.handedness, data.batter, data.pitchZones);

        const frag = document.createDocumentFragment();
        frag.appendChild(pitchZoneEl);
        frag.appendChild(batterEl);
        frag.appendChild(tendenciesEl);
        return frag;
      }) ()
    );
  }
  render() {
    this.container.innerHTML = '';
    let content;
    if (this.currentScreen === 'loading') content = this.renderLoading();
    else if (this.currentScreen === 'error') content = this.renderError();
    else if (this.currentScreen === 'dateSelect') content = this.renderDateSelect();
    else if (this.currentScreen === 'teamSelect') content = this.renderTeamSelect();
    else if (this.currentScreen === 'lineup') content = this.renderLineup();
    else if (this.currentScreen === 'flashcard') content = this.renderFlashcard();
    this.container.appendChild(content);
  }
}
let app;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {app =  new FlashcardApp(document.getElementById('app')); });
} else {
  app = new FlashcardApp(document.getElementById('app'));
}
