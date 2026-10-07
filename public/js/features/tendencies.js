/**
 * features/tendencies.js — the scouting boxes beside the zone: first-pitch
 * approach, vulnerable and hot zones, out pitch / sequence, threats.
 */

'use strict';

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
    const minSwings = CURRENT_SETTINGS.vulnerableZoneMinSwings;

    Object.entries(zoneAnalysis).forEach(([zone, stats]) => {

      if (!meetsZoneSwingMinimum(stats, minSwings)) return;
      // No swings in the zone → whiff/chase rates are undefined (0/0 = NaN)
      if ((stats.swings || 0) === 0) return;

      const whiff_percent = (stats.whiffs / stats.swings) * 100;
      const foul_percent = (stats.fouls / stats.swings) * 100;
      const contactRates = zoneContactRates(stats);
      const weakContact_percent = contactRates.weakContactPercent;
      const hardHit_percent = contactRates.hardHitPercent;

      zoneScores[zone] = { whiff_percent, foul_percent, weakContact_percent, hardHit_percent, stats, contactRates };
    });

    const zones = Object.keys(zoneScores);

    if (zones.length > 0) {
      const getRank = (metric) => {
        const values = {};
        zones.forEach(zone => { values[zone] = zoneScores[zone][metric]; });
        return rankZoneValues(values);
      };
    

      const whiffRanks = getRank('whiff_percent');
      const foulRanks = getRank('foul_percent');
      const weakContactRanks = getRank('weakContact_percent');

      zones.forEach(zone => {
        const factors = [
          { rank: whiffRanks[zone], weight: 0.45 },
          { rank: weakContactRanks[zone], weight: 0.35 },
          { rank: foulRanks[zone], weight: 0.20 },
        ].filter(factor => factor.rank !== undefined);
        const totalWeight = factors.reduce((total, factor) => total + factor.weight, 0);
        const vulnerabilityScore = factors.reduce(
          (total, factor) => total + factor.rank * factor.weight, 0
        ) / totalWeight;

        let severity = null;

        if (vulnerabilityScore <= 20) severity = 'CRITICAL';
        else if (vulnerabilityScore <= 35) severity = 'MAJOR';
        else if (vulnerabilityScore <= 60) severity = 'MODERATE';

        if (severity) {
          vulnerableZones.push({
            zone,
            score: vulnerabilityScore.toFixed(0),
            severity,
            swings: zoneScores[zone].stats.swings,
            exitSpeedCount: zoneScores[zone].contactRates.exitSpeedCount,
          });
        }

        // hot zone check
        if (meetsHotZoneThreshold(
          zoneScores[zone].hardHit_percent,
          zoneScores[zone].stats.hardHits,
          CURRENT_SETTINGS.hotZoneHardHitThreshold,
          CURRENT_SETTINGS.hotZoneMinHardHits
        )) {
          hotZones.push({
            zone,
            hardHitPct: zoneScores[zone].hardHit_percent.toFixed(0),
            exitSpeedCount: zoneScores[zone].contactRates.exitSpeedCount,
          });
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

  // The server tags a zone with the pitch family driving it (vg/hg) only when ONE
  // family clearly does — see annotateZoneGroups. "Low-Out is a weak spot" is
  // useful; "Low-Out is a weak spot against breaking balls" is a pitch call.
  const familyNote = (zone, key, verb) => {
    const ann = zoneAnalysis && zoneAnalysis[zone];
    if (!ann || !ann[key]) return '';
    const label = FAMILY_LABEL[ann[key]] || ann[key];
    return ` — ${verb} ${label} (n=${ann[`${key}N`]})`;
  };
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
        cappedVulnerableZones.slice(0, 2)
          .map(z => `${z.zone} (${z.score}; ${z.swings} swings, ${z.exitSpeedCount} EV)`
            + familyNote(z.zone, 'vg', 'vs')).join(', ')),
    ) : null,
    hotZones.length > 0 ? createElement('div', { className: 'power-sequence hot-zone' },
      createElement('h4', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' } },
        'Hot Zones (Avoid)',
        createElement('button', { className: 'section-info-btn', onclick: (e) => { e.stopPropagation(); openInfoModal('hot'); } }, 'ℹ')
      ),
      createElement('div', { className: 'power-sequence-text' },
        hotZones.slice(0, 2).map(z => `${z.zone} (${z.hardHitPct}% of ${z.exitSpeedCount} tracked)`
          + familyNote(z.zone, 'hg', 'feeds')).join(', ') || 'None identified'),
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
            // How the chase pitches missed depends on the band: a 'Mid' column means
            // they were over the plate and missed high or low, NOT off the plate.
            const miss = bandMissDescription(loc.band);
            // Lead with the pool. This line's denominator is every out finishing on
            // that pitch type, which is a different (and often larger) number than
            // the sequence count in the row above — naming it up front stops the two
            // from reading as one broken fraction.
            return createElement('div', {
              className: 'out-location',
              style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px', textAlign: 'center' },
              title: loc.dominant
                ? `${loc.count} of ${loc.total} located ${loc.pitch} out-pitch finishes were in the ${loc.band} band — ${loc.chase} ${miss}, ${loc.count - loc.chase} in the zone. Bands merge a strike-zone box with the chase area just outside it.`
                : `${loc.total} located ${loc.pitch} out-pitch finishes, spread out — the most common band was ${loc.band} with ${loc.count}, not clear enough of the rest to call it a pattern.`
            }, loc.dominant
              ? `All ${loc.total} ${loc.pitch} outs: ${loc.count} finished ${loc.band}${loc.chase ? `, ${loc.chase} ${miss}` : ''}`
              : `All ${loc.total} ${loc.pitch} outs: no dominant spot`);
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
