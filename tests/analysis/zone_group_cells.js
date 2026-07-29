'use strict';
/**
 * Analysis (NOT a unit test — lives outside node --test discovery).
 *
 * Answers the stakeholder question behind the zone × pitch-group annotation feature:
 * when we split each batter-profile's pitches by (zone × pitch group), are the cells
 * big enough to say anything, and how often would a real gate fire?
 *
 * Buckets the on-disk full-season pitch cache into (zone × group) cells per
 * batter-profile (batter_id + batter_side) using the REAL lib/stats functions
 * (getZoneFromLocation, getPitchGroup, computeZoneGroupAnnotations), then reports:
 *   - cell-size distribution (p25 / median / p75 / max)
 *   - share of cells with n >= 5 / 8 / 10 / 15
 *   - the same, tiered by profile size (profiles with >= 100 located pitches)
 *   - % of located pitches that fall in NO pitch group
 *   - % of zones that would annotate (vg or hg) under the real gates
 *
 * Usage: node tests/analysis/zone_group_cells.js [path-to-cache.json]
 */
const fs = require('fs');
const path = require('path');
const {
  getZoneFromLocation, getPitchGroup, computeZoneGroupAnnotations,
} = require('../../lib/stats.js');

const DEFAULT_CACHE = path.join(__dirname, '..', '..', 'cache', 'cache_2026-04-21_2026-07-14.json');
const cachePath = process.argv[2] || DEFAULT_CACHE;

if (!fs.existsSync(cachePath)) {
  console.error(`Cache not found: ${cachePath}`);
  process.exit(1);
}

const SWING_CALLS = ['StrikeSwinging', 'FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'];
const CONTACT_CALLS = ['FoulBall', 'FoulBallFieldable', 'FoulBallNotFieldable', 'InPlay'];

function pct(n, d) { return d > 0 ? (100 * n / d) : 0; }
function fmt(x) { return x.toFixed(1); }
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

console.log(`Reading ${path.basename(cachePath)} ...`);
const pitches = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
console.log(`Loaded ${pitches.length.toLocaleString()} raw pitches.\n`);

// profileKey -> { zoneAnalysis, located, ungrouped }
const profiles = new Map();
let totalLocated = 0;
let totalUngrouped = 0;

for (const p of pitches) {
  if (p.plate_loc_side == null || p.plate_loc_height == null || !p.batter_side) continue;
  totalLocated++;

  const handedness = p.batter_side === 'Left' ? 'LHB' : 'RHB';
  const zone = getZoneFromLocation(p.plate_loc_side, p.plate_loc_height, handedness);
  const group = getPitchGroup(p.auto_pitch_type || p.tagged_pitch_type);

  const key = `${p.batter_id}|${p.batter_side}`;
  let prof = profiles.get(key);
  if (!prof) { prof = { za: {}, located: 0 }; profiles.set(key, prof); }
  prof.located++;

  if (!prof.za[zone]) {
    prof.za[zone] = { pitches: 0, swings: 0, whiffs: 0, weakContact: 0, hardHits: 0, contact: 0 };
  }
  const zs = prof.za[zone];
  zs.pitches++;
  if (SWING_CALLS.includes(p.pitch_call)) zs.swings++;
  if (p.pitch_call === 'StrikeSwinging') zs.whiffs++;
  if (CONTACT_CALLS.includes(p.pitch_call)) zs.contact++;
  if (p.exit_speed && p.pitch_call === 'InPlay') {
    if (p.exit_speed >= 95) zs.hardHits++;
    else if (p.exit_speed < 70) zs.weakContact++;
  }

  if (!group) { totalUngrouped++; continue; }
  if (!zs.groups) zs.groups = {};
  if (!zs.groups[group]) {
    zs.groups[group] = { pitches: 0, swings: 0, whiffs: 0, weakContact: 0, hardHits: 0, contact: 0 };
  }
  const g = zs.groups[group];
  g.pitches++;
  if (SWING_CALLS.includes(p.pitch_call)) g.swings++;
  if (p.pitch_call === 'StrikeSwinging') g.whiffs++;
  if (CONTACT_CALLS.includes(p.pitch_call)) g.contact++;
  if (p.exit_speed && p.pitch_call === 'InPlay') {
    if (p.exit_speed >= 95) g.hardHits++;
    else if (p.exit_speed < 70) g.weakContact++;
  }
}

// Reduce each profile to the stats we need BEFORE mutation, then run the real gate.
// computeZoneGroupAnnotations mutates (deletes .groups, sets vg/hg), so cell sizes
// are captured first; each profile is annotated exactly once here.
const perProfile = [];
for (const prof of profiles.values()) {
  const cellSizes = [];
  let zonesWithGroups = 0;
  const zoneList = Object.values(prof.za);
  for (const z of zoneList) {
    if (z.groups) {
      zonesWithGroups++;
      for (const g of Object.values(z.groups)) cellSizes.push(g.pitches);
    }
  }
  computeZoneGroupAnnotations(prof.za);
  let zonesAnnotated = 0;
  for (const z of zoneList) if (z.vg || z.hg) zonesAnnotated++;
  perProfile.push({
    located: prof.located,
    zonesTotal: zoneList.length,
    zonesWithGroups,
    zonesAnnotated,
    cellSizes,
  });
}

function reportTier(label, tier) {
  const cellSizes = [];
  let zonesTotal = 0, zonesWithGroups = 0, zonesAnnotated = 0;
  for (const p of tier) {
    zonesTotal += p.zonesTotal;
    zonesWithGroups += p.zonesWithGroups;
    zonesAnnotated += p.zonesAnnotated;
    for (const c of p.cellSizes) cellSizes.push(c);
  }
  cellSizes.sort((a, b) => a - b);
  const total = cellSizes.length;
  const ge = (n) => cellSizes.filter(c => c >= n).length;

  console.log(`── ${label} ──`);
  console.log(`  profiles: ${tier.length.toLocaleString()}   zones: ${zonesTotal.toLocaleString()}   (zone×group) cells: ${total.toLocaleString()}`);
  console.log(`  cell size  p25=${percentile(cellSizes, 0.25)}  median=${percentile(cellSizes, 0.50)}  p75=${percentile(cellSizes, 0.75)}  max=${cellSizes[cellSizes.length - 1] || 0}`);
  console.log(`  cells n>=5: ${fmt(pct(ge(5), total))}%   n>=8: ${fmt(pct(ge(8), total))}%   n>=10: ${fmt(pct(ge(10), total))}%   n>=15: ${fmt(pct(ge(15), total))}%`);
  console.log(`  zones with any group cell: ${fmt(pct(zonesWithGroups, zonesTotal))}%`);
  console.log(`  zones that ANNOTATE (vg or hg) under real gates: ${zonesAnnotated.toLocaleString()} = ${fmt(pct(zonesAnnotated, zonesTotal))}% of zones\n`);
}

const bigTier = perProfile.filter(p => p.located >= 100);

console.log('=== ZONE × PITCH-GROUP CELL ANALYSIS ===\n');
console.log(`located pitches (with plate coords + side): ${totalLocated.toLocaleString()}`);
console.log(`ungrouped pitches (no Fastballs/Breaking/Offspeed): ${totalUngrouped.toLocaleString()} = ${fmt(pct(totalUngrouped, totalLocated))}%`);
console.log(`distinct batter-profiles (batter_id × side): ${perProfile.length.toLocaleString()}   with >= 100 pitches: ${bigTier.length.toLocaleString()}\n`);

reportTier('ALL profiles', perProfile);
reportTier('TIER: profiles with >= 100 located pitches', bigTier);
