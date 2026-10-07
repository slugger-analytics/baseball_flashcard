/**
 * core.js — shared client state and small helpers.
 *
 * Loaded first after pitch_logic.js. Everything here is a plain global, as in
 * the rest of the client (no build step).
 */

'use strict';

let TEAMS_DATA = {};
let METADATA = null;
// Distinct-batter index for the batter-first flow, from GET /api/batters (cheap,
// no pitch-space scan). Array of { name, ids:[...], team, bats }, sorted by name.
let BATTERS_INDEX = [];
// Current club rosters from iScore, joined to SLUGGER ids server-side (GET
// /api/rosters). Array of { guid, name, batters:[{name, ids, bats, number,
// position}] }. This is the reliable team source — SLUGGER's own team_name is
// missing for 132 of 564 batters and cannot express a mid-season trade. Empty
// when iScore is unreachable, in which case the picker falls back to the flat
// index and simply offers no team filter.
let ROSTERS = [];
// Default settings
const DEFAULT_SETTINGS = {
  // Zone analysis thresholds
  vulnerableZoneMinSwings: 3,
  vulnerableZoneThreshold: 60,
  hotZoneMinHardHits: 2,
  hotZoneHardHitThreshold: 40,
  // Pitch display settings
  maxPitchesDisplayed: 4,
  circleColorMode: 'both',     // 'both' | 'green' | 'red' — which rated circles to show
  pitcherHandFilter: 'All',   // 'All' | 'L' | 'R' — restrict circles to one pitcher hand
  hiddenPitchTypes: [],       // pitch abbreviations (e.g. 'SL') currently hidden from the grid
  bucketMinPitches: 3,        // (pitch family × zone) buckets under this size are dropped from the grid
  ratingSensitivity: 3,       // 1 (strict, most gray) .. 5 (loose, most colour)
  maxCirclesPerBucket: 1,     // circles kept per (pitch type × zone) bucket; 'All' = uncapped
  swingsOnly: false,          // restrict the population to swings (drop takes + other)
  pitchCircleSize: 38
};
let CURRENT_SETTINGS = { ...DEFAULT_SETTINGS };

/** Today's date as ISO YYYY-MM-DD (UTC, matching the server). */
function todayIso() {
  return new Date().toISOString().slice(0, 10);
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
    } else if (key === 'checked' || key === 'disabled') {
      el[key] = Boolean(value);
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
// BUCKET_RATING_EDGE, bucketKey, computeBucketRatings, getVisiblePitches and the
// strike zone geometry (STRIKE_ZONE, ZONE_PCT, plateToPercent, getZoneFromLocation)
// now live in pitch_logic.js (loaded before app.js) so they can be unit-tested
// under node:test and shared with the server. app.js calls them as globals.

/** Accent- and punctuation-insensitive form for search comparisons. */
function searchNorm(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Ranks batters against a search query, best first.
 *
 * SLUGGER stores names "Last, First", so a plain substring test — what the picker
 * used to do — fails on the way people actually type. "osvaldo abreu" matched
 * nothing at all; only "abreu" or "abreu, os" worked. Every batter is therefore
 * indexed under both orders, plus surname and forename alone, the club, and the
 * jersey number.
 *
 * Rank is by where the query lands, not merely whether it appears: a surname
 * starting with the query beats a mid-word hit somewhere else. Ties fall back to
 * alphabetical so ordering is stable as the user types.
 *
 * @param {Array<Object>} pool - Batter rows to search.
 * @param {string} query
 * @returns {Array<Object>} Matching rows, ranked.
 */
function matchBatters(pool, query) {
  const q = searchNorm(query);
  if (!q) return [...pool].sort((a, b) => a.name.localeCompare(b.name));

  const scored = [];
  for (const b of pool) {
    const full = searchNorm(b.name);                    // "abreu osvaldo"
    const comma = String(b.name).includes(',');
    const last = comma ? searchNorm(String(b.name).split(',')[0]) : full;
    const first = comma ? searchNorm(String(b.name).split(',').slice(1).join(' ')) : '';
    const reversed = first ? `${first} ${last}` : full; // "osvaldo abreu"
    const team = searchNorm(b.team);
    const number = String(b.number || '');

    let rank = -1;
    if (number && number === query.trim()) rank = 0;
    else if (last.startsWith(q)) rank = 1;
    else if (reversed.startsWith(q)) rank = 2;
    else if (first && first.startsWith(q)) rank = 3;
    // A query landing at the start of any word — catches "bonta" in "Del Bonta-Smith".
    else if (` ${reversed} `.includes(` ${q}`)) rank = 4;
    else if (reversed.includes(q) || full.includes(q)) rank = 5;
    else if (team.startsWith(q)) rank = 6;
    else if (team.includes(q)) rank = 7;

    if (rank >= 0) scored.push({ b, rank });
  }
  scored.sort((x, y) => x.rank - y.rank || x.b.name.localeCompare(y.b.name));
  return scored.map(s => s.b);
}

/**
 * Decodes the server's columnar pitchZones ("pz" columns + metadata.pzLegend)
 * back into the row objects the rest of the app consumes ({ position, pitch,
 * outcome, zone, pitcherThrows } per pitch). The server ships columns because a
 * full-season row-form response overflowed the ALB's 1 MB Lambda-response limit
 * (reaching users as a 502); decoding happens once here so nothing downstream
 * changes. Batters that already carry row-form pitchZones (older server during a
 * deploy) pass through untouched.
 * @param {Object} teamsData - Wire teamsData from GET /api/teams/range.
 * @param {Object|undefined} legend - metadata.pzLegend from the same response.
 * @returns {Object} The same teamsData object with pitchZones materialized.
 */
function decodePitchZones(teamsData, legend) {
  if (!legend) return teamsData;
  Object.values(teamsData).forEach(batters => {
    batters.forEach(batter => {
      if (!batter.pz) {
        if (!batter.pitchZones) batter.pitchZones = [];
        return;
      }
      const { x, y, t, o, z, h } = batter.pz;
      const pitchZones = new Array(x.length);
      for (let i = 0; i < x.length; i++) {
        pitchZones[i] = {
          position: [x[i] / 10, y[i] / 10],
          pitch: legend.t[t[i]],
          outcome: legend.o[o[i]],
          zone: legend.z[z[i]],
          pitcherThrows: legend.h[h[i]],
        };
      }
      batter.pitchZones = pitchZones;
      delete batter.pz;
    });
  });
  return teamsData;
}

// Creates an inline "Read more / Show less" toggle using direct DOM manipulation (no re-render)
function makeInfoExpand(...contentItems) {
  const expandDiv = createElement('div', { className: 'info-entry__expanded' }, ...contentItems);
  expandDiv.style.display = 'none';
  let btn;
  btn = createElement('button', {
    className: 'info-read-more-btn',
    onclick: () => {
      const open = expandDiv.style.display !== 'none';
      expandDiv.style.display = open ? 'none' : 'block';
      btn.textContent = open ? 'Read more ▼' : 'Show less ▲';
    }
  }, 'Read more ▼');
  return [expandDiv, btn];
}
