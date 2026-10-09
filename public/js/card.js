/**
 * card.js — what #app shows: the flashcard, or the loading / empty / no-data /
 * error state.
 */

'use strict';

Object.assign(FlashcardApp.prototype, {
  renderLoading() {
    const dotsSpan = createElement('span', { id: 'loading-dots' }, '');
    let dotCount = 0;
    const interval = setInterval(() => {
      const el = document.getElementById('loading-dots');
      if (!el) { clearInterval(interval); return; }
      dotCount = (dotCount + 1) % 4;
      el.textContent = '.'.repeat(dotCount);
    }, 500);

    if (this.status === 'starting') {
      return createElement('div', { className: 'team-select-screen loading-screen' },
        createElement('h1', {}, 'Loading', dotsSpan),
        createElement('p', { className: 'loading-subtitle' }, 'Fetching the player list')
      );
    }

    const params = this.loadingParams || {};
    const pillRow = [
      params.batterName ? createElement('div', { className: 'filter-pill pill-season' }, params.batterName) : null,
      createElement('div', { className: 'filter-pill pill-season' }, params.rangeLabel || ''),
      params.pitchGroup && params.pitchGroup !== 'All Pitches' ? createElement('div', { className: 'filter-pill pill-pitch' }, params.pitchGroup) : null,
      params.maxVelocity && params.maxVelocity < 105 ? createElement('div', { className: 'filter-pill pill-velo' }, `≤ ${params.maxVelocity} MPH`) : null,
    ].filter(Boolean);

    return createElement('div', { className: 'team-select-screen loading-screen' },
      createElement('h1', {}, 'Loading', dotsSpan),
      createElement('p', { className: 'loading-subtitle' }, 'Fetching this hitter’s pitches'),
      createElement('div', { className: 'filter-pill-row' }, ...pillRow)
    );
  },

  renderError() {
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, 'Error Loading Data'),
      createElement('div', { className: 'state-message state-message--error' }, this.error),
      this.retry ? createElement('button', { className: 'team-btn', onclick: () => this.retry() }, 'Try again') : null
    );
  },

  /** Nothing chosen yet. */
  renderEmpty() {
    return createElement('div', { className: 'team-select-screen empty-state' },
      createElement('h1', {}, 'Batter Flashcards'),
      createElement('p', { className: 'state-message' },
        'Choose a team, then a hitter, above. Dates default to the season; change them any time and the card reloads.')
    );
  },

  /**
   * The chosen hitter has no pitches in this window — a prompt, not an error. The
   * toolbar stays up, so the way forward is right there; offer the season as a
   * one-click fallback when a narrower window was the cause.
   */
  renderNoData() {
    const name = this.selectedBatterInfo ? this.selectedBatterInfo.name : 'This batter';
    return createElement('div', { className: 'team-select-screen' },
      createElement('h1', {}, name),
      createElement('p', { className: 'state-message' },
        `${this.noDataMessage || 'No pitch data found for this batter in the selected window.'} (${formatRange(this.currentRange())})`),
      this.rangePreset !== 'season'
        ? createElement('button', { className: 'team-btn', onclick: () => this.setRangePreset('season') }, 'Show the whole season')
        : null
    );
  },

  renderFlashcard() {
    const lineup = TEAMS_DATA[this.cardTeam];
    const data = lineup[this.cardIndex];
    const compactMode = !this.showExpandedCard;
    const summaryItems = [
      createElement('div', { className: 'quick-summary__item' }, `Hand: ${data.handedness || '—'}`),
      createElement('div', { className: 'quick-summary__item' }, `Pitches: ${data.stats?.totalPitches || 0}`),
      createElement('div', { className: 'quick-summary__item' }, `Steal: ${data.tendencies?.stealThreat || 'Low'}`),
    ];
    return createElement('div', { className: `widget${compactMode ? ' widget--compact' : ''}` },
      createElement('div', { className: 'header' },
        createElement('div', { className: 'header__title' },
          createElement('button', {
            className: 'card-nav-btn',
            title: 'Previous hitter',
            onclick: () => this.gotoAdjacentBatter(-1)
          }, '‹'),
          createElement('span', { className: 'name' }, data.batter || 'Unknown'),
          createElement('button', {
            className: 'card-nav-btn',
            title: 'Next hitter',
            onclick: () => this.gotoAdjacentBatter(1)
          }, '›'),
          createElement('span', { className: `mini-card-hand ${data.handedness}` }, data.handedness || ''),
          createElement('span', { className: 'meta' }, `• ${data.stats?.totalPitches || 0} pitches`),
          METADATA ? createElement('span', { className: 'meta' }, `• ${formatRange({ start: METADATA.startDate, end: METADATA.endDate })}`) : null,
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
          }, this.isSettingsDocked ? '⚙ Hide Settings' : '⚙ Show Settings'),
          createElement('button', {
            className: 'settings-btn settings-btn--ghost',
            type: 'button',
            'aria-pressed': this.showExpandedCard ? 'true' : 'false',
            title: this.showExpandedCard ? 'Hide expanded details' : 'Show expanded details',
            onclick: () => { this.showExpandedCard = !this.showExpandedCard; this.render(); }
          }, this.showExpandedCard ? 'Hide details' : 'Show details')
        ),
        // A switch hitter is two profiles (one per side); let the coach flip between them.
        lineup.length > 1 ? createElement('div', { className: 'header__controls' },
          ...lineup.map((profile, idx) => createElement('span', {
            className: idx === this.cardIndex ? 'chip chip--active' : 'chip',
            title: `${profile.stats?.totalPitches || 0} pitches batting ${profile.handedness === 'LHB' ? 'left' : 'right'}-handed`,
            onclick: () => { if (idx !== this.cardIndex) { this.cardIndex = idx; this.resetBatterScopedSettings(); this.render(); } }
          }, `as ${profile.handedness}`))
        ) : null
      ),
      this.showInfoPanel ? renderInfoGuide(() => this.toggleInfo()) : null,
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

        if (compactMode) {
          const summary = createElement('div', { className: 'quick-summary' }, ...summaryItems);
          return createElement('div', { className: 'flashcard-body' }, pitchZoneEl, batterEl, summary);
        }

        const frag = document.createDocumentFragment();
        frag.appendChild(pitchZoneEl);
        frag.appendChild(batterEl);
        const arsenalEl = createArsenal(data);
        if (arsenalEl) frag.appendChild(arsenalEl);
        frag.appendChild(this._tendenciesEl);
        return frag;
      })()
    );
  },
});
