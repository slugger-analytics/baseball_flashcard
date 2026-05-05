**Live deployment:** https://slugger-baseball-flashcard.vercel.app/

---

# SLUGGER Batter Flashcard Widget

Part of the SLUGGER platform developed by the Johns Hopkins Sports Analytics Research Group (SARG) in partnership with the Atlantic Professional Baseball League (ALPB).

A web application that generates cognitively-optimized scouting flashcards for Atlantic League batters, built on top of the SLUGGER API and Trackman pitch-level data. Designed for pitchers, catchers, and coaches who need actionable batter intelligence quickly — before or during a game.

---

## What It Does

The widget pulls pitch-level data from the SLUGGER API for a user-specified date range and transforms it into batter profiles that highlight key weaknesses. Users can filter by:

- **Date range** — focus on recent form or a full season
- **Max velocity** — only see results for pitches within a pitcher's own velocity range
- **Pitch group** — filter by fastballs, breaking balls, or offspeed pitches
- **Confidence threshold** — control how selectively weaknesses are surfaced (higher = fewer, more reliable zones)

For each batter, the widget surfaces: whiff rate, foul rate, weak contact rate, first-pitch aggression, spray tendency, steal threat, bunt threat, and the pitch sequences most likely to produce outs. A one-page printable report can be generated for dugout use.

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
Browser (index.html + frontend.js + app.js)
    ↕  JSON over HTTP
Express Middleware Server (server.js)
    ↕  REST + x-api-key
SLUGGER API (AWS API Gateway → Trackman pitch data)
```

**Data flow:**
1. The browser sends a date range query to the Express server.
2. `server.js` checks a disk-backed streaming cache (`/tmp/cache` on Vercel, `./cache/` locally). On a cache miss it pages through the SLUGGER `/pitches` endpoint, collecting all pitch records for the range.
3. Raw pitches are aggregated per-batter into zone stats, tendency metrics, and sequence data, then written to the cache as JSON and streamed back to the browser.
4. The browser computes weakness zones client-side (or re-requests them via `/api/weakness-zones`) and renders the flashcard UI.

**Key server functions in `server.js`:**

| Function | What it does |
|---|---|
| `fetchPitchesByDateRange` | Cache-aware entry point for pitch data retrieval |
| `readDiskCache` / `writeDiskCache` | Stream-JSON-backed disk cache (avoids loading large files into memory at once) |
| `aggregatePitches` | Converts raw pitch records into per-batter stats |
| `computeWeaknessZones` | Ranks the 3×3 strike zone grid by composite score (whiff%, weak%, chase/foul%) |

---

## Key Algorithms

### Weakness Zone Scoring
Each of the nine strike zone cells is scored:

```
composite = 0.45 × rank(whiff%) + 0.35 × rank(weak contact%) + 0.20 × rank(chase/foul%)
```

Higher composite = stronger weakness. Zones are sorted and the top N are shown depending on the confidence tier.

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
| `server.js` | Main Express server — API routes, data aggregation, disk cache, weakness zone computation |
| `index.html` | Single-page app shell served to the browser |
| `app.js` | Compiled/bundled client-side application logic |
| `frontend.js` | Source client-side JS (date picker, UI interactions, card rendering) |
| `styles.css` | Flashcard UI stylesheet |
| `lhb.svg` / `rhb.svg` | Full strike zone diagrams for left/right-handed batters |
| `left-hand-batter.svg` / `right-hand-batter.svg` | Batter silhouette graphics |

### Configuration & deployment

| File | Purpose |
|---|---|
| `.env.example` | Template for required environment variables (copy to `.env`) |
| `package.json` | Node dependencies and npm scripts |
| `vercel.json` | Vercel serverless deployment config |
| `Dockerfile` | Container config for non-Vercel deployments |
| `.dockerignore` / `.gitignore` / `.vercelignore` | Ignore rules |

### Research & utilities

| File | Purpose |
|---|---|
| `contact_filter.py` | Python reference implementation of pitch contact classification (used for research/analysis, not the live server) |
| `explore-dates.js` | One-off script for querying which dates have available game data |
| `test_tendencies.js` | Manual test script for batter tendency logic in isolation |

---

## API Endpoints

### `GET /api/teams/range`
Fetches and processes all batter data for a date range. Results are disk-cached by date range key.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `startDate` | string | Yes | Start of date range (YYYY-MM-DD) |
| `endDate` | string | Yes | End of date range (YYYY-MM-DD) |
| `maxVelocity` | number | No | Exclude pitches faster than this value (mph) |
| `pitchGroup` | string | No | `Fastballs`, `Breaking`, `Offspeed`, or `All` |

### `POST /api/weakness-zones`
Calculates weakness zones for a specific batter at a given confidence threshold.

```json
{
  "confidenceThreshold": 75,
  "teamsData": { ... },
  "selectedTeam": "York Revolution",
  "selectedBatter": "Player Name"
}
```

### `GET /api/generate-report`
Generates a full printable report for a specific batter.

| Parameter | Type | Description |
|---|---|---|
| `startDate` | string | Start of date range (YYYY-MM-DD) |
| `endDate` | string | End of date range (YYYY-MM-DD) |
| `maxVelocity` | number | Optional velocity filter |
| `confidenceThreshold` | number | Optional, defaults to 50 |
| `selectedTeam` | string | Team name |
| `selectedBatter` | string | Batter name (use `{name}_LHB` or `{name}_RHB` for switch hitters) |

---

## Deployment (Vercel)

The app is configured for Vercel serverless deployment via `vercel.json`. The key constraint is that Vercel's filesystem is read-only except `/tmp` — the server automatically uses `/tmp/cache` when the `VERCEL` environment variable is set (Vercel injects this automatically).

Set the following environment variable in Vercel project settings:
- `SLUGGER_API_KEY` — your API key

Push to `main` to trigger a production deploy.

---

## Data Availability

Pitch data lives behind the SLUGGER API (ALPB + Trackman). A valid `SLUGGER_API_KEY` is required to fetch any data. Contact the SARG team or ALPB platform administrators for API access. No raw data files are committed to this repository.

---

## Known Issues & Limitations

- **ALPB 2026 season calendar** is hardcoded (April 21 – September 13). Update the calendar constants in `server.js` at the start of each new season.
- **Cache invalidation** is date-range-keyed only — if the underlying data changes for a date range already cached, delete the relevant file from `cache/` (local) or redeploy (Vercel `/tmp` is ephemeral).
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
