/**
 * settings.js — the Analysis Settings panel (docked sidebar or modal).
 */

'use strict';

Object.assign(FlashcardApp.prototype, {
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
          // What is on the grid right now
          createElement('div', { className: 'settings-card full-width' },
            createElement('div', { className: 'settings-card__header' }, 'On the Grid'),
            createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', marginBottom: '12px' } },
              ...[
                { label: 'Total Pitches',                   value: rawCount, bg: '#f1f5f9', border: '#cbd5e1', textColor: '#1e293b' },
                { label: 'Matching Filters',                 value: displayedCount,    bg: '#eff6ff', border: '#93c5fd', textColor: '#1d4ed8', tooltip: 'Pitches currently shown on the grid (limited by Circles Shown).' },
                { label: 'Green Zone',  value: displayedGoodCount, bg: '#f0fdf4', border: '#86efac', textColor: '#15803d', tooltip: 'Displayed pitches where the pitcher wins meaningfully more often than his average against this batter.' },
                { label: 'Red Zone',   value: displayedBadCount,  bg: '#fef2f2', border: '#fca5a5', textColor: '#b91c1c', tooltip: 'Displayed pitches from buckets where the shrunk pitcher-win rate is meaningfully below expectation for this batter and location.' },
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
              ' = meaningfully below the adjusted expectation (avoid), gray = near expectation or under the minimum sample.'
            )
          ),

          // Filters change which pitches the card is built from
          createElement('div', { className: 'settings-card full-width' },
            createElement('div', { className: 'settings-card__header' }, 'Filters'),
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
            // Pitch group: a server-side filter, so the whole card (tendencies, out
            // pitch, zones) is rebuilt from that family's pitches only. Reloads.
            createElement('div', { className: 'setting-item' },
              createElement('label', { className: 'setting-label' }, 'Pitch Group'),
              createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
                ...[
                  { value: 'All', label: 'All', title: 'Every pitch' },
                  { value: 'Fastballs', label: 'FB', title: 'Four-seam, sinker, cutter' },
                  { value: 'Breaking', label: 'BB', title: 'Slider, curveball' },
                  { value: 'Offspeed', label: 'OS', title: 'Changeup, splitter' },
                ].map(opt => {
                  const isActive = (this.lastPitchGroup || 'All') === opt.value;
                  return createElement('button', {
                    title: opt.title,
                    style: {
                      padding: '6px 12px', borderRadius: '8px', fontWeight: '700', fontSize: '12px',
                      cursor: 'pointer', transition: 'all 0.15s ease',
                      border: `2px solid ${isActive ? '#3b82f6' : '#e2e8f0'}`,
                      background: isActive ? '#3b82f6' : '#f8fafc',
                      color: isActive ? 'white' : '#64748b'
                    },
                    onclick: () => {
                      if (isActive) return;
                      this.lastPitchGroup = opt.value;
                      this.loadBatterCard();
                    }
                  }, opt.label);
                })
              )
            ),
            // Pitch-type filter: hide pitch types the pitcher doesn't throw
            (() => {
              const batterForTypes = (TEAMS_DATA[this.cardTeam] || [])[this.cardIndex];
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
                      this.lastMaxVelocity = parseInt(e.target.value, 10);
                      this.loadBatterCard();
                    }
                  }),
                  createElement('span', {
                    className: 'max-velo-value setting-number-input',
                    style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }
                  }, fmt(cur))
                )
              );
            })()
          ),

          // Display changes how much of it is drawn
          createElement('div', { className: 'settings-card full-width' },
            createElement('div', { className: 'settings-card__header' }, 'Display'),
            createSlider('Circles Shown', 'maxPitchesDisplayed', 0, sliderMax, 1, effectiveMaxPitches),
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
            })()
          ),

          // Tuning most coaches never need. Collapsed by default; remembers being
          // opened across the re-render every setting change triggers.
          createElement('details', {
            className: 'settings-card full-width settings-advanced',
            ...(this.advancedOpen ? { open: '' } : {}),
            ontoggle: (e) => { this.advancedOpen = e.target.open; }
          },
            createElement('summary', { className: 'settings-card__header' }, 'Advanced'),
            createSlider('Pitch Circle Size (px)', 'pitchCircleSize', 28, 56, 1),
            // Buckets = pitch type × zone; buckets under this size are dropped
            createSlider('Min Pitches per Bucket', 'bucketMinPitches', 1, 20, 1),
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
            createCheckbox('Swings Only', 'swingsOnly'),
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
  },
});
