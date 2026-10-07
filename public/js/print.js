/**
 * print.js — Print card and the team print packet.
 */

'use strict';

Object.assign(FlashcardApp.prototype, {
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
  },

  getPrintContainer(id) {
    this.ensurePrintContainers();
    return document.getElementById(id);
  },

  buildPrintPage(batter, teamName, orderIndex, rangeLabel) {
    const metaBits = [];
    if (teamName) metaBits.push(teamName);
    if (typeof orderIndex === 'number') metaBits.push(`#${orderIndex + 1}`);
    if (batter.handedness) metaBits.push(batter.handedness);
    metaBits.push(`${batter.stats?.totalPitches || 0} pitches`);
    // Paper outlives the screen it came from: say which window the card covers.
    if (rangeLabel) metaBits.push(rangeLabel);
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
  },

  printCurrentCard() {
    const lineup = TEAMS_DATA[this.cardTeam];
    if (!lineup || lineup.length === 0) return;
    
    // CLEAR BOTH CONTAINERS TO PREVENT GHOST PRINTING
    const singleContainer = this.getPrintContainer('print-container');
    const lineupContainer = this.getPrintContainer('lineup-print-container');
    singleContainer.innerHTML = '';
    lineupContainer.innerHTML = '';

    const batter = lineup[this.cardIndex];
    const rangeLabel = METADATA ? formatRange({ start: METADATA.startDate, end: METADATA.endDate }) : '';
    singleContainer.appendChild(this.buildPrintPage(batter, this.cardTeam, null, rangeLabel));

    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 0.75);
    singleContainer.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`)
    });

    const savedScroll = window.scrollY;
    setTimeout(() => {
      window.print();
      setTimeout(() => window.scrollTo(0, savedScroll), 500); 
    }, 150); 
  },

  /**
   * Builds a printable packet for a whole roster, for the toolbar's date window.
   *
   * Fetches each hitter's card sequentially using exactly the same query shape as
   * selectBatter, so every request hits the same per-batter disk cache keys rather
   * than warming a second set. Renders each profile into the lineup print
   * container and shows a progress overlay with Print/Close when finished.
   *
   * The interactive card state (TEAMS_DATA, METADATA, cardTeam,
   * selectedBatterInfo) is deliberately never touched — a coach who was reading
   * one hitter's card gets it back unchanged after printing the packet.
   *
   * Sequential rather than parallel on purpose: a roster is ~15 batters and each
   * uncached fetch can page through thousands of pitches upstream, so firing them
   * at once risks the request budget and gives no progress to show.
   *
   * @param {string} label - Display name for the packet (the club, normally).
   * @param {Array<{name:string, ids:string[]}>} roster - Batters to include.
   */
  async printTeamPacket(label, roster) {
    if (this.bulkPrint && this.bulkPrint.active) return; // re-entry guard
    if (!roster || roster.length === 0) return;

    this.bulkPrint = {
      active: true, done: 0, total: roster.length, failures: [],
      aborted: false, label, phase: 'building', currentName: null, pages: 0,
    };
    this.renderBulkPrintOverlay();

    // Neutralise the batter-scoped filters so every card in the packet is
    // comparable; restored in the finally around the whole loop.
    const saved = CURRENT_SETTINGS;
    CURRENT_SETTINGS = bulkPrintSettings(saved);

    const singleContainer = this.getPrintContainer('print-container');
    const lineupContainer = this.getPrintContainer('lineup-print-container');
    singleContainer.innerHTML = '';
    lineupContainer.innerHTML = '';

    const range = this.currentRange();
    const rangeLabel = formatRange(range);
    let pageIndex = 0;
    try {
      for (const batter of roster) {
        if (this.bulkPrint.aborted) break;
        this.bulkPrint.currentName = batter.name;
        this.renderBulkPrintOverlay();
        try {
          const ids = encodeURIComponent((batter.ids || []).join(','));
          const response = await fetch(
            `./api/batter/card?batterIds=${ids}&startDate=${range.start}` +
            `&endDate=${range.end}&maxVelocity=105&pitchGroup=All`
          );
          const data = await response.json();
          if (!response.ok) {
            this.bulkPrint.failures.push({ name: batter.name, reason: data.error || `HTTP ${response.status}` });
          } else if (!data.teamsData || Object.keys(data.teamsData).length === 0) {
            // Expected for a recent signing SLUGGER has not ingested yet — skip,
            // record, and keep going rather than failing the whole packet.
            this.bulkPrint.failures.push({ name: batter.name, reason: 'no_data' });
          } else {
            decodePitchZones(data.teamsData, data.metadata && data.metadata.pzLegend);
            orderProfilesForPrint(data.teamsData).forEach(profile => {
              lineupContainer.appendChild(this.buildPrintPage(profile, label, pageIndex++, rangeLabel));
            });
          }
        } catch (err) {
          this.bulkPrint.failures.push({ name: batter.name, reason: (err && err.message) || 'error' });
        }
        this.bulkPrint.done++;
        this.renderBulkPrintOverlay();
      }
    } finally {
      CURRENT_SETTINGS = saved;
    }

    if (this.bulkPrint.aborted) {
      singleContainer.innerHTML = '';
      lineupContainer.innerHTML = '';
      this.dismissBulkPrint();
      return;
    }

    // Scale circles down for print, as printCurrentCard does.
    const printSize = Math.round(CURRENT_SETTINGS.pitchCircleSize * 0.75);
    lineupContainer.querySelectorAll('.pitch-zone').forEach(el => {
      el.style.setProperty('--pitch-circle-size', `${printSize}px`);
    });

    this.bulkPrint.phase = 'done';
    this.bulkPrint.pages = pageIndex;
    this.renderBulkPrintOverlay();
  },

  /**
   * (Re)draws the bulk-print overlay from this.bulkPrint.
   *
   * Mounted on document.body rather than inside #app so it survives the app's
   * re-renders, and hidden from the printout by a @media print rule.
   */
  renderBulkPrintOverlay() {
    const existing = document.getElementById('bulk-print-overlay');
    if (existing) existing.remove();
    const bp = this.bulkPrint;
    if (!bp || !bp.active) return;

    const skipped = bp.failures.length
      ? `Skipped ${bp.failures.length}: ${bp.failures.map(f => f.name).join(', ')}`
      : null;

    let card;
    if (bp.phase === 'done' && bp.pages === 0) {
      card = createElement('div', { className: 'bulk-print-card' },
        createElement('div', { className: 'bulk-print-title' }, 'No cards to print'),
        createElement('div', { className: 'bulk-print-sub' },
          skipped || 'No hitters on this roster returned pitch data.'),
        createElement('div', { className: 'bulk-print-actions' },
          createElement('button', { className: 'team-btn', onclick: () => this.dismissBulkPrint() }, 'Close')
        )
      );
    } else if (bp.phase === 'done') {
      card = createElement('div', { className: 'bulk-print-card' },
        createElement('div', { className: 'bulk-print-title' },
          `${bp.pages} page${bp.pages === 1 ? '' : 's'} ready`),
        createElement('div', { className: 'bulk-print-sub' }, `${bp.label} · ${formatRange(this.currentRange())}`),
        skipped ? createElement('div', { className: 'bulk-print-sub' }, skipped) : null,
        createElement('div', { className: 'bulk-print-actions' },
          createElement('button', { className: 'team-btn', onclick: () => this.printBulkPacket() }, 'Print'),
          createElement('button', { className: 'team-btn team-btn--ghost', onclick: () => this.dismissBulkPrint() }, 'Close')
        )
      );
    } else {
      const current = Math.min(bp.done + 1, bp.total);
      const pct = bp.total ? Math.round((bp.done / bp.total) * 100) : 0;
      card = createElement('div', { className: 'bulk-print-card' },
        createElement('div', { className: 'bulk-print-title' }, `Building packet: ${current} of ${bp.total}`),
        createElement('div', { className: 'bulk-print-sub' }, bp.currentName || '…'),
        createElement('div', { className: 'bulk-print-bar' },
          createElement('div', { className: 'bulk-print-bar__fill', style: { width: `${pct}%` } })
        ),
        createElement('div', { className: 'bulk-print-actions' },
          createElement('button', {
            className: 'team-btn team-btn--ghost',
            onclick: () => { if (this.bulkPrint) this.bulkPrint.aborted = true; }
          }, 'Cancel')
        )
      );
    }
    document.body.appendChild(
      createElement('div', { id: 'bulk-print-overlay', className: 'bulk-print-overlay' }, card));
  },

  /** Opens the print dialog for the assembled packet, then tidies up. */
  printBulkPacket() {
    const overlay = document.getElementById('bulk-print-overlay');
    if (overlay) overlay.style.display = 'none'; // belt-and-braces; CSS also hides it
    const savedScroll = window.scrollY;
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        window.scrollTo(0, savedScroll);
        this.dismissBulkPrint();
      }, 500);
    }, 150);
  },

  /** Clears the overlay and print containers, ending the bulk-print session. */
  dismissBulkPrint() {
    const overlay = document.getElementById('bulk-print-overlay');
    if (overlay) overlay.remove();
    try {
      this.getPrintContainer('print-container').innerHTML = '';
      this.getPrintContainer('lineup-print-container').innerHTML = '';
    } catch (_) { /* containers may not exist yet */ }
    this.bulkPrint = null;
  },
});
