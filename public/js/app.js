/**
 * app.js — FlashcardApp: selection state, data loading and the render loop.
 *
 * The class is split across files by concern; toolbar.js, card.js, settings.js
 * and print.js each add their methods to FlashcardApp.prototype. main.js starts it.
 */

'use strict';

class FlashcardApp {
  constructor(container) {
    this.container = container;
    // The toolbar (Team → Hitter → Dates → Print) sits above #app and is always
    // on screen; #app holds whatever the selection produced. One data path: a
    // chosen hitter plus a date window becomes one GET /api/batter/card.
    this.toolbarEl = document.getElementById('toolbar');
    if (!this.toolbarEl) {
      this.toolbarEl = document.createElement('div');
      this.toolbarEl.id = 'toolbar';
      container.parentNode.insertBefore(this.toolbarEl, container);
    }
    // 'starting' | 'idle' | 'loading' | 'card' | 'noData' | 'error'
    this.status = 'starting';
    this.teamScope = '';              // '' = every rostered hitter, a club guid, or 'ALL'
    this.selectedBatterInfo = null;   // { name, ids, team, bats } chosen in the toolbar
    this.batterQuery = '';            // live search text in the hitter box
    this.cardTeam = null;             // TEAMS_DATA key of the profile on screen
    this.cardIndex = 0;               // which profile under it (a switch hitter has two)
    this.lastMaxVelocity = 105;
    this.lastPitchGroup = 'All';
    const savedRange = this.readSavedRange();
    this.rangePreset = savedRange.preset;
    this.customRange = savedRange.custom;
    this.showInfoPanel = false;
    this.showSettingsPanel = false;
    // Settings live in an always-visible docked sidebar by default (never printed).
    // On mobile the docked sidebar stacks BELOW the card (see styles.css
    // @media max-width:768px), so it can start docked everywhere without covering
    // the flashcard. Users hide it on demand via the "⚙ Hide Settings" button.
    this.isSettingsDocked = true;
    this.ensurePrintContainers();
    this.setupKeyboard();
    window.addEventListener('resize', () => this.syncToolbarHeight());
    this.loadBattersIndex();
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
    const lineup = TEAMS_DATA[this.cardTeam];
    if (!lineup) return;
    const data = lineup[this.cardIndex];
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

  /** The window the Dates control currently means. */
  currentRange() {
    return rangeForPreset(this.rangePreset, this.customRange, todayIso());
  }

  /**
   * The remembered Dates choice. Per-viewer convenience only: storage can be
   * missing or throw (private windows, blocked site data), so it always falls
   * back to the season.
   */
  readSavedRange() {
    const fallback = { preset: DEFAULT_RANGE_PRESET, custom: { start: '', end: '' } };
    try {
      const saved = JSON.parse(localStorage.getItem('flashcard.range') || 'null');
      if (!saved || !RANGE_PRESETS.includes(saved.preset)) return fallback;
      const custom = saved.custom && typeof saved.custom.start === 'string' && typeof saved.custom.end === 'string'
        ? { start: saved.custom.start, end: saved.custom.end }
        : fallback.custom;
      return { preset: saved.preset, custom };
    } catch (_) {
      return fallback;
    }
  }

  saveRange() {
    try {
      localStorage.setItem('flashcard.range', JSON.stringify({ preset: this.rangePreset, custom: this.customRange }));
    } catch (_) { /* storage unavailable — the choice just isn't remembered */ }
  }

  /**
   * Hitters the Hitter box offers for a team scope. iScore club rosters are the
   * reliable team source — SLUGGER's own team_name is absent for 132 batters and
   * cannot express a mid-season trade. Without rosters (iScore down) every scope
   * falls back to the flat SLUGGER index.
   * @param {string} [scope] - '' = all rostered hitters, a club guid, or 'ALL'.
   */
  hitterPool(scope = this.teamScope) {
    const useRosters = ROSTERS.length > 0 && scope !== 'ALL';
    if (!useRosters) return BATTERS_INDEX.map(b => ({ ...b, number: '', position: '' }));
    if (scope) {
      const team = ROSTERS.find(t => t.guid === scope);
      return (team ? team.batters : []).map(b => ({ ...b, team: team.name }));
    }
    return ROSTERS.flatMap(t => t.batters.map(b => ({ ...b, team: t.name })));
  }

  /** The club in scope, or null for "All teams" / "Everyone in SLUGGER". */
  scopedTeam() {
    if (!this.teamScope || this.teamScope === 'ALL') return null;
    return ROSTERS.find(t => t.guid === this.teamScope) || null;
  }

  setTeamScope(scope) {
    this.teamScope = scope;
    this.batterQuery = '';
    this.renderToolbar();
    // Picking a team is almost always followed by picking one of its hitters.
    const search = document.getElementById('batterSearch');
    if (search) search.focus();
  }

  /**
   * @param {{name:string, ids:string[], team:string, bats:string}} batter
   */
  selectBatter(batter) {
    this.selectedBatterInfo = batter;
    this.batterQuery = '';
    this.resetBatterScopedSettings();
    this.loadBatterCard();
  }

  /**
   * Steps to the previous/next hitter in the current team scope (alphabetical),
   * keeping the date window. Scoped on purpose: stepping through every player
   * with ALPB pitch data is not a list anyone scouts.
   * @param {number} delta - +1 for next, -1 for previous.
   */
  gotoAdjacentBatter(delta) {
    const pool = this.hitterPool().sort((a, b) => a.name.localeCompare(b.name));
    if (!pool.length) return;
    const curIds = new Set(this.selectedBatterInfo ? this.selectedBatterInfo.ids : []);
    const idx = pool.findIndex(b => (b.ids || []).some(id => curIds.has(id)));
    const next = idx < 0
      ? pool[delta > 0 ? 0 : pool.length - 1]
      : pool[(idx + delta + pool.length) % pool.length];
    this.selectBatter(next);
  }

  setRangePreset(preset) {
    if (preset === 'custom') {
      // Seed the date boxes with the window on screen, so Custom starts from it.
      if (!this.customRange.start || !this.customRange.end) this.customRange = { ...this.currentRange() };
      this.rangePreset = 'custom';
      this.rangeError = null;
      this.renderToolbar();
      return; // waits for Apply
    }
    this.rangePreset = preset;
    this.rangeError = null;
    this.saveRange();
    this.renderToolbar();
    if (this.selectedBatterInfo) this.loadBatterCard();
  }

  applyCustomRange(start, end) {
    if (!start || !end) {
      this.rangeError = 'Pick both a start and an end date.';
    } else if (end < start) {
      this.rangeError = 'The end date is before the start date.';
    } else if (end > todayIso()) {
      this.rangeError = 'The end date is in the future.';
    } else {
      this.rangeError = null;
    }
    if (this.rangeError) {
      this.renderToolbar();
      return;
    }
    this.customRange = { start, end };
    this.saveRange();
    this.renderToolbar();
    if (this.selectedBatterInfo) this.loadBatterCard();
  }

  /**
   * Loads the distinct-batter index from GET /api/batters (cheap — built from the
   * server's in-memory player cache, no pitch-space scan), then the rosters.
   */
  async loadBattersIndex() {
    this.status = 'starting';
    this.render();
    try {
      const response = await fetch('./api/batters');
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.batters)) {
        throw new Error(data.message || `Failed to load batters (${response.status})`);
      }
      BATTERS_INDEX = data.batters;
      this.status = 'idle';
      this.render();
      // Rosters are a progressive enhancement: the Hitter box already works on
      // the flat index, so they load after first paint and never block it.
      this.loadRosters();
    } catch (err) {
      console.error(err);
      this.error = `Could not load the player list: ${err.message}`;
      this.retry = () => this.loadBattersIndex();
      this.status = 'error';
      this.render();
    }
  }

  /**
   * Loads iScore club rosters in the background and redraws the toolbar with a
   * Team control once they arrive. Failure is deliberately quiet: the Hitter box
   * still works on the flat index, so a wobbly third-party API should not put an
   * error over a page that is already usable.
   */
  async loadRosters() {
    this.rostersState = 'loading';
    this.renderToolbar();
    try {
      const response = await fetch('./api/rosters');
      const data = await response.json();
      if (response.ok && Array.isArray(data.teams) && data.teams.length > 0) {
        ROSTERS = data.teams;
        ROSTER_UNMATCHED = data.unmatched || [];
        this.rostersState = 'ready';
      } else {
        this.rostersState = 'failed';
      }
    } catch (err) {
      console.warn('Rosters unavailable, falling back to the full batter list:', err.message);
      this.rostersState = 'failed';
    }
    this.renderToolbar();
  }

  /**
   * Fetches the selected hitter's card for the toolbar's date window from
   * GET /api/batter/card (filtered by batter_id — never the whole pitch space).
   * A newer request supersedes an older one still in flight, so stepping
   * quickly through a roster never paints a stale card.
   */
  async loadBatterCard() {
    const batter = this.selectedBatterInfo;
    if (!batter || !batter.ids || batter.ids.length === 0) {
      this.status = 'idle';
      this.render();
      return;
    }
    const range = this.currentRange();
    const maxVelocity = this.lastMaxVelocity;
    const pitchGroup = this.lastPitchGroup;
    const token = (this.cardRequest || 0) + 1;
    this.cardRequest = token;
    const superseded = () => token !== this.cardRequest;

    this.status = 'loading';
    const pitchLabel = { All: 'All Pitches', Fastballs: 'Fastballs', Breaking: 'Breaking Balls', Offspeed: 'Offspeed' }[pitchGroup] || 'All Pitches';
    this.loadingParams = { batterName: batter.name, rangeLabel: formatRange(range), pitchGroup: pitchLabel, maxVelocity };
    this.render();

    try {
      const ids = encodeURIComponent(batter.ids.join(','));
      const response = await fetch(
        `./api/batter/card?batterIds=${ids}&startDate=${range.start}&endDate=${range.end}&maxVelocity=${maxVelocity}&pitchGroup=${pitchGroup}`
      );
      const data = await response.json();
      if (superseded()) return;

      if (!response.ok) {
        const code = data.error || 'unknown';
        if (code === 'no_data' || code === 'no_data_velocity') {
          this.noDataMessage = data.message || 'No pitch data found for this batter in the selected window.';
          this.status = 'noData';
        } else {
          this.error = data.message || `Error loading data (${response.status})`;
          this.retry = () => this.loadBatterCard();
          this.status = 'error';
        }
        this.render();
        return;
      }

      if (!data.teamsData || Object.keys(data.teamsData).length === 0) {
        this.noDataMessage = 'No pitch data found for this batter in the selected window.';
        this.status = 'noData';
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
      this.cardTeam = teamKeys.reduce((best, t) => {
        const tp = TEAMS_DATA[t].reduce((s, b) => s + (b.stats?.totalPitches || 0), 0);
        const bp = TEAMS_DATA[best].reduce((s, b) => s + (b.stats?.totalPitches || 0), 0);
        return tp > bp ? t : best;
      }, teamKeys[0]);
      const roster = TEAMS_DATA[this.cardTeam];
      this.cardIndex = roster.reduce((best, b, i) =>
        (b.stats?.totalPitches || 0) > (roster[best].stats?.totalPitches || 0) ? i : best, 0);

      this.status = 'card';
      this.render();
    } catch (err) {
      if (superseded()) return;
      console.error(err);
      this.error = `Error loading data: ${err.message}`;
      this.retry = () => this.loadBatterCard();
      this.status = 'error';
      this.render();
    }
  }

  setupKeyboard() {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = e => {
      if (this.status !== 'card') return;
      // Leave arrow keys alone while someone is typing or choosing in a control.
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') this.gotoAdjacentBatter(1);
      else if (e.key === 'ArrowLeft') this.gotoAdjacentBatter(-1);
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  render() {
    const transient = this.status === 'loading' || this.status === 'error' || this.status === 'starting';
    const _wsy = transient ? 0 : window.scrollY;
    if (transient) window.scrollTo(0, 0);
    // Save scroll positions before re-render
    const _savedScroll = (this.container.querySelector('.settings-sidebar') || {}).scrollTop || 0;
    const _savedModalBodyScroll = (this.container.querySelector('.settings-modal__body') || {}).scrollTop || 0;
    // Clean up existing sidebar and docked state
    document.getElementById('settings-sidebar')?.remove();
    this.container.classList.remove('app-sidebar-docked');

    this.renderToolbar();

    this.container.innerHTML = '';
    let content;
    if (this.status === 'starting' || this.status === 'loading') content = this.renderLoading();
    else if (this.status === 'error') content = this.renderError();
    else if (this.status === 'noData') content = this.renderNoData();
    else if (this.status === 'card') content = this.renderFlashcard();
    else content = this.renderEmpty();
    this.container.appendChild(content);

    // After renderFlashcard has run (populating this._rawZoneCount etc.), mount sidebar
    if (this.isSettingsDocked && this.status === 'card') {
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
