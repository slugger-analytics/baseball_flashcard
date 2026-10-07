**Live deployment (prod):** https://slugger-alb-1518464736.us-east-2.elb.amazonaws.com/widgets/flashcard/ — AWS Lambda behind the shared slugger ALB, auto-deployed by the `Flashcard Deploy` workflow on every push to `main`. Static frontend mirror: https://slugger-analytics.github.io/baseball_flashcard/
> A Vercel deployment (slugger-baseball-flashcard.vercel.app) existed previously and is dead. Its config and the dormant CI deploy job have been removed; AWS Lambda is the only deployment path.

---

# SLUGGER Batter Flashcard Widget

Part of the SLUGGER platform developed by the Johns Hopkins Sports Analytics Research Group (SARG) in partnership with the Atlantic Professional Baseball League (ALPB).

A web application that generates cognitively-optimized scouting flashcards for Atlantic League batters, built on top of the SLUGGER API and Trackman pitch-level data. Designed for pitchers, catchers, and coaches who need actionable batter intelligence quickly — before or during a game.

---

## What It Does

The widget turns a hitter's Trackman pitch data into a one-page plan for pitching to him. Everything is driven from one toolbar:

- **Team** — an iScore club (active roster), all rostered hitters, or everyone in SLUGGER
- **Hitter** — search by either name order, club or jersey number; ‹ › (or the arrow keys) step through the team
- **Dates** — the season (default), last 30 / last 14 days of games, or a custom range; remembered per browser
- **Print card** / **Print team** — one page for this hitter, or one page per hitter on the selected club, for the chosen dates

Max velocity and pitch group (fastballs / breaking / offspeed) live in the settings panel and reload the card.

For each hitter the card shows the strike zone with pitcher-win ratings by pitch family, how he handles each pitch, first-pitch approach, vulnerable and hot zones, the sequence that gets him out, and steal / bunt / spray tendencies.

---

## Prerequisites

- **Node.js** v14.0.0 or higher — [nodejs.org](https://nodejs.org)
- **npm** — bundled with Node.js
- A valid **SLUGGER API key** — contact the SARG team or the ALPB platform administrators

---

## Installation

```bash
git clone <repo-url>
cd baseball_flashcard
npm install
```

---

## Environment Setup

Copy the example env file and fill in your API key:

```bash
cp .env.example .env
# then open .env and set SLUGGER_API_KEY=<your key>
```

The `.env` file is gitignored — never commit it. See `.env.example` for all available variables.

---

## Running Locally

```bash
npm start
```

Opens on `http://localhost:8080`. On startup the server fetches team, player, and ballpark lookup data from the SLUGGER API — watch the terminal for confirmation logs before making data requests.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## System Architecture

The app uses a three-tier architecture:

```
Browser (public/: index.html + js/*.js, plain scripts, no build step)
    ↕  JSON over HTTP
Express Middleware Server (server.js)
    ↕  REST + x-api-key
SLUGGER API (AWS API Gateway → Trackman pitch data)
```

**Data flow:**
1. The browser asks for one batter's card (`/api/batter/card`) for a date range.
2. `lib/pitch_cache.js` checks a disk-backed streaming cache (`/tmp/cache` on Lambda, `./cache/` locally). On a miss, `lib/slugger.js` pages through the SLUGGER `/pitches` endpoint filtered to that batter.
3. `lib/transform.js` aggregates the pitches into zone stats, tendencies (`lib/tendencies.js`) and sequence data, and packs the per-pitch dots into a columnar wire format.
4. The browser rates each (pitch family × zone) bucket with `public/js/pitch_logic.js` and renders the flashcard.

**Server layout:** `server.js` only sets up Express and mounts `routes/`. Each file in
`routes/` is one endpoint group and stays thin; the work lives in `lib/`.

---

## Key Algorithms

### Zone Labelling
The strike zone is defined in `public/js/pitch_logic.js` (`STRIKE_ZONE`) as ±0.833 ft horizontally
and 1.5–3.5 ft vertically, and is split into nine equal boxes — `High-In` … `Low-Out`.
Pitches outside the zone are labelled by how they missed and prefixed `Chase `
(e.g. `Chase Low-Out`), so they bucket separately from the nine in-zone boxes.

`getZoneFromLocation` (labels) and `plateToPercent` (the drawn grid) both derive from
`STRIKE_ZONE`, so the rectangle on the flashcard always lands exactly where an
on-the-edge pitch plots. They previously drifted: labels split at ±0.33 ft / 2.0–3.0 ft
while the overlay drew a flat 33%/66% grid over a ±2 ft box, so a circle could sit in
the middle cell and still be bucketed `High-In`.

### Bucket Rating (the green/red circles)

Buckets are `(pitch family × zone)`. Each is scored on how often a pitch there went
the **pitcher's** way — whiff, called strike, foul or out are wins; a **hit or a ball**
is a loss (`other`/HBP is neutral). Counting the ball is the crux: under the previous
`hits ÷ pitches` metric a pitch three feet outside scored a perfect 0.000 and rated
"attack here", and 53% of all advice the card gave was *throw it out of the zone*.

Buckets are rated against an expectation **for the spot**, built in two steps.

**1. Regime.** Three baselines, by how far outside the zone the pitch was:

| regime | | league pitcher-win | k | edge |
|---|---|---|---|---|
| `zone` | the 9 in-zone boxes | 84.4% | 54 | 2.1 pts |
| `edge` | chase missing on ONE axis (`Chase Mid-Out`) | 32.7% | 18 | 6.7 pts |
| `deep` | chase missing on BOTH axes (`Chase High-In`) | 10.5% | 17 | 3.6 pts |

Two regimes weren't enough: with all 8 chase regions sharing one 27% baseline, that
baseline was set by the edge bands where hitters actually chase, so the diagonal
corners came out red for nearly everyone — `Chase High-Out` for **91%** of batters.
That's geometry, not scouting.

**2. Zone offset.** Even within a regime, individual zones differ systematically —
`Chase High-Out` runs 3.5% pitcher-win against a 10.5% regime baseline. `ZONE_LEAGUE_OFFSET`
subtracts each zone's league-wide effect, leaving only the part that's about *this*
batter:

```
expected   = regimeBaseline + ZONE_LEAGUE_OFFSET[zone]
shrunkRate = (wins + k × expected) / (n + k)
green if shrunkRate − expected ≥ +edge      red if ≤ −edge
```

Together these flatten %red across all 17 zones into a 16–46% band with no zone
universal (`Chase High-Out`: 91% → 16%). `k = p(1−p)/τ²` from the genuine
between-bucket spread after subtracting sampling noise (5.0 pts in zone, 11.2 edge,
7.5 deep — where a pitch lands *in* the zone barely matters; where you *miss* matters
a lot). All constants live in `public/js/pitch_logic.js`, fitted on 45 batters / ~40k pitches.

**Color Sensitivity** (`ratingSensitivity`, 1–5, default 3) scales `edge`. Because
shrinkage has already pulled thin buckets onto the baseline, loosening the edge
surfaces smaller *real* differences rather than resurrecting noise — it is a display
preference, not a statistical one. Measured share of buckets:

| level | multiplier | green | red | gray |
|---|---|---|---|---|
| 1 Strict | 1.00 | 13% | 19% | 68% |
| 3 Balanced (default) | 0.50 | 29% | 35% | 36% |
| 5 Very loose | 0.20 | 41% | 46% | 13% |

Below ~0.4 an all-win 3-pitch in-zone bucket starts clearing the bar, so the loosest
levels lean on `bucketMinPitches` to hold the line.

### Weakness Zone Scoring
Each zone present in `zoneAnalysis` is scored:

```
composite = 0.45 × rank(whiff%) + 0.35 × rank(weak contact%) + 0.20 × rank(chase/foul%)
```

Higher composite = stronger weakness. Zones are sorted and the top N are shown depending on the confidence tier.
Note that `Chase ` zones are ranked alongside the nine in-zone boxes, so up to 17 zones can compete.

### Confidence Gating
Three tiers control which zones are displayed:

| Mode | Min pitches/zone | Zone types shown | Max zones |
|---|---|---|---|
| Strict (≥75) | 10 | Critical only | 4 |
| Balanced (≥50) | 7 | Critical + Major | 8 |
| Broad (<50) | 3 | All | 9 |

### First-Pitch Aggression
- ≥70% first-pitch swing rate → **Aggressive**
- ≤35% → **Patient**
- In between → **Neutral**

### Switch Hitter Handling
Switch hitters are stored as two separate profiles keyed by `{team}_{name}_LHB` and `{team}_{name}_RHB` so each batting-side profile is independent.

### Spray Chart
BIS ±15° pull/opposite-field boundaries, with handedness flip applied (pull side differs for LHB vs RHB).

---

## Project Structure

### Core application files

| File | Purpose |
|---|---|
| `server.js` | Express setup: health check, logging, static files, mounts `routes/` at `/` and `BASE_PATH` |
| `routes/batters.js` | `GET /api/batters`, `GET /api/rosters` — who can be picked |
| `routes/batter_card.js` | `GET /api/batter/card` — the data behind one flashcard |
| `routes/league_baseline.js` | `GET /api/league-baseline` — hit by the prewarm cron |
| `routes/status.js` | `GET /api/health`, `GET /api/cache-status` |
| `lib/config.js` | Env vars, cache dir, current season (from `SEASONS` in `public/js/pitch_logic.js`), team names |
| `lib/slugger.js` | SLUGGER HTTP client: timeout + retry, concurrent paging, pitch slimming |
| `lib/pitch_cache.js` | Batter and date-range pitch fetches with the streamed disk cache |
| `lib/transform.js` | Raw pitches → per-batter card data; columnar wire encoding |
| `lib/tendencies.js` | Steal/bunt threat, spray direction, out-pitch sequence |
| `lib/league_baseline.js` | League first-pitch baseline (memo + disk) |
| `lib/lookup.js` | SLUGGER player/team name lookups |
| `lib/roster_cache.js` | Cached iScore rosters narrowed to active hitters |
| `lib/dates.js` | Date parsing and range validation |
| `lib/iscore.js` | iScore roster fetch and iScore→SLUGGER hitter name matching |
| `lib/stats.js` | First-pitch approach and out-pitch finish location |
| `lib/players.js` | Canonical player names and batter de-duplication |

### Browser app (`public/` — the only directory the server serves)

| File | Purpose |
|---|---|
| `index.html` | Page shell; loads the scripts below in order |
| `js/pitch_logic.js` | Shared pure logic: strike zone, pitch families, bucket ratings, season calendar and date windows. Also required by the server, so both describe the same zone |
| `js/core.js` | Client state (`TEAMS_DATA`, `ROSTERS`, settings) and small helpers: `createElement`, hitter search, wire decoding |
| `js/features/zone.js` | Strike zone graphic: grid, rated circles + hover breakdown, batter silhouette |
| `js/features/arsenal.js` | "How he handles each pitch" table |
| `js/features/tendencies.js` | First pitch, vulnerable / hot zones, out pitch, threats |
| `js/features/guide.js` | The 💡 "Understanding the Widget" explainer |
| `js/app.js` | `FlashcardApp`: selection state, data loading, render loop |
| `js/toolbar.js` | Team → Hitter → Dates → Print |
| `js/card.js` | The flashcard and the loading / empty / no-data / error states |
| `js/settings.js` | Analysis Settings panel (Filters, Display, Advanced) |
| `js/print.js` | Print card and the team packet |
| `js/main.js` | Starts the app |
| `styles.css` | Stylesheet |
| `lhb.svg` / `rhb.svg` | Batter silhouettes flanking the strike zone (pitcher's perspective) |

`app.js` defines the class; `toolbar.js`, `card.js`, `settings.js` and `print.js` add their
methods with `Object.assign(FlashcardApp.prototype, …)`. Script order in `index.html` matters.

### Configuration & deployment

| File | Purpose |
|---|---|
| `.env.example` | Template for required environment variables (copy to `.env`) |
| `package.json` | Node dependencies and npm scripts |
| `Dockerfile` | Container config for the AWS Lambda deployment |
| `.dockerignore` / `.gitignore` | Ignore rules |

### Research & utilities

| File | Purpose |
|---|---|
| `contact_filter.py` | Python reference implementation of pitch contact classification (used for research/analysis, not the live server) |
| `explore-dates.js` | One-off script for querying which dates have available game data |

---

## API Endpoints

All routes are served at `/` and again under `BASE_PATH` (`/widgets/flashcard` in production).

### `GET /api/batters`
Every SLUGGER hitter, deduped by canonical name: `{ batters: [{ name, ids, team, bats }], count }`.

### `GET /api/rosters`
iScore club rosters narrowed to hitters active in the last 21 days of games, each joined to SLUGGER ids. Cached 6 h; `?refresh=1` rebuilds. Answers 502 with empty `teams` if iScore is down — the client then falls back to `/api/batters`.

### `GET /api/batter/card`
One hitter's card data.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `batterIds` | string | Yes | Comma-separated SLUGGER ids (one person can carry several) |
| `startDate` / `endDate` | string | No | YYYY-MM-DD; default the season to date |
| `maxVelocity` | number | No | Exclude pitches faster than this (mph) |
| `pitchGroup` | string | No | `All`, `Fastballs`, `Breaking` or `Offspeed` |

Errors: 400 `missing_batter` / `invalid_batter` / `invalid_range`, 404 `no_data` / `unknown_batter` / `future_date`, 503 `upstream_error` (feed unreachable — never reported as "no data").

### `GET /api/league-baseline`
Recomputes the league first-pitch swing rate the cards grade against. Hit every 30 minutes by `prewarm.yml`.

### `GET /api/health`, `GET /api/cache-status`, `GET /health`
Liveness and lookup-cache status.

---

## Deployment

A push to `main` triggers `.github/workflows/deploy.yml` ("Flashcard Deploy"), which
builds an arm64 container (Dockerfile + Lambda Web Adapter), pushes it to ECR, and
updates the `widget-flashcard` Lambda behind the shared `slugger-alb` at
`/widgets/flashcard/*`. Auth is GitHub OIDC — no static AWS keys.

`SLUGGER_API_KEY` is **not** passed by the workflow; it lives in the Lambda
function's own environment configuration. Rotating the key means updating it there
as well as locally, or production will start failing upstream calls while local
development keeps working.

The one filesystem constraint: Lambda's disk is read-only except `/tmp`, so
`CACHE_DIR` resolves to `/tmp/cache` there. That directory lives and dies with the
execution container, so a cold start rebuilds the pitch, roster and league-baseline
caches. Set `CACHE_DIR` to a persistent mount if that ever matters.

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request:

- **checks** — `npm ci`, `node --check` on the server, `lib/`, `routes/` and every `public/js` file, then `npm test` (`test_smoke.js`), which boots the server **without any secrets** and asserts the static `index.html` serves, the health endpoints answer, and `/api/batter/card` fails gracefully (400/404) when misused. No `SLUGGER_API_KEY` is needed for CI to pass.

`ci.yml` runs checks only — deployment is `deploy.yml` (see **Deployment** above).

---

## Data Availability

Pitch data lives behind the SLUGGER API (ALPB + Trackman). A valid `SLUGGER_API_KEY` is required to fetch any data. Contact the SARG team or ALPB platform administrators for API access. No raw data files are committed to this repository.

---

## Known Issues & Limitations

- **ALPB 2026 season calendar** is hardcoded (April 21 – September 13). Add the new season to `SEASONS` in `public/js/pitch_logic.js` at the start of each season — the server (`lib/config.js`) and the toolbar's date presets both read it.
- **Cache invalidation** is date-range-keyed and versioned. Current `_v2` pitch caches retain the upstream `game_id`; older cache files are ignored. If the underlying data changes for a date range already cached, delete the relevant current-version file from `cache/` (local) or redeploy (Lambda `/tmp` is ephemeral).
- **Analysis calibration** requires a time-ordered historical holdout. Raw pitch data is not committed, so do not adjust model constants using only unit-test fixtures or evaluate on the same games used to fit them.
- **Large date ranges** can be slow on first load (cold cache) due to paginated API fetching; subsequent loads for the same range are fast.

---

## Potential Next Steps

- **Pitcher-matchup filter**: allow filtering batter profiles by pitcher handedness (LHP vs RHP) to generate split-specific scouting cards.
- **Season-over-season comparison**: add a year-over-year toggle to detect batters whose zone tendencies have shifted.
- **Mobile/tablet layout**: the current UI is desktop-first; a responsive layout pass would improve tablet usability in the dugout.
- **Automated cache expiry**: implement TTL-based cache invalidation so in-season data refreshes automatically without manual cache deletion.
- **ALPB calendar auto-detection**: replace the hardcoded season dates with a dynamic lookup against the SLUGGER `/games` endpoint.

---

## Authors

Angela Appiah and Aaron Ressom — Johns Hopkins University Sports Analytics Research Group, Spring 2026
