let TEAMS_DATA = {};
let METADATA = null;
// Default settings
const DEFAULT_SETTINGS = {
  // First pitch thresholds
  aggressiveFirstPitchThreshold: 50,
  // Steal threat thresholds
  stealHighAttemptsThreshold: 3,
  stealModerateAttemptsThreshold: 1,
  // Bunt threat thresholds
  buntHighThreshold: 3,
  buntModerateThreshold: 1,
  // Spray chart thresholds
  sprayPullThreshold: 60,
  sprayOppoThreshold: 40,
  sprayMinAtBats: 5,
  sprayAngleThreshold: 15,
  // Zone analysis thresholds
  vulnerableZoneMinSwings: 3,
  vulnerableZoneThreshold: 45,
  hotZoneMinHardHits: 2,
  hotZoneHardHitThreshold: 40,
  // Contact quality thresholds
  hardContactThreshold: 95,
  weakContactThreshold: 70,
  // Pitch display settings
  maxPitchesDisplayed: 10,
  showOnlyGoodPitches: false,
  showOnlyBadPitches: false,
  pitchCircleSize: 32
};
let CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };
function createElement(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (key === 'className') {
      el.className = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(el.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.substring(2).toLowerCase(), value);
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
function createPitchZone(zones, handedness) {
  const safeZones = Array.isArray(zones) ? zones : [];
  // Apply pitch filtering based on settings
  let filteredZones = safeZones;
  if (CURRENT_SETTINGS.showOnlyGoodPitches) {
    filteredZones = filteredZones.filter(z => z.good === true);
  } else if (CURRENT_SETTINGS.showOnlyBadPitches) {
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
    return createElement('div', {
      className: `pitch-circle ${colorClass}`,
      style: { left: `${x}%`, top: `${y}%` },
      title: `${pitchType} — ${isGood ? 'Attack here' : 'Avoid this location'}`
    }, pitchType);
  });
  const isLeftHanded = handedness === 'LHB';
  const batterClass = isLeftHanded ? 'batter-graphic-left-handed' : 'batter-graphic-right-handed';
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
  const pitchZone = createElement('div', { className: 'pitch-zone' }, ...pitchElements);
  pitchZone.style.setProperty('--pitch-circle-size', `${CURRENT_SETTINGS.pitchCircleSize}px`);
  return createElement('div', { className: 'pitch-zone-container' },
    batterGraphic,
    pitchZone
  );
}
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
function createTendencies(tendencies, stats, zoneAnalysis, powerSequence) {
  const stripPercents = (text) => {
    if (typeof text !== 'string') return text;
    // Drop any parenthetical that contains a percent, then any standalone percents, then tidy spaces
    return text
      .replace(/\([^)]*%[^)]*\)/g, '')
      .replace(/\d+\s*%/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  const safeStats = stats || {};
  const swingRate = safeStats.totalPitches > 0
    ? `${(safeStats.swings / safeStats.totalPitches * 100).toFixed(0)}%`
    : 'N/A';
  const contactRate = safeStats.swings > 0
    ? `${(safeStats.contact / safeStats.swings * 100).toFixed(0)}%`
    : 'N/A';
  const whiffRate = safeStats.swings > 0
    ? `${(safeStats.whiffs / safeStats.swings * 100).toFixed(0)}%`
    : 'N/A';
  const firstPitchSwingRate = safeStats.firstPitchPitches > 0
    ? `${(safeStats.firstPitchSwings / safeStats.firstPitchPitches * 100).toFixed(0)}%`
    : 'N/A';
  const vulnerableZones = [];
  const hotZones = [];
  if (zoneAnalysis) {
    Object.entries(zoneAnalysis).forEach(([zone, stats]) => {
      if (stats.swings > CURRENT_SETTINGS.vulnerableZoneMinSwings) {
        const whiffPct = (stats.whiffs / stats.swings * 100);
        const weakContactPct = stats.contact > 0 ? (stats.weakContact / stats.contact * 100) : 0;
        const foulPct = (stats.fouls / stats.swings * 100);
        const combinedVulnerability = whiffPct + (weakContactPct * 0.5) + (foulPct * 0.3);
        if (combinedVulnerability > CURRENT_SETTINGS.vulnerableZoneThreshold) {
          vulnerableZones.push({ zone, score: combinedVulnerability.toFixed(0) });
        }
        const hardHitPct = stats.contact > 0 ? (stats.hardHits / stats.contact * 100) : 0;
        if (hardHitPct > CURRENT_SETTINGS.hotZoneHardHitThreshold && stats.hardHits >= CURRENT_SETTINGS.hotZoneMinHardHits) {
          hotZones.push({ zone, hardHitPct: hardHitPct.toFixed(0) });
        }
      }
    });
  }
  vulnerableZones.sort((a, b) => b.score - a.score);
  hotZones.sort((a, b) => b.hardHitPct - a.hardHitPct);
  let firstPitchText = tendencies?.firstStrike || `Swings ${firstPitchSwingRate} on first pitch`;
  let sprayText = tendencies?.spray || 'All fields';
  firstPitchText = stripPercents(firstPitchText);
  sprayText = stripPercents(sprayText);
  const cleanedPowerSequence = stripPercents(powerSequence || 'Insufficient data');
  return createElement('div', { className: 'info-section' },
    createElement('div', { className: 'power-sequence stats-box' },
      createElement('h4', {}, 'First-Pitch Approach'),
      createElement('div', { className: 'power-sequence-text' }, firstPitchText)
    ),
    vulnerableZones.length > 0 ? createElement('div', { className: 'power-sequence vulnerable-zone' },
      createElement('h4', {}, 'Vulnerable Zones'),
      createElement('div', { className: 'power-sequence-text' },
        vulnerableZones.slice(0, 2).map(z => z.zone).join(', ') || 'Calculating...')
    ) : null,
    hotZones.length > 0 ? createElement('div', { className: 'power-sequence hot-zone' },
      createElement('h4', {}, 'Hot Zones (Avoid)'),
      createElement('div', { className: 'power-sequence-text' },
        hotZones.slice(0, 2).map(z => z.zone).join(', ') || 'None identified')
    ) : null,
    createElement('div', { className: 'power-sequence' },
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
      createPitchZone(batter.pitchZones || [], batter.handedness)
    );
    const infoSection = createTendencies(batter.tendencies, batter.stats, batter.zoneAnalysis, batter.powerSequence);
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
  async loadDataRange(startDate, endDate) {
    try {
      this.currentScreen = 'loading';
      this.loadingMessage = `Loading data from ${startDate} to ${endDate}...`;
      this.render();
      const response = await fetch(
        `./api/teams/range?startDate=${startDate}&endDate=${endDate}`
      );
      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      const data = await response.json();
      TEAMS_DATA = data.teamsData;
      METADATA = data.metadata;
      this.currentScreen = 'teamSelect';
      this.render();
    } catch (err) {
      console.error(err);
      this.currentScreen = 'error';
      this.error = err.message;
      this.render();
    }
  }
  showDateSelect() { this.currentScreen = 'dateSelect'; this.render(); }
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
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Loading...'),
      createElement('p', {}, this.loadingMessage)
    );
  }
  renderError() {
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Error Loading Data'),
      createElement('p', {}, this.error),
      createElement('button', { className: 'team-btn', onclick: () => this.showDateSelect() }, 'Back')
    );
  }
  renderDateSelect() {
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Select Date Range'),
      createElement('p', { style: { 'margin-bottom': '30px', opacity: '0.8' } },
        'Enter dates in YYYYMMDD format'
      ),
      createElement('div', {
        style: {
          'max-width': '500px',
          margin: '0 auto',
          display: 'flex',
          'flex-direction': 'column',
          gap: '20px'
        }
      },
        createElement('div', {},
          createElement('label', {
            style: {
              display: 'block',
              'margin-bottom': '10px',
              'font-weight': 'bold'
            }
          }, 'Start Date'),
          createElement('input', {
            id: 'startDate',
            type: 'text',
            placeholder: '20240517',
            value: '20240517',
            style: {
              width: '100%',
              padding: '15px',
              'font-size': '20px',
              'text-align': 'center',
              border: '2px solid #2196F3',
              'border-radius': '8px',
              'font-family': 'monospace'
            }
          })
        ),
        createElement('div', {},
          createElement('label', {
            style: {
              display: 'block',
              'margin-bottom': '10px',
              'font-weight': 'bold'
            }
          }, 'End Date'),
          createElement('input', {
            id: 'endDate',
            type: 'text',
            placeholder: '20240519',
            value: '20240519',
            style: {
              width: '100%',
              padding: '15px',
              'font-size': '20px',
              'text-align': 'center',
              border: '2px solid #2196F3',
              'border-radius': '8px',
              'font-family': 'monospace'
            }
          })
        ),
        createElement('div', {
          style: {
            'font-size': '14px',
            opacity: '0.7',
            'margin-top': '10px'
          }
        },
          createElement('strong', {}, 'Good date ranges:'),
          createElement('br', {}),
          '• 20240517 to 20240519 (3 days)',
          createElement('br', {}),
          '• 20240503 to 20240531 (May 2024)',
          createElement('br', {}),
          '• 20240601 to 20240630 (June 2024)'
        )
      ),
      createElement('button', {
        className: 'team-btn',
        style: { 'margin-top': '30px' },
        onclick: () => {
          const startDate = document.getElementById('startDate').value;
          const endDate = document.getElementById('endDate').value;
          this.loadDataRange(startDate, endDate);
        }
      }, 'Load Data')
    );
  }
  renderTeamSelect() {
    const teams = Object.keys(TEAMS_DATA);
    if (teams.length === 0) {
      return createElement('div', { className: 'team-select-screen' },
        createElement('p', {}, 'No team data.'),
        createElement('button', { className: 'team-btn', onclick: () => this.showDateSelect() }, 'Back')
      );
    }
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
            createElement('span', { className: 'stat-number' }, totalPitches),
            createElement('span', { className: 'stat-label' }, 'Pitches')
          )
        )
      );
    });
    return createElement('div', { className: 'team-select-screen' },
      createElement('div', { className: 'team-select-header' },
        createElement('h1', {}, 'Select a Team'),
        createElement('p', {}, `${teams.length} teams available • Date range: ${METADATA?.startDate || 'N/A'} - ${METADATA?.endDate || 'N/A'}`),
        createElement('button', { className: 'back-btn', onclick: () => this.showDateSelect() }, '← Change Dates')
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
        createElement('div', { className: 'mini-card-hand' }, batter.handedness),
        createElement('div', { className: 'mini-card-pitches' }, `${batter.stats?.totalPitches || 0} pitches`)
      );
    });
    return createElement('div', { className: 'lineup-screen' },
      createElement('div', { className: 'lineup-header' },
        createElement('button', { className: 'back-btn', onclick: () => this.showTeamSelect() }, '← Teams'),
        createElement('h1', {}, `${this.selectedTeam} Lineup`),
        createElement('p', {}, `${lineup.length} batters`),
        createElement('button', { className: 'print-btn', onclick: () => this.printLineup() }, 'Print Lineup')
      ),
      createElement('div', { className: 'lineup-grid' }, ...cards)
    );
  }
  renderSettingsPanel() {
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
        createElement('h3', {}, 'Analysis Settings'),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Pitch Display'),
          createSlider('Max Pitches Displayed', 'maxPitchesDisplayed', 1, 50, 1),
          createSlider('Pitch Circle Size (px)', 'pitchCircleSize', 32, 100, 1),
          createCheckbox('Show Only Good Pitches', 'showOnlyGoodPitches'),
          createCheckbox('Show Only Bad Pitches', 'showOnlyBadPitches')
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'First Pitch Approach'),
          createSlider('Aggressive Threshold (%)', 'aggressiveFirstPitchThreshold', 0, 100, 5)
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Steal Threat'),
          createSlider('High Threat Min Attempts', 'stealHighAttemptsThreshold', 1, 10, 1),
          createSlider('Moderate Threat Min Attempts', 'stealModerateAttemptsThreshold', 1, 5, 1)
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Bunt Threat'),
          createSlider('High Threat Min Bunts', 'buntHighThreshold', 1, 10, 1),
          createSlider('Moderate Threat Min Bunts', 'buntModerateThreshold', 1, 5, 1)
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Spray Chart'),
          createSlider('Pull Hitter Threshold (%)', 'sprayPullThreshold', 0, 100, 5),
          createSlider('Opposite Field Threshold (%)', 'sprayOppoThreshold', 0, 100, 5),
          createSlider('Min At Bats for Analysis', 'sprayMinAtBats', 1, 20, 1),
          createSlider('Angle Threshold (degrees)', 'sprayAngleThreshold', 5, 45, 5)
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Zone Analysis'),
          createSlider('Vulnerable Zone Min Swings', 'vulnerableZoneMinSwings', 1, 10, 1),
          createSlider('Vulnerable Zone Threshold', 'vulnerableZoneThreshold', 0, 100, 5),
          createSlider('Hot Zone Min Hard Hits', 'hotZoneMinHardHits', 1, 10, 1),
          createSlider('Hot Zone Hard Hit % Threshold', 'hotZoneHardHitThreshold', 0, 100, 5)
        ),
        createElement('div', { className: 'settings-section' },
          createElement('h4', {}, 'Contact Quality'),
          createSlider('Hard Contact Threshold (mph)', 'hardContactThreshold', 80, 110, 1),
          createSlider('Weak Contact Threshold (mph)', 'weakContactThreshold', 50, 90, 1)
        ),
        createElement('div', { className: 'settings-buttons' },
          createElement('button', { className: 'reset-btn', onclick: () => this.resetSettings() }, 'Reset to Defaults'),
          createElement('button', { className: 'close-settings-btn', onclick: () => this.toggleSettings() }, 'Close')
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
          createElement('span', { className: 'meta' }, data.handedness || ''),
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
          createElement('span', { className: 'chip back-chip', onclick: () => this.showLineup(this.selectedTeam) }, '← Lineup'),
          createElement('span', { className: 'chip print-chip', onclick: () => this.printCurrentCard() }, 'Print'),
          createElement('span', {
            className: 'chip', onclick: () => {
              this.selectedBatterIndex = (this.selectedBatterIndex - 1 + lineup.length) % lineup.length;
              this.render();
            }
          }, '◀ Prev'),
          createElement('span', {
            className: 'chip', onclick: () => {
              this.selectedBatterIndex = (this.selectedBatterIndex + 1) % lineup.length;
              this.render();
            }
          }, 'Next ▶')
        )
      ),
      this.showInfoPanel ? createElement('div', { className: 'info-overlay', onclick: () => this.toggleInfo() },
        createElement('div', { className: 'info-modal', onclick: (e) => e.stopPropagation() },
          createElement('h3', {}, 'Understanding this Widget'),
          createElement('div', { className: 'info-content' },
            createElement('p', {}, createElement('strong', {}, 'Strike Zone:'), ' Green circles = attack these locations (whiffs, weak contact). Red circles = avoid (hard contact, balls). Letters show pitch type: 4S (Four-Seam), SL (Slider), CB (Curveball), CH (Changeup), SI (Sinker), FC (Cutter), SP (Splitter). The batter icon shows their batting stance.'),
            createElement('p', {}, createElement('strong', {}, 'Vulnerable Zones:'), ' Where batter struggles most. High whiff rates, weak contact, or lots of fouls. Attack here!'),
            createElement('p', {}, createElement('strong', {}, 'Hot Zones:'), ' Danger zones where batter hits hard (95+ mph exit velo). Avoid pitching here.'),
            createElement('p', {}, createElement('strong', {}, 'Out Sequence:'), ' Most common pitch sequences that get this batter out (groundouts, flyouts, strikeouts, etc.). Shows what historically works against them.'),
            createElement('p', {}, createElement('strong', {}, 'Threats:'), ' Steal threat shows base running ability (infield hits, speed indicators). Bunt threat shows contact rate and bat control. Spray chart shows pull/opposite field tendencies.'),
            createElement('p', {}, createElement('strong', {}, 'First-Pitch:'), ' Shows if batter is aggressive (>50% swing rate) or patient on first pitch.')
          ),
          createElement('button', { className: 'close-info-btn', onclick: () => this.toggleInfo() }, 'Close')
        )
      ) : null,
      this.showSettingsPanel ? this.renderSettingsPanel() : null,
      createElement('div', { className: 'pitch-zone-section' }, createPitchZone(data.pitchZones || [], data.handedness)),
      createBatterGraphic(data.handedness, data.batter, data.pitchZones),
      createTendencies(data.tendencies, data.stats, data.zoneAnalysis, data.powerSequence)
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
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new FlashcardApp(document.getElementById('app')));
} else {
  new FlashcardApp(document.getElementById('app'));
}
