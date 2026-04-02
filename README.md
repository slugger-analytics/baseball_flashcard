




Deployed at: https://alpb-analytics.com/widgets/flashcard/


---

# SLUGGER Batter Flashcard Widget

This widget is part of the broader SLUGGER platform developed by the Johns Hopkins Sports Analytics Research Group (SARG) in partnership with the Atlantic Professional Baseball League (ALPB).

A web application generates cognitively-optimized scouting flashcards for Atlantic League batters, built on top of the SLUGGER API and Trackman pitch-level data. Designed for pitchers, catchers, and coaches who need actionable batter intelligence quickly — before or during a game.

---

## What It Does

The widget pulls pitch-level data from the SLUGGER API for a user-specified date range and transforms it into batter profiles that highlight key weaknesses. Users can filter by:

- **Date range** — focus on recent form or a full season
- **Max velocity** — only see results for pitches within a pitcher's own velocity range
- **Pitch group** — filter by fastballs, breaking balls, or offspeed pitches
- **Confidence threshold** — control how selectively weaknesses are surfaced (higher threshold = fewer, more reliable zones)

For each batter, the widget surfaces metrics including whiff rate, foul rate, weak contact rate, first-pitch swing tendency, spray tendency, steal threat, bunt threat, and the pitch sequences most likely to produce outs. A one-page printable report can be generated for dugout use.

---

## Prerequisites

Before running the app, make sure you have the following installed:

- **Node.js** v14.0.0 or higher — download at [nodejs.org](https://nodejs.org)
- **npm** — comes bundled with Node.js
- A valid **SLUGGER API key** — contact the SARG team or the ALPB platform administrators to obtain one

---

## Installation

Clone the repository and install dependencies:

```bash
git clone <repo.git>
cd baseball_flashcard
npm install
```


---

## Running Locally

To start the server:

```bash
npm start
```

This runs `node server.js`. Once started, open your browser and navigate to:

```
http://localhost:8080
```

You should see the flashcard interface load. On startup, the server will automatically populate lookup caches for players, teams, and ballparks from the SLUGGER API — you will see confirmation logs in the terminal when this completes.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Project Structure

| File | Purpose |
|---|---|
| `server.js` | Main entry point. Sets up the Express server, registers all API routes, handles request logging, and starts the app |
| `app.js` | Extended application logic |
| `server_api.js` | Additional API route definitions |
| `frontend.js` | Client-side JavaScript for the browser UI |
| `index.html` | Main HTML entry point served as the frontend |
| `styles.css` | Stylesheet for the flashcard UI |
| `contact_filter.py` | Python script for contact-based filtering logic |
| `lhb.svg` / `rhb.svg` | Full strike zone diagrams for left-handed and right-handed batters |
| `left-hand-batter.svg` / `right-hand-batter.svg` | Batter silhouette graphics |
| `explore-dates.js` | Utility script for exploring which dates have available game data |
| `test_tendencies.js` | Test script for batter tendency logic |
| `Dockerfile` | Container configuration for deployment |

---

## API Endpoints

### `GET /api/teams/range`
Fetches and processes all batter data for a given date range.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `startDate` | string | No | Start of date range (YYYY-MM-DD). Defaults to start of current season |
| `endDate` | string | No | End of date range (YYYY-MM-DD). Defaults to today |
| `maxVelocity` | number | No | Filters out any pitch faster than this value (mph) |
| `pitchGroup` | string | No | One of `Fastballs`, `Breaking`, `Offspeed`, or `All` |

### `POST /api/weakness-zones`
Calculates weakness zones for a specific batter at a given confidence threshold.

Request body:
```json
{
  "confidenceThreshold": 75,
  "teamsData": { ... },
  "selectedTeam": "York Revolution",
  "selectedBatter": "Player Name"
}
```

### `GET /api/generate-report`
Generates a full report for a specific batter, including weakness zones, for PDF output.

| Parameter | Type | Description |
|---|---|---|
| `startDate` | string | Start of date range |
| `endDate` | string | End of date range |
| `maxVelocity` | number | Optional velocity filter |
| `confidenceThreshold` | number | Optional threshold for weakness zone calculation |
| `selectedTeam` | string | Team name |
| `selectedBatter` | string | Batter name |

---


## Authors

Angela Appiah and Aaron Ressom — Johns Hopkins University Sports Analytics Research Group, Spring 2026