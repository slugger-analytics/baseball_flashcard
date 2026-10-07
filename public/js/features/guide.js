/**
 * features/guide.js — "Understanding the Widget", the 💡 explainer.
 */

'use strict';

/**
 * @param {Function} onClose - Called by the backdrop and the "Got it!" button.
 * @returns {HTMLElement}
 */
function renderInfoGuide(onClose) {
  return createElement('div', { className: 'info-overlay', onclick: () => onClose() },
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
              createElement('p', {}, createElement('strong', {}, 'Green:'), ' The sample-adjusted pitcher-win rate is above the expected rate for this batter and location by the selected Color Sensitivity margin — attack.'),
              createElement('p', {}, createElement('strong', {}, 'Red:'), ' The sample-adjusted pitcher-win rate is below that location-adjusted expectation by the selected margin — avoid.'),
              createElement('p', {}, createElement('strong', {}, 'Gray:'), ' Near the adjusted expectation, or too small a sample to clear the selected margin.'),
              createElement('p', {}, createElement('strong', {}, 'A ball counts against the pitcher. '), 'That matters most out of the zone, where two buckets can both show zero hits for completely different reasons — he chased and missed, or he simply took it. The first is a put-away pitch, the second is ball one. Scoring only hits could not tell them apart, and rated both "attack".'),
              createElement('p', {}, createElement('strong', {}, 'In-zone and out-of-zone are scored separately. '), 'About 84% of in-zone pitches go the pitcher\'s way against 27% out of it. Judged on one scale that 57-point gap would swamp everything, so a bucket is only ever compared against this batter\'s own rate in the same regime.'),
              createElement('p', {}, createElement('strong', {}, 'Small samples are pulled toward his average. '), 'A bucket of three pitches sits essentially on his baseline and stays gray no matter what happened in it; a bucket of a hundred speaks for itself. This is why a lone 2-for-3 no longer paints a zone red.'),
              createElement('p', {}, 'Buckets with fewer pitches than the ', createElement('strong', {}, 'Min Pitches per Bucket'), ' setting (under Advanced) are removed from the grid entirely — too small a sample to trust. Raise it for stricter evidence, lower it to see more pitches.'),
              createElement('p', {}, 'The Circles Shown slider reveals circles from the most extreme buckets (furthest above or below the batter\'s average) toward the average. Hover any circle for its bucket\'s breakdown: which specific pitch types made it up, counts split by outcome, the raw pitcher-win tally, the sample-adjusted rate the colour is read from, and this batter\'s baseline for that regime. Out-of-zone buckets are labelled "Chase" and tagged Out of zone, and are kept separate from the 9 in-zone boxes so in-zone samples stay clean. The settings panel filters by pitcher hand and pitch type — stats and colors recompute for the selected hand.'),
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
              createElement('p', {}, 'Each zone gets a relative vulnerability score based on whiff, weak-contact, and foul rates. Weak-contact data uses only balls in play with recorded exit speed; if a zone has no exit-speed readings, that component is omitted and the remaining weights are rescaled. The card shows swing and exit-speed sample counts.'),
              createElement('p', {}, 'The ', createElement('strong', {}, 'Vulnerable Zone Min Swings'), ' setting (Analysis Settings → Advanced) controls the minimum sample a zone needs before it can appear here.'),
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
              createElement('p', {}, 'A zone qualifies as a Hot Zone when its hard-hit rate among balls in play with recorded exit speed meets the selected threshold, with at least ', createElement('strong', {}, '2 hard hits'), ' (95+ mph). The card shows the tracked exit-speed sample.'),
              createElement('p', {}, 'These thresholds are adjustable in Analysis Settings → Advanced. Use Hot Zones as a map of where ', createElement('em', {}, 'not'), ' to miss — especially when ahead in the count.')
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
              createElement('p', {}, 'When enough of this batter’s outs finish on the same pitch with tracked coordinates, a location line appears under the breakdown — e.g. ', createElement('strong', {}, 'All 15 SL outs: 6 finished Low-Out, 4 off plate'), '. It pools every out that ENDED on that pitch type (not just the two-pitch sequence above, so the two denominators differ on purpose — the location line names its own pool up front) and needs at least 15 located finishes, 6 of them in one band, and that band holding 35% or more, with no tie at the top. A “band” merges a strike-zone box with the chase area just outside it, so a low-away strike and a buried slider count as the same spot. The trailing phrase says how those chased pitches missed: ', createElement('strong', {}, '“off plate”'), ' for a band on the inner or outer third, but ', createElement('strong', {}, '“above the zone”'), ' or ', createElement('strong', {}, '“below the zone”'), ' for a middle-column band — those pitches were over the plate and missed vertically, so the lever is elevating or burying it, not working him away. Either way, 4 of 6 means he is chasing it rather than being beaten in the zone. With 15+ finishes but no band that dominant it reads “no dominant spot”, which is itself useful — location is not the lever for this hitter. Below 15 located finishes nothing is shown, because at that size a location pattern is indistinguishable from random spread. Only the OUT pitch is located; the setup pitch is not.'),
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
        createElement('button', { className: 'info-modal__close-btn', onclick: () => onClose() }, 'Got it!')
      )
    )
  );
}
