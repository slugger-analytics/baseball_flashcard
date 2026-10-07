/**
 * toolbar.js — Team → Hitter → Dates → Print, always on screen above the card.
 */

'use strict';

Object.assign(FlashcardApp.prototype, {
  /**
   * Redraws the toolbar. Deferred while someone is typing in the Hitter box —
   * replacing it would drop their focus and half-typed name — and caught up on
   * blur.
   */
  renderToolbar() {
    const active = document.activeElement;
    if (active && active.id === 'batterSearch' && this.toolbarEl.contains(active)) {
      this.toolbarDirty = true;
      return;
    }
    this.toolbarDirty = false;
    this.toolbarEl.replaceChildren(this.buildToolbar());
    this.syncToolbarHeight();
  },

  /** Publishes the toolbar's height so the sticky settings sidebar clears it. */
  syncToolbarHeight() {
    const sticky = getComputedStyle(this.toolbarEl).position === 'sticky';
    document.documentElement.style.setProperty('--toolbar-h', `${sticky ? this.toolbarEl.offsetHeight : 0}px`);
  },

  buildToolbar() {
    const field = (label, ...children) => createElement('div', { className: 'toolbar__field' },
      createElement('label', { className: 'toolbar__label' }, label), ...children);

    // Team
    let teamControl;
    if (ROSTERS.length) {
      const total = ROSTERS.reduce((n, t) => n + t.batters.length, 0);
      const options = [
        { value: '', label: `All teams (${total})` },
        ...ROSTERS.map(t => ({ value: t.guid, label: `${t.name} (${t.batters.length})` })),
        { value: 'ALL', label: `Everyone in SLUGGER (${BATTERS_INDEX.length})` },
      ];
      teamControl = createElement('select', {
        className: 'toolbar__select', id: 'teamSelect',
        onchange: (e) => this.setTeamScope(e.target.value)
      }, ...options.map(o => createElement('option', { value: o.value, ...(o.value === this.teamScope ? { selected: true } : {}) }, o.label)));
    } else {
      const note = this.rostersState === 'failed' ? 'Rosters unavailable' : 'Loading teams…';
      teamControl = createElement('select', { className: 'toolbar__select', disabled: true },
        createElement('option', {}, note));
    }

    // Dates
    const range = this.currentRange();
    const season = seasonRange(todayIso());
    const presetLabels = {
      season: season.end === todayIso() ? `${season.year} season to date` : `${season.year} season`,
      30: 'Last 30 days', 14: 'Last 14 days', custom: 'Custom…'
    };
    const dateSelect = createElement('select', {
      className: 'toolbar__select', id: 'rangeSelect',
      onchange: (e) => this.setRangePreset(e.target.value)
    }, ...RANGE_PRESETS.map(p => createElement('option', { value: p, ...(p === this.rangePreset ? { selected: true } : {}) }, presetLabels[p])));
    let customRow = null;
    if (this.rangePreset === 'custom') {
      const startEl = createElement('input', { type: 'date', className: 'toolbar__date', value: this.customRange.start || range.start, max: todayIso(), 'aria-label': 'Start date' });
      const endEl = createElement('input', { type: 'date', className: 'toolbar__date', value: this.customRange.end || range.end, max: todayIso(), 'aria-label': 'End date' });
      customRow = createElement('div', { className: 'toolbar__custom' },
        startEl, createElement('span', { className: 'toolbar__dash' }, '–'), endEl,
        createElement('button', { className: 'toolbar__btn', onclick: () => this.applyCustomRange(startEl.value, endEl.value) }, 'Apply'));
    }
    const dateHint = createElement('div', { className: this.rangeError ? 'toolbar__hint toolbar__hint--error' : 'toolbar__hint' },
      this.rangeError || formatRange(range));

    // Print
    const team = this.scopedTeam();
    const printCard = createElement('button', {
      className: 'toolbar__btn', disabled: this.status !== 'card',
      title: this.status === 'card' ? 'Print this card' : 'Pick a hitter first',
      onclick: () => this.printCurrentCard()
    }, 'Print card');
    const printTeam = team ? createElement('button', {
      className: 'toolbar__btn toolbar__btn--ghost', id: 'packet-print-btn',
      title: `One page per hitter on the ${team.name} active roster, for ${formatRange(range)}`,
      onclick: () => this.printTeamPacket(team.name, team.batters)
    }, `Print team (${team.batters.length})`) : null;
    const cardDetails = this.status === 'card' ? createElement('button', {
      type: 'button',
      className: 'toolbar__btn toolbar__btn--ghost',
      'aria-pressed': this.showExpandedCard ? 'true' : 'false',
      onclick: () => { this.showExpandedCard = !this.showExpandedCard; this.render(); }
    }, this.showExpandedCard ? 'Hide details' : 'More details') : null;

    return createElement('div', { className: 'toolbar' },
      field('Team', teamControl),
      field('Hitter', this.buildHitterBox()),
      field('Dates', dateSelect, customRow, dateHint),
      createElement('div', { className: 'toolbar__actions' }, cardDetails, printCard, printTeam)
    );
  },

  /**
   * The Hitter box: a search combobox over the current team scope, flanked by
   * previous/next buttons. Typing filters the list in place rather than
   * re-rendering, so the box keeps focus.
   */
  buildHitterBox() {
    let pool = this.hitterPool();
    const selected = this.selectedBatterInfo;
    let activeOptions = [];
    let activeIndex = -1;
    let menuOpen = false;
    let searchEl;
    let menuEl;

    const choose = (batter) => {
      // Blur first: renderToolbar defers while the box has focus.
      searchEl.blur();
      this.selectBatter(batter);
    };

    const renderOptions = (open = menuOpen) => {
      menuOpen = open;
      menuEl.replaceChildren();
      searchEl.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
      if (!menuOpen) {
        menuEl.hidden = true;
        searchEl.removeAttribute('aria-activedescendant');
        return;
      }
      menuEl.hidden = false;
      const all = matchBatters(pool, this.batterQuery);
      activeOptions = all.slice(0, 15);
      activeIndex = Math.min(activeIndex, activeOptions.length - 1);
      const team = this.scopedTeam();
      menuEl.appendChild(createElement('div', { className: 'hitter-menu__heading' },
        `${team ? team.name : this.teamScope === 'ALL' ? 'Everyone in SLUGGER' : 'All teams'} · ${all.length} hitter${all.length === 1 ? '' : 's'}`
        + (all.length > activeOptions.length ? ' (top 15 — keep typing)' : '')));
      activeOptions.forEach((batter, index) => {
        const detail = [team ? '' : batter.team, batter.number ? `#${batter.number}` : ''].filter(Boolean).join(' · ');
        menuEl.appendChild(createElement('button', {
          type: 'button', role: 'option', id: `batter-option-${index}`,
          className: index === activeIndex ? 'hitter-menu__option hitter-menu__option--active' : 'hitter-menu__option',
          'aria-selected': index === activeIndex ? 'true' : 'false',
          onmousedown: (event) => event.preventDefault(),
          onclick: () => choose(batter)
        },
          createElement('span', { className: 'hitter-menu__name' }, batter.name),
          detail ? createElement('span', { className: 'hitter-menu__detail' }, detail) : null
        ));
      });
      if (!activeOptions.length) {
        menuEl.appendChild(createElement('div', { className: 'hitter-menu__empty' }, 'No matching hitters.'));
      }
      if (activeIndex >= 0) searchEl.setAttribute('aria-activedescendant', `batter-option-${activeIndex}`);
    };

    searchEl = createElement('input', {
      id: 'batterSearch', type: 'search', role: 'combobox', className: 'toolbar__search',
      'aria-autocomplete': 'list', 'aria-controls': 'batter-suggestions', 'aria-expanded': 'false',
      autocomplete: 'off',
      // Shows the chosen hitter at rest; focusing selects it so typing replaces it.
      value: this.batterQuery || (selected ? selected.name : ''),
      placeholder: 'Search hitters…',
      oninput: (event) => {
        this.batterQuery = event.target.value;
        activeIndex = -1;
        renderOptions(true);
      },
      onfocus: () => {
        searchEl.select();
        pool = this.hitterPool();
        renderOptions(true);
      },
      onblur: () => setTimeout(() => {
        if (document.activeElement === searchEl) return;
        this.batterQuery = '';
        menuOpen = false;
        menuEl.hidden = true;
        searchEl.value = this.selectedBatterInfo ? this.selectedBatterInfo.name : '';
        searchEl.setAttribute('aria-expanded', 'false');
        if (this.toolbarDirty) this.renderToolbar();
      }, 100),
      onkeydown: (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          activeIndex = activeOptions.length ? (activeIndex + direction + activeOptions.length) % activeOptions.length : -1;
          renderOptions(true);
        } else if (event.key === 'Enter' && menuOpen) {
          event.preventDefault();
          const pick = activeIndex >= 0 ? activeOptions[activeIndex] : activeOptions[0];
          if (pick) choose(pick);
        } else if (event.key === 'Escape') {
          renderOptions(false);
          searchEl.blur();
        }
      }
    });
    menuEl = createElement('div', { id: 'batter-suggestions', role: 'listbox', hidden: true, className: 'hitter-menu' });

    const step = (delta, label, glyph) => createElement('button', {
      className: 'toolbar__step', title: `${label} hitter${this.scopedTeam() ? ` on ${this.scopedTeam().name}` : ''} (${glyph === '‹' ? '←' : '→'} key)`,
      'aria-label': `${label} hitter`, disabled: !selected,
      onclick: () => this.gotoAdjacentBatter(delta)
    }, glyph);

    return createElement('div', { className: 'toolbar__hitter' },
      step(-1, 'Previous', '‹'),
      createElement('div', { className: 'toolbar__combo' }, searchEl, menuEl),
      step(1, 'Next', '›')
    );
  },
});
