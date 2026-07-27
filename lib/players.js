/**
 * lib/players.js — player-identity helpers.
 *
 * The league DB carries duplicate rows for a single person that differ only by
 * case (e.g. "Bates, Austin" Right + "bates, austin" Switch). Left unmerged, one
 * player fragments into two picker entries with split stats. These pure helpers
 * collapse case-variant rows into one canonical batter.
 */

'use strict';

function countUppercase(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch >= 'A' && ch <= 'Z') n++;
  }
  return n;
}

/**
 * Canonical key for a player name: trimmed + lowercased.
 */
function canonicalKey(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Builds a map from canonical key → best display name across duplicate spellings.
 * Best = the variant with the most uppercase letters (properly-cased beats
 * all-lowercase); ties keep the first one seen.
 * @param {Iterable<Object>} players - records with `player_name`.
 * @returns {Map<string,string>}
 */
function buildCanonicalNameMap(players) {
  const best = new Map(); // key -> { name, upper }
  for (const p of players) {
    const raw = ((p && p.player_name) || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const upper = countUppercase(raw);
    const cur = best.get(key);
    if (!cur || upper > cur.upper) best.set(key, { name: raw, upper });
  }
  const out = new Map();
  for (const [key, v] of best) out.set(key, v.name);
  return out;
}

/**
 * Merges two `bats` values, preferring 'Switch' over 'Left'/'Right', otherwise
 * the first non-null.
 */
function mergeBats(current, incoming) {
  if (incoming === 'Switch' || current === 'Switch') return 'Switch';
  return current || incoming || null;
}

/**
 * Dedupes hitter records by canonical (case-insensitive, trimmed) name, unioning
 * all player_ids and merging bats/team. The card endpoint already queries + merges
 * multiple ids, so unioning here never loses a batter whose pitches live under a
 * different id than its team-tagged record.
 * @param {Iterable<Object>} players - player records.
 * @returns {Array<{name:string, ids:string[], team:string, bats:string}>}
 */
function dedupeBatters(players) {
  const rows = [...players];
  const canon = buildCanonicalNameMap(rows);
  const byKey = new Map(); // key -> { ids:Set, team, bats }
  for (const p of rows) {
    if (!p || !p.is_hitter) continue;
    const name = (p.player_name || '').trim();
    if (!name || !/[A-Za-z]/.test(name)) continue; // drop empty / punctuation-only records
    const key = name.toLowerCase();
    let entry = byKey.get(key);
    if (!entry) { entry = { ids: new Set(), team: null, bats: null }; byKey.set(key, entry); }
    if (p.player_id) entry.ids.add(p.player_id);
    // team_name is unreliable/sparse in /players; take the first non-null we see.
    if (!entry.team && p.team_name) entry.team = p.team_name;
    entry.bats = mergeBats(entry.bats, p.player_batting_handedness || null);
  }
  const out = [];
  for (const [key, e] of byKey) {
    out.push({ name: canon.get(key) || key, ids: [...e.ids], team: e.team || '', bats: e.bats || '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

module.exports = { countUppercase, canonicalKey, buildCanonicalNameMap, mergeBats, dedupeBatters };
