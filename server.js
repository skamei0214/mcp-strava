import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  registerClient, getClient,
  upsertStravaUser, getStravaUser, updateStravaTokens,
  createAuthCode, consumeAuthCode,
  createAccessToken, getAthleteIdFromToken,
  createPendingSetup, getPendingSetup, deletePendingSetup,
  createPendingConfirmation, getPendingConfirmation, deletePendingConfirmation,
  getStoredActivities, upsertActivitySync, deleteActivitySync, setLastSyncAt,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.BASE_URL;   // e.g. https://187-77-203-66.sslip.io
const PORT     = process.env.PORT || 3001;

// Strava app credentials — used only as a fallback for users who haven't
// supplied their own. With Option A, each user supplies their own credentials.
const APP_STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const APP_STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

// ── Strava API ────────────────────────────────────────────────────────────────

async function refreshStravaTokenIfNeeded(user) {
  if (Math.floor(Date.now() / 1000) < user.expires_at - 60) return user.access_token;
  // Use the user's own credentials if stored, otherwise fall back to app credentials
  const clientId     = user.strava_client_id     || APP_STRAVA_CLIENT_ID;
  const clientSecret = user.strava_client_secret || APP_STRAVA_CLIENT_SECRET;
  const res = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: user.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
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

// Hash the fields available from the list API — used to detect edits
function activityHash(a) {
  return [a.sport_type, a.distance, a.moving_time, a.elapsed_time, a.start_date_local, a.name].join('|');
}

// Fetch every activity whose start_date is after `afterTs` (Unix), paginating as needed
async function fetchAllActivitiesSince(token, afterTs) {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await stravaGet(token, `/athlete/activities?after=${afterTs}&per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// Fetch description + laps for a small batch of activities (used on incremental sync only)
async function enrichActivities(token, activities) {
  const enriched = [];
  for (const a of activities) {
    const [detail, laps] = await Promise.all([
      stravaGet(token, `/activities/${a.id}`),
      stravaGet(token, `/activities/${a.id}/laps`),
    ]);
    a.description = detail.description;
    enriched.push({ activity: a, laps });
  }
  return enriched;
}

async function fetchStravaActivities(athleteId) {
  const user = getStravaUser(athleteId);
  if (!user) throw new Error('Strava account not connected');
  const token = await refreshStravaTokenIfNeeded(user);
  const nowTs = Math.floor(Date.now() / 1000);

  // ── First sync ───────────────────────────────────────────────────────────────
  if (!user.last_sync_at) {
    const since = nowTs - 730 * 24 * 3600;  // 2 years back
    const activities = await fetchAllActivitiesSince(token, since);

    const sinceDate = new Date(since * 1000).toISOString().slice(0, 10);
    const toDate    = new Date(nowTs * 1000).toISOString().slice(0, 10);
    const lines = [
      `INITIAL SYNC — ${activities.length} activities from ${sinceDate} to ${toDate}.`,
      `Commit every activity below to your memory so your training history is available in future conversations.`,
      `Do not call this tool again in this conversation — all data through ${toDate} is now included.\n`,
    ];
    for (const a of activities) {
      lines.push(formatActivity(a, []));  // list API only — no detail/laps calls to stay within rate limits
      upsertActivitySync(athleteId, a.id, activityHash(a), a.start_date_local.slice(0, 10));
    }
    setLastSyncAt(athleteId, nowTs);
    return lines.join('\n');
  }

  // ── Incremental sync ─────────────────────────────────────────────────────────
  // New: activities whose start_date is after the last sync timestamp
  const newRaw = await fetchAllActivitiesSince(token, user.last_sync_at);

  // Edits + removals: re-fetch the past 60 days and compare against stored state
  const windowTs = nowTs - 60 * 24 * 3600;
  const recentRaw = await fetchAllActivitiesSince(token, windowTs);
  const recentIds = new Set(recentRaw.map(a => a.id));

  const stored = getStoredActivities(athleteId);
  const storedMap = new Map(stored.map(s => [s.activity_id, s]));

  const editedRaw = recentRaw.filter(a => {
    const s = storedMap.get(a.id);
    return s && s.data_hash !== activityHash(a);
  });

  const windowDate = new Date(windowTs * 1000).toISOString().slice(0, 10);
  const removed = stored.filter(s => s.start_date >= windowDate && !recentIds.has(s.activity_id));

  const addedRaw = newRaw.filter(a => !storedMap.has(a.id));

  const syncedDate = new Date(user.last_sync_at * 1000).toISOString().slice(0, 10);
  const oldest = stored.reduce((min, s) => s.start_date < min ? s.start_date : min, stored[0]?.start_date ?? '');

  if (addedRaw.length === 0 && editedRaw.length === 0 && removed.length === 0) {
    setLastSyncAt(athleteId, nowTs);
    return [
      `NO CHANGES — No new, edited, or removed activities since last sync (${syncedDate}).`,
      `Your memory is up to date. Data in memory covers ${oldest} to ${syncedDate}.`,
      `Do not call this tool again in this conversation.`,
    ].join('\n');
  }

  const lines = ['ACTIVITY DELTA — Update your memory with the following changes:\n'];

  if (addedRaw.length) {
    const enriched = await enrichActivities(token, addedRaw);
    lines.push(`── NEW (${enriched.length}) — Add to memory:`);
    for (const { activity, laps } of enriched) {
      lines.push(formatActivity(activity, laps));
      upsertActivitySync(athleteId, activity.id, activityHash(activity), activity.start_date_local.slice(0, 10));
    }
  }

  if (editedRaw.length) {
    const enriched = await enrichActivities(token, editedRaw);
    lines.push(`\n── EDITED (${enriched.length}) — Update in memory:`);
    for (const { activity, laps } of enriched) {
      lines.push(formatActivity(activity, laps));
      upsertActivitySync(athleteId, activity.id, activityHash(activity), activity.start_date_local.slice(0, 10));
    }
  }

  if (removed.length) {
    lines.push(`\n── REMOVED (${removed.length}) — Delete from memory:`);
    for (const r of removed) {
      lines.push(`Activity ${r.activity_id} on ${r.start_date}`);
      deleteActivitySync(athleteId, r.activity_id);
    }
  }

  setLastSyncAt(athleteId, nowTs);
  const updatedStored = getStoredActivities(athleteId);
  const updatedOldest = updatedStored.reduce((min, s) => s.start_date < min ? s.start_date : min, updatedStored[0]?.start_date ?? '');
  const todayDate = new Date(nowTs * 1000).toISOString().slice(0, 10);
  lines.push(`\nMemory now covers ${updatedOldest} to ${todayDate}. Do not call this tool again in this conversation.`);
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
    { name: 'mcp-strava', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'get_strava_activities',
      description: [
        'Sync Strava training activities.',
        'First call returns all activities from the past year — commit every activity to memory so your training history is available across conversations.',
        'Subsequent calls return only changes since the last sync (new, edited, or removed activities) — update memory accordingly.',
        'Always call this at the start of a conversation to load fresh data.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'get_strava_activities') throw new Error(`Unknown tool: ${request.params.name}`);
    const data = await fetchStravaActivities(athleteId);
    return { content: [{ type: 'text', text: data }] };
  });

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — Claude.ai makes cross-origin requests from the browser.
// Without these headers the OPTIONS preflight is blocked, the actual GET /mcp
// never reaches the server, and Claude.ai never sees the 401 that triggers OAuth.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id');
  res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(join(__dirname, 'public')));

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

// ── Authorization endpoint — GET (show form or fast-track returning users) ────

app.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  if (!client_id || !redirect_uri) return res.status(400).send('Missing client_id or redirect_uri');

  // Always show the credential form — never skip based on browser state.
  // Each Claude account must authenticate independently with its own Strava credentials.
  const baseHost = new URL(BASE_URL).hostname;
  const esc = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Strava to Claude</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #1a1a1a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 16px; padding: 36px 32px; max-width: 500px; width: 100%; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    .logo { font-size: 2rem; margin-bottom: 12px; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 8px; }
    .intro { color: #666; font-size: 0.9rem; line-height: 1.5; margin-bottom: 28px; }
    .step { border: 1px solid #eee; border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
    .step-num { display: inline-block; background: #FC4C02; color: white; border-radius: 50%; width: 22px; height: 22px; text-align: center; font-size: 0.75rem; font-weight: 700; line-height: 22px; margin-right: 8px; }
    .step h3 { display: inline; font-size: 0.95rem; color: #222; }
    .step-body { margin-top: 10px; color: #555; font-size: 0.88rem; line-height: 1.6; }
    .step-body a { color: #FC4C02; text-decoration: none; font-weight: 600; }
    .copy-box { display: inline-block; background: #f4f4f4; border-radius: 6px; padding: 5px 10px; font-family: monospace; font-size: 0.85rem; margin-top: 6px; cursor: pointer; user-select: all; border: 1px solid #e0e0e0; }
    .divider { border: none; border-top: 1px solid #eee; margin: 24px 0; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: #333; margin-bottom: 6px; }
    input[type=text], input[type=password] { width: 100%; border: 1.5px solid #ddd; border-radius: 8px; padding: 11px 13px; font-size: 0.95rem; transition: border-color 0.15s; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #FC4C02; box-shadow: 0 0 0 3px rgba(252,76,2,0.1); }
    button { width: 100%; background: #FC4C02; color: white; border: none; border-radius: 10px; padding: 14px; font-size: 1rem; font-weight: 700; cursor: pointer; letter-spacing: 0.01em; }
    button:hover { background: #e04400; }
    .hint { color: #888; font-size: 0.8rem; margin-top: 14px; text-align: center; }
    .hint a { color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🏃</div>
    <h1>Connect Strava to Claude</h1>
    <p class="intro">This app uses <strong>your own Strava API credentials</strong>, so your data stays in your control. Setup takes about 2 minutes.</p>

    <div class="step">
      <span class="step-num">1</span><h3>Create a Strava API application</h3>
      <div class="step-body">
        Go to <a href="https://www.strava.com/settings/api" target="_blank">strava.com/settings/api</a> and create a new app (or use an existing one).<br><br>
        Set <strong>Authorization Callback Domain</strong> to:<br>
        <span class="copy-box">${esc(baseHost)}</span>
      </div>
    </div>

    <div class="step">
      <span class="step-num">2</span><h3>Paste your credentials below</h3>
      <div class="step-body">Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> from your Strava app settings page.</div>
    </div>

    <hr class="divider">

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id"    value="${esc(client_id)}">
      <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
      <input type="hidden" name="state"        value="${esc(state)}">

      <label for="sid">Strava Client ID</label>
      <input type="text" id="sid" name="strava_client_id" placeholder="e.g. 12345" required autocomplete="off">

      <label for="ssec">Strava Client Secret</label>
      <input type="password" id="ssec" name="strava_client_secret" placeholder="Paste your client secret" required autocomplete="off">

      <button type="submit">Connect with Strava &rarr;</button>
    </form>

    <p class="hint">Your credentials are stored securely and used only to fetch your activities. <a href="/privacy">Privacy Policy</a></p>
  </div>
</body>
</html>`);
});

// ── Authorization endpoint — POST (process credential form) ──────────────────

app.post('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, strava_client_id, strava_client_secret } = req.body;

  if (!client_id || !redirect_uri) return res.status(400).send('Missing client_id or redirect_uri');
  if (!strava_client_id || !strava_client_secret) return res.status(400).send('Missing Strava credentials');

  // Store everything in pending_setups so the callback can retrieve it
  const setupToken = createPendingSetup({
    mcpClientId: client_id,
    mcpRedirectUri: redirect_uri,
    mcpState: state || null,
    stravaClientId: strava_client_id.trim(),
    stravaClientSecret: strava_client_secret.trim(),
  });

  // Redirect to Strava using the user's own app credentials
  const stravaUrl = new URL('https://www.strava.com/oauth/authorize');
  stravaUrl.searchParams.set('client_id',       strava_client_id.trim());
  stravaUrl.searchParams.set('redirect_uri',    `${BASE_URL}/strava/callback`);
  stravaUrl.searchParams.set('response_type',   'code');
  stravaUrl.searchParams.set('approval_prompt', 'auto');
  stravaUrl.searchParams.set('scope',           'activity:read_all');
  stravaUrl.searchParams.set('state',           setupToken);   // our lookup key

  res.redirect(stravaUrl.toString());
});

// ── Strava OAuth callback ─────────────────────────────────────────────────────

app.get('/strava/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Strava authorization denied: ${error}`);
  if (!code || !state) return res.status(400).send('Missing code or state');

  const setup = getPendingSetup(state);
  if (!setup) return res.status(400).send('Setup session expired or invalid. Please start again.');
  deletePendingSetup(state);

  // Exchange Strava auth code using the user's own credentials
  const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     setup.strava_client_id,
      client_secret: setup.strava_client_secret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error('Strava token exchange failed:', tokenData);
    return res.status(500).send(`Failed to connect Strava: ${tokenData.message || 'Unknown error'}. Check your Client ID and Secret are correct.`);
  }

  const athleteId   = String(tokenData.athlete.id);
  const athleteName = [tokenData.athlete.firstname, tokenData.athlete.lastname].filter(Boolean).join(' ');
  const athletePhoto = tokenData.athlete.profile_medium || tokenData.athlete.profile || null;

  // Persist Strava tokens
  upsertStravaUser({
    athleteId,
    accessToken:         tokenData.access_token,
    refreshToken:        tokenData.refresh_token,
    expiresAt:           tokenData.expires_at,
    scope:               'activity:read_all',
    stravaClientId:      setup.strava_client_id,
    stravaClientSecret:  setup.strava_client_secret,
  });

  // Create a short-lived confirmation record — the MCP auth code is NOT issued
  // until the user sees their name and explicitly clicks "Yes, this is me".
  const confirmToken = createPendingConfirmation({
    mcpClientId:    setup.mcp_client_id,
    mcpRedirectUri: setup.mcp_redirect_uri,
    mcpState:       setup.mcp_state,
    athleteId,
    athleteName,
  });

  const esc = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const photoHtml = athletePhoto
    ? `<img src="${esc(athletePhoto)}" alt="Profile photo" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #eee;">`
    : `<div style="width:72px;height:72px;border-radius:50%;background:#f0f0f0;display:flex;align-items:center;justify-content:center;font-size:2rem;">🏃</div>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Confirm your Strava account</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: white; border-radius: 16px; padding: 40px 32px; max-width: 420px; width: 100%; box-shadow: 0 2px 16px rgba(0,0,0,0.08); text-align: center; }
    .check { font-size: 2.5rem; margin-bottom: 16px; }
    h1 { font-size: 1.3rem; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 28px; }
    .athlete { display: flex; flex-direction: column; align-items: center; gap: 12px; background: #f8f8f8; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .athlete-name { font-size: 1.2rem; font-weight: 700; }
    .athlete-id { color: #999; font-size: 0.8rem; }
    .warning { background: #fff8f0; border: 1px solid #ffd0a0; border-radius: 8px; padding: 12px 16px; color: #b35c00; font-size: 0.85rem; margin-bottom: 24px; text-align: left; }
    button { width: 100%; background: #FC4C02; color: white; border: none; border-radius: 10px; padding: 14px; font-size: 1rem; font-weight: 700; cursor: pointer; margin-bottom: 12px; }
    button:hover { background: #e04400; }
    .restart { display: block; color: #999; font-size: 0.85rem; text-decoration: none; }
    .restart:hover { color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✅</div>
    <h1>Confirm your Strava account</h1>
    <p class="subtitle">Strava authorized the following account. Is this you?</p>

    <div class="athlete">
      ${photoHtml}
      <div class="athlete-name">${esc(athleteName) || 'Unknown Athlete'}</div>
      <div class="athlete-id">Strava ID: ${esc(athleteId)}</div>
    </div>

    <div class="warning">
      ⚠️ Only click confirm if this is <strong>your own</strong> Strava account. Confirming will connect this account to your Claude.
    </div>

    <form method="POST" action="/strava/confirm">
      <input type="hidden" name="confirm_token" value="${esc(confirmToken)}">
      <button type="submit">Yes, this is me — connect my Strava</button>
    </form>
    <a class="restart" href="/oauth/authorize?client_id=${esc(setup.mcp_client_id)}&redirect_uri=${encodeURIComponent(setup.mcp_redirect_uri)}&state=${esc(setup.mcp_state)}">Not you? Start over</a>
  </div>
</body>
</html>`);
});

// ── Strava confirm (finalises connection after identity check) ────────────────

app.post('/strava/confirm', (req, res) => {
  const { confirm_token } = req.body;
  const conf = getPendingConfirmation(confirm_token);
  if (!conf) return res.status(400).send('Confirmation expired. Please close this window and try connecting again from Claude.');
  deletePendingConfirmation(confirm_token);

  const authCode = createAuthCode({
    clientId:    conf.mcp_client_id,
    athleteId:   conf.athlete_id,
    redirectUri: conf.mcp_redirect_uri,
  });

  const redirectUrl = new URL(conf.mcp_redirect_uri);
  redirectUrl.searchParams.set('code', authCode);
  if (conf.mcp_state) redirectUrl.searchParams.set('state', conf.mcp_state);
  res.redirect(redirectUrl.toString());
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

// GET /mcp — Claude.ai tests the URL with a GET during the "Add connector" step.
// Returning 401 with OAuth discovery headers here triggers the OAuth flow immediately,
// so the user doesn't need to disconnect/reconnect after adding the connector.
app.get('/mcp', (req, res) => {
  res.set('WWW-Authenticate', `Bearer realm="${BASE_URL}", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
  res.status(401).json({ error: 'unauthorized' });
});

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
  console.log(`mcp-strava listening on localhost:${PORT}`);
});
