import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  registerClient, getClient,
  upsertStravaUser, getStravaUser, updateStravaTokens,
  createAuthCode, consumeAuthCode,
  createAccessToken, getAthleteIdFromToken,
} from './db.js';

const BASE_URL  = process.env.BASE_URL;   // e.g. https://187-77-203-66.sslip.io
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const PORT = process.env.PORT || 3001;

// ── Strava API ────────────────────────────────────────────────────────────────

async function refreshStravaTokenIfNeeded(user) {
  if (Math.floor(Date.now() / 1000) < user.expires_at - 60) return user.access_token;
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: user.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  updateStravaTokens(user.athlete_id, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at,
  });
  return data.access_token;
}

async function stravaGet(token, path) {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.json();
}

function formatActivity(a, laps) {
  const lines = [];
  const date = a.start_date_local.slice(0, 10);
  lines.push(`\n${'='.repeat(60)}`);
  lines.push(`Date: ${date} | Sport: ${a.sport_type} | Name: ${a.name}`);
  if (a.description) lines.push(`Description: ${a.description}`);

  const distMi    = (a.distance / 1609.34).toFixed(2);
  const movingMin  = (a.moving_time / 60).toFixed(1);
  const elapsedMin = (a.elapsed_time / 60).toFixed(1);
  const elevFt    = Math.round((a.total_elevation_gain || 0) * 3.28084);
  lines.push(`Distance: ${distMi} mi | Moving Time: ${movingMin} min | Elapsed Time: ${elapsedMin} min | Elevation: ${elevFt} ft`);

  if (a.average_heartrate) lines.push(`Heart Rate: avg ${a.average_heartrate} bpm | max ${a.max_heartrate} bpm`);

  if (a.sport_type === 'Run' && a.distance > 0) {
    const paceSecPerMile = a.moving_time / (a.distance / 1609.34);
    const paceMin = Math.floor(paceSecPerMile / 60);
    const paceSec = Math.floor(paceSecPerMile % 60);
    lines.push(`Avg Pace: ${paceMin}:${String(paceSec).padStart(2, '0')} /mi`);
  }

  if (laps && laps.length > 1) {
    lines.push(`Laps (${laps.length}):`);
    laps.forEach((lap, i) => {
      const lapDist = (lap.distance / 1609.34).toFixed(2);
      const lapMin  = (lap.moving_time / 60).toFixed(1);
      const lapElev = Math.round((lap.total_elevation_gain || 0) * 3.28084);
      const hrStr   = lap.average_heartrate ? ` | HR: ${lap.average_heartrate} bpm` : '';
      lines.push(`  Lap ${i + 1}: ${lapDist} mi | ${lapMin} min | ${lapElev} ft${hrStr}`);
    });
  }
  return lines.join('\n');
}

async function fetchStravaActivities(athleteId, num = 20) {
  const user = getStravaUser(athleteId);
  if (!user) throw new Error('Strava account not connected');
  const token = await refreshStravaTokenIfNeeded(user);
  const activities = await stravaGet(token, `/athlete/activities?per_page=${num}`);
  const lines = [`STRAVA ACTIVITIES — Last ${activities.length} activities\n`];
  for (const a of activities) {
    const [detail, laps] = await Promise.all([
      stravaGet(token, `/activities/${a.id}`),
      stravaGet(token, `/activities/${a.id}/laps`),
    ]);
    a.description = detail.description;
    lines.push(formatActivity(a, laps));
  }
  return lines.join('\n');
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function extractBearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function requireAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    res.set('WWW-Authenticate', `Bearer realm="${BASE_URL}", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  const athleteId = getAthleteIdFromToken(token);
  if (!athleteId) {
    res.set('WWW-Authenticate', `Bearer realm="${BASE_URL}", error="invalid_token"`);
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.athleteId = athleteId;
  next();
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createMCPServer(athleteId) {
  const server = new Server(
    { name: 'claude-strava', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'get_strava_activities',
      description: 'Fetch the latest Strava training activities. Always call this at the start of a conversation to load fresh data before any analysis.',
      inputSchema: {
        type: 'object',
        properties: {
          num_activities: {
            type: 'number',
            description: 'Number of recent activities to fetch (default: 20)',
          },
        },
      },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'get_strava_activities') throw new Error(`Unknown tool: ${request.params.name}`);
    const num = request.params.arguments?.num_activities ?? 20;
    const data = await fetchStravaActivities(athleteId, num);
    return { content: [{ type: 'text', text: data }] };
  });

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── OAuth discovery ───────────────────────────────────────────────────────────

const resourceMetadata = () => ({
  resource: `${BASE_URL}/mcp`,
  authorization_servers: [`${BASE_URL}`],
});

const serverMetadata = () => ({
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/oauth/authorize`,
  token_endpoint: `${BASE_URL}/oauth/token`,
  registration_endpoint: `${BASE_URL}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
});

app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(resourceMetadata()));
app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(resourceMetadata()));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(serverMetadata()));

// ── Dynamic client registration ───────────────────────────────────────────────

app.post('/register', (req, res) => {
  const redirectUris = req.body.redirect_uris ?? [];
  const client = registerClient({ redirectUris });
  res.status(201).json({
    client_id: client.id,
    client_secret: client.secret,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});

// ── Authorization endpoint ────────────────────────────────────────────────────

app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  if (!client_id) return res.status(400).send('Missing client_id');

  // Store params in a short-lived query string on the Strava redirect
  const stravaAuthUrl = new URL('https://www.strava.com/oauth/authorize');
  stravaAuthUrl.searchParams.set('client_id', CLIENT_ID);
  stravaAuthUrl.searchParams.set('redirect_uri', `${BASE_URL}/strava/callback`);
  stravaAuthUrl.searchParams.set('response_type', 'code');
  stravaAuthUrl.searchParams.set('approval_prompt', 'auto');
  stravaAuthUrl.searchParams.set('scope', 'activity:read_all');
  // Pass through MCP client params via state
  stravaAuthUrl.searchParams.set('state', JSON.stringify({ client_id, redirect_uri, state }));

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Connect Strava to Claude</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: system-ui, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 24px; text-align: center; }
        h1 { font-size: 1.4rem; margin-bottom: 8px; }
        p { color: #666; margin-bottom: 32px; }
        a.btn {
          display: inline-block; background: #FC4C02; color: white;
          padding: 14px 28px; border-radius: 8px; text-decoration: none;
          font-weight: 600; font-size: 1rem;
        }
        a.btn:hover { background: #e04400; }
      </style>
    </head>
    <body>
      <h1>Connect Strava to Claude</h1>
      <p>Authorize Claude to read your Strava training data.</p>
      <a class="btn" href="${stravaAuthUrl.toString()}">Connect with Strava</a>
    </body>
    </html>
  `);
});

// ── Strava OAuth callback ─────────────────────────────────────────────────────

app.get('/strava/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Strava authorization denied: ${error}`);

  let mcpState;
  try { mcpState = JSON.parse(state); } catch { return res.status(400).send('Invalid state'); }

  // Exchange Strava auth code for tokens
  const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return res.status(500).send('Failed to get Strava token');

  const athleteId = String(tokenData.athlete.id);
  upsertStravaUser({
    athleteId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_at,
    scope: 'activity:read_all',
  });

  // Issue MCP auth code and redirect back to Claude
  const authCode = createAuthCode({
    clientId: mcpState.client_id,
    athleteId,
    redirectUri: mcpState.redirect_uri,
  });

  const redirect = new URL(mcpState.redirect_uri);
  redirect.searchParams.set('code', authCode);
  if (mcpState.state) redirect.searchParams.set('state', mcpState.state);
  res.redirect(redirect.toString());
});

// ── Token endpoint ────────────────────────────────────────────────────────────

app.post('/oauth/token', (req, res) => {
  const { grant_type, code, client_id } = req.body;
  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });

  const row = consumeAuthCode(code);
  if (!row) return res.status(400).json({ error: 'invalid_grant' });
  if (row.client_id !== client_id) return res.status(400).json({ error: 'invalid_client' });

  const accessToken = createAccessToken({ clientId: client_id, athleteId: row.athlete_id });
  res.json({ access_token: accessToken, token_type: 'Bearer' });
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────

app.post('/mcp', requireAuth, async (req, res) => {
  const server = createMCPServer(req.athleteId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => { transport.close(); server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, 'localhost', () => {
  console.log(`claude-strava MCP server listening on localhost:${PORT}`);
});
