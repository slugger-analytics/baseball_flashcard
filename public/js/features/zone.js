/**
 * features/zone.js — the strike zone graphic: zone grid, rated pitch circles
 * with their hover breakdown, and the batter silhouette.
 */

'use strict';

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
  // under the widget base path on Lambda (/widgets/flashcard/) as well as at a
  // domain root. Absolute '/rhb.svg' 404'd on the Lambda host.
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
