/**
 * iscore.js — iScore roster fetch and iScore→SLUGGER hitter name matching.
 *
 * iScore exposes a public, unauthenticated REST API carrying each ALPB club's
 * roster. SLUGGER's own `/players` team_name field is sparse (132 of 564 batters
 * have none) and static — it can't express a mid-season trade, which is why
 * Osvaldo Abreu shows up under two teams in the pitch data. iScore is the better
 * roster source: it is current, it is complete, and it carries jersey numbers and
 * batting handedness.
 *
 * The catch is that iScore shares no ID with SLUGGER, so the two have to be
 * joined on name alone. Names collide badly league-wide — 28.7% of batters share
 * a surname with someone else (7 Martins, 7 Williamses) — but scoping the join to
 * one club's roster collapses that: a team carries only ~16 active non-pitchers.
 *
 * The matching rules below are ported from the sibling ALPB_Pitching_Widget,
 * which solved the same join for pitchers. Its accumulated knowledge of what
 * actually fails is preserved in FIRST_NAME_CORRECTIONS and the nickname pass:
 * iScore misspells "Francisco" as "Fransisco" and "Isaac" as "Issac", writes
 * "J.C." where SLUGGER writes "JC", and says "Thomas Kane" where SLUGGER says
 * "Tommy Kane".
 *
 * One deliberate divergence from that widget: it queries SLUGGER's /players
 * endpoint once per name variant and, failing that, accepts any lone result.
 * This module matches against an in-memory index instead, so it sees every
 * candidate at once — which lets it report a confidence and refuse an ambiguous
 * match rather than guessing. A wrong scouting card is worse than no card.
 */

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// iScore spellings known to differ from SLUGGER, keyed by lowercase iScore form.
const FIRST_NAME_CORRECTIONS = {
  fransisco: 'francisco',
  issac: 'isaac',
};

// Common short forms. Checked both directions, so one entry covers "Tommy"→
// "Thomas" and "Thomas"→"Tommy".
const NICKNAMES = [
  ['thomas', 'tommy'], ['thomas', 'tom'], ['benjamin', 'ben'], ['joseph', 'joe'],
  ['joshua', 'josh'], ['jackson', 'jack'], ['michael', 'mike'], ['matthew', 'matt'],
  ['christopher', 'chris'], ['nicholas', 'nick'], ['daniel', 'danny'], ['daniel', 'dan'],
  ['william', 'will'], ['william', 'billy'], ['robert', 'rob'], ['robert', 'bobby'],
  ['richard', 'rick'], ['james', 'jimmy'], ['james', 'jim'], ['anthony', 'tony'],
  ['alexander', 'alex'], ['zachary', 'zach'], ['andrew', 'andy'], ['andrew', 'drew'],
  ['samuel', 'sam'], ['jonathan', 'jon'], ['david', 'dave'], ['edward', 'eddy'],
  ['edward', 'eddie'], ['steven', 'steve'], ['stephen', 'steve'], ['patrick', 'pat'],
  ['gregory', 'greg'], ['timothy', 'tim'], ['charles', 'charlie'], ['kenneth', 'ken'],
  ['raymond', 'ray'], ['ronald', 'ron'], ['francisco', 'frank'], ['rafael', 'rafa'],
];

// positionGroup.name values that mean "pitcher" — excluded from the hitter index.
const PITCHER_POSITIONS = new Set([
  'p', 'sp', 'rp', 'cp', 'cl', 'pitcher', 'pitchers',
  'starting pitcher', 'relief pitcher', 'closer',
]);

/** Strips accents so "Peña" and "Pena" compare equal. */
function asciiFold(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, punctuation-insensitive form used for every comparison. */
function normalizeName(value) {
  return asciiFold(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Drops trailing Jr/Sr/III tokens from an already-normalized name. */
function stripSuffix(normalized) {
  const tokens = String(normalized || '').split(' ').filter(Boolean);
  while (tokens.length && NAME_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/** Applies a known iScore misspelling fix, on a normalized first name. */
function correctFirst(normalizedFirst) {
  return FIRST_NAME_CORRECTIONS[normalizedFirst] || normalizedFirst;
}

/** True when two normalized first names are a known long/short pair. */
function isNicknamePair(a, b) {
  if (!a || !b) return false;
  return NICKNAMES.some(([long, short]) =>
    (a === long && b === short) || (a === short && b === long));
}

/**
 * Splits an iScore "First Last" string. Splits on the FIRST space only, so
 * compound surnames survive intact: "Fin Del Bonta-Smith" → Fin / Del Bonta-Smith.
 */
function splitIscoreName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: '', last: '' };
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Splits a SLUGGER "Last, First" string. Falls back to treating a space-separated
 * name as "First Last" when no comma is present.
 */
function splitSluggerName(playerName) {
  const raw = String(playerName || '').trim();
  if (raw.includes(',')) {
    const [last, first] = raw.split(',', 2);
    return { first: (first || '').trim(), last: (last || '').trim() };
  }
  return splitIscoreName(raw);
}

/** Levenshtein distance, bailing out early past `max`. */
function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** True for names short enough to be initials ("jp", "j c"). */
function looksLikeInitials(normalized) {
  return normalized.replace(/ /g, '').length <= 4;
}

/**
 * Builds the searchable index of SLUGGER hitters that matchHitter() scores against.
 * Records for the same normalized person are merged, so a player split across
 * duplicate rows ("Blackwell, Ben" and "Blackwell, Benjamin") presents one target.
 *
 * @param {Iterable<Object>} players - Raw SLUGGER /players records.
 * @returns {Array<Object>} Index entries: { name, first, last, ids, bats }.
 */
function buildHitterIndex(players) {
  const byKey = new Map();
  for (const p of players) {
    if (!p || !p.is_hitter) continue;
    const raw = String(p.player_name || '').trim();
    if (!raw || !/[A-Za-z]/.test(raw)) continue;
    const { first, last } = splitSluggerName(raw);
    const firstNorm = normalizeName(first);
    const lastNorm = stripSuffix(normalizeName(last));
    if (!lastNorm) continue;
    const key = `${lastNorm}|${firstNorm}`;
    let e = byKey.get(key);
    if (!e) {
      e = { name: raw, first: firstNorm, last: lastNorm, ids: [], bats: null };
      byKey.set(key, e);
    }
    if (p.player_id && !e.ids.includes(p.player_id)) e.ids.push(p.player_id);
    if (!e.bats && p.player_batting_handedness) e.bats = p.player_batting_handedness;
  }
  return [...byKey.values()];
}

// Confidence tiers, strongest first. 'exact' and 'high' are safe to auto-apply;
// 'medium' and 'low' warrant confirmation before a card is trusted.
const CONFIDENCE_ORDER = ['exact', 'high', 'medium', 'low'];

/** First letter of a normalized name, ignoring spaces. */
function initial(normalized) {
  const squashed = String(normalized || '').replace(/ /g, '');
  return squashed ? squashed[0] : '';
}

/**
 * Scores one index entry against a target first/last pair.
 * @returns {?{confidence: string, reason: string}} null when nothing matches.
 */
function scoreCandidate(entry, targetFirst, targetLast) {
  if (entry.last !== targetLast) {
    // Surname must at least be close; a one-character typo is tolerated but only
    // ever yields a low-confidence result.
    if (editDistance(entry.last, targetLast, 1) > 1) return null;
    if (initial(entry.first) !== initial(targetFirst)) return null;
    return { confidence: 'low', reason: 'surname within one edit, first initial agrees' };
  }
  if (entry.first === targetFirst) return { confidence: 'exact', reason: 'first and last match' };
  if (correctFirst(entry.first) === correctFirst(targetFirst)) {
    return { confidence: 'high', reason: 'known iScore spelling correction' };
  }
  if (isNicknamePair(entry.first, targetFirst)) {
    return { confidence: 'high', reason: 'known nickname pair' };
  }
  if (targetFirst && entry.first &&
      (entry.first.startsWith(targetFirst) || targetFirst.startsWith(entry.first))) {
    return { confidence: 'high', reason: 'first name is a prefix of the other' };
  }
  if (initial(entry.first) === initial(targetFirst) &&
      looksLikeInitials(entry.first) && looksLikeInitials(targetFirst)) {
    return { confidence: 'medium', reason: 'both first names are initials sharing a letter' };
  }
  if (initial(entry.first) === initial(targetFirst)) {
    return { confidence: 'medium', reason: 'surname matches, first initial agrees' };
  }
  return null;
}

/** Normalizes a handedness value to 'L' | 'R' | 'S' | null. */
function batsCode(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('l')) return 'L';
  if (v.startsWith('r')) return 'R';
  if (v.startsWith('s') || v.startsWith('b')) return 'S';
  return null;
}

/**
 * Matches one iScore roster player to a SLUGGER hitter.
 *
 * Returns the best candidate with a confidence, plus any runners-up so the caller
 * can present a choice instead of a guess. Two candidates tied at the same
 * confidence is reported as ambiguous with no match — refusing is the right
 * outcome, because handing a coach the wrong batter's card is worse than handing
 * him none.
 *
 * @param {Object} iscorePlayer - { name, bats } from an iScore roster.
 * @param {Array<Object>} index - Output of buildHitterIndex().
 * @returns {{match: ?Object, confidence: ?string, reason: string, candidates: Array<Object>}}
 */
function matchHitter(iscorePlayer, index) {
  const { first, last } = splitIscoreName(iscorePlayer && iscorePlayer.name);
  const targetFirst = normalizeName(first);
  const targetLast = stripSuffix(normalizeName(last));
  const targetBats = batsCode(iscorePlayer && iscorePlayer.bats);
  if (!targetLast) return { match: null, confidence: null, reason: 'no surname', candidates: [] };

  const scored = [];
  for (const entry of index) {
    const s = scoreCandidate(entry, targetFirst, targetLast);
    if (!s) continue;
    // Batting hand is an independent signal. When both sides state it and they
    // disagree, the name match is probably a coincidence — demote a tier.
    let confidence = s.confidence;
    let reason = s.reason;
    const entryBats = batsCode(entry.bats);
    if (targetBats && entryBats && targetBats !== entryBats && confidence !== 'exact') {
      const i = CONFIDENCE_ORDER.indexOf(confidence);
      confidence = CONFIDENCE_ORDER[Math.min(i + 1, CONFIDENCE_ORDER.length - 1)];
      reason += '; batting hand disagrees';
    }
    scored.push({ entry, confidence, reason });
  }
  if (scored.length === 0) {
    return { match: null, confidence: null, reason: 'no candidate', candidates: [] };
  }

  scored.sort((a, b) => CONFIDENCE_ORDER.indexOf(a.confidence) - CONFIDENCE_ORDER.indexOf(b.confidence));
  const best = scored[0];
  const tied = scored.filter(s => s.confidence === best.confidence);
  const candidates = scored.map(s => ({ ...s.entry, confidence: s.confidence, reason: s.reason }));

  if (tied.length > 1) {
    return {
      match: null,
      confidence: null,
      reason: `ambiguous — ${tied.length} candidates tied at ${best.confidence}`,
      candidates,
    };
  }
  return { match: best.entry, confidence: best.confidence, reason: best.reason, candidates };
}

/**
 * Reduces a raw iScore roster to its active hitters.
 * @param {Array<Object>} players - Raw /public/teams/{guid}/players payload.
 * @returns {Array<Object>} { iscoreGuid, name, number, bats, throws, position }
 */
function iscoreHitters(players) {
  const out = [];
  for (const p of players || []) {
    if (p.active === false) continue;
    const position = String((p.positionGroup || {}).name || '').trim();
    if (PITCHER_POSITIONS.has(position.toLowerCase())) continue;
    const name = String(p.name || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    out.push({
      iscoreGuid: String(p.guid || ''),
      name,
      number: p.number == null ? '' : String(p.number),
      bats: batsCode(p.bats),
      throws: String(p.throwsHand || '').trim(),
      position,
    });
  }
  return out;
}

// ── Network ──────────────────────────────────────────────────────────────────
// The iScore public API needs no key. Base URL and league are overridable so a
// different league (or a mock) can be pointed at without a code change.

const ISCORE_BASE_URL = process.env.ISCORE_BASE_URL
  || 'https://api.microservices.iscoresports.com/api';
// ALPB. Discoverable via /public/leagues if it ever changes.
const ISCORE_LEAGUE_GUID = process.env.ISCORE_LEAGUE_GUID
  || 'df9fb9cc-0fdb-4b79-8a3c-ad5d7b415a56';

/** Fetches the clubs in a league. @returns {Promise<Array<{guid,name}>>} */
async function fetchIscoreTeams(axios, leagueGuid = ISCORE_LEAGUE_GUID) {
  const res = await axios.get(`${ISCORE_BASE_URL}/public/leagues/${leagueGuid}/teams`, { timeout: 15000 });
  return Array.isArray(res.data) ? res.data : [];
}

/** Fetches one club's raw roster. @returns {Promise<Array<Object>>} */
async function fetchIscoreRoster(axios, teamGuid) {
  const res = await axios.get(`${ISCORE_BASE_URL}/public/teams/${teamGuid}/players`, { timeout: 15000 });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Fetches every club's roster and joins its hitters to SLUGGER player IDs.
 *
 * Rosters are fetched in parallel; one club failing does not sink the rest, since
 * a partial roster list is far more useful than none. Players that do not resolve
 * are returned in `unmatched` rather than dropped — they are usually recent
 * signings SLUGGER has not ingested yet, and silently hiding them would look
 * like a bug to whoever knows the roster.
 *
 * @param {Object} axios - axios instance (injected so this stays unit-testable).
 * @param {Iterable<Object>} sluggerPlayers - Raw SLUGGER /players records.
 * @returns {Promise<{teams: Array, unmatched: Array, generatedAt: string}>}
 */
async function buildRosters(axios, sluggerPlayers, leagueGuid = ISCORE_LEAGUE_GUID) {
  const index = buildHitterIndex(sluggerPlayers);
  const iscoreTeams = await fetchIscoreTeams(axios, leagueGuid);

  const settled = await Promise.all(iscoreTeams.map(async (t) => {
    try {
      return { team: t, roster: await fetchIscoreRoster(axios, t.guid) };
    } catch (err) {
      console.error(`iScore roster failed for ${t.name}:`, err.message);
      return { team: t, roster: [] };
    }
  }));

  const teams = [];
  const unmatched = [];
  for (const { team, roster } of settled) {
    const batters = [];
    for (const h of iscoreHitters(roster)) {
      const m = matchHitter(h, index);
      if (m.match) {
        batters.push({
          name: m.match.name,
          ids: m.match.ids,
          bats: m.match.bats || (h.bats || ''),
          number: h.number,
          position: h.position,
          confidence: m.confidence,
          // Kept when the two disagree, so a mismatch is visible rather than silent.
          iscoreName: h.name === m.match.name ? undefined : h.name,
        });
      } else {
        unmatched.push({
          team: team.name, name: h.name, number: h.number,
          reason: m.reason, candidates: m.candidates.slice(0, 3).map(c => c.name),
        });
      }
    }
    batters.sort((a, b) => a.name.localeCompare(b.name));
    teams.push({ guid: team.guid, name: team.name, batters });
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  return { teams, unmatched, generatedAt: new Date().toISOString() };
}

module.exports = {
  ISCORE_BASE_URL,
  ISCORE_LEAGUE_GUID,
  fetchIscoreTeams,
  fetchIscoreRoster,
  buildRosters,
  NAME_SUFFIXES,
  FIRST_NAME_CORRECTIONS,
  NICKNAMES,
  PITCHER_POSITIONS,
  CONFIDENCE_ORDER,
  asciiFold,
  normalizeName,
  stripSuffix,
  correctFirst,
  isNicknamePair,
  splitIscoreName,
  splitSluggerName,
  editDistance,
  buildHitterIndex,
  scoreCandidate,
  batsCode,
  matchHitter,
  iscoreHitters,
};
