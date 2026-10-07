require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { BASE_PATH } = require('./lib/config.js');
const { lookupCache, populateLookupCaches } = require('./lib/lookup.js');
const { resetLeagueFirstPitch } = require('./lib/league_baseline.js');

const app = express();
app.use(cors());
app.use(express.json());

// Root health check endpoint for Lambda Web Adapter (must be at root level), and
// again at BASE_PATH for ALB routing. Registered before the request logger so the
// readiness probe does not flood the logs.
const healthHandler = (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
};
app.get('/health', healthHandler);
if (BASE_PATH) app.get(`${BASE_PATH}/health`, healthHandler);

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const requestPath = req.path;
  const method = req.method;

  console.log(`[${new Date().toISOString()}] ${method} ${requestPath} - Started`);

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ${method} ${requestPath} - ${res.statusCode} (${duration}ms)`);
  });

  next();
});

// Serve the browser app (public/ only — never the server's own files) at both
// root and BASE_PATH.
// no-cache = revalidate on every use (304 when unchanged), NOT "don't cache".
// Without it, browsers held app.js for days on heuristic freshness and users
// ran stale bundles long after deploys.
const STATIC_OPTS = {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
};
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, STATIC_OPTS));
if (BASE_PATH) {
  app.use(BASE_PATH, express.static(PUBLIC_DIR, STATIC_OPTS));
}

// API routes, mounted once at the root and once at BASE_PATH for ALB routing.
const api = express.Router();
api.use(require('./routes/status.js'));
api.use(require('./routes/batters.js'));
api.use(require('./routes/batter_card.js'));
api.use(require('./routes/league_baseline.js'));
app.use(api);
if (BASE_PATH) app.use(BASE_PATH, api);

// Error handling middleware for logging errors with stack traces
app.use((err, req, res, next) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${err.message}`);
  console.error(`[${timestamp}] Stack trace:`, err.stack);

  res.status(500).json({
    error: 'Internal server error',
    timestamp: timestamp
  });
});

// Environment-based port configuration for Lambda compatibility
const PORT = process.env.PORT || 8080;

async function startServer() {
  await populateLookupCaches();
  app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}/\n`);
  });
}

module.exports = app;

// Test seam: when required as a module (never as the production entrypoint), expose
// the in-memory lookup cache so the unit suite can seed players without a network call,
// and a way to drop the league first-pitch memo so a test can model a cold container.
if (require.main !== module) {
  app.__lookupCache = lookupCache;
  app.__resetLeagueFirstPitch = resetLeagueFirstPitch;
}

if (require.main === module) {
  startServer().catch(console.error);
}
