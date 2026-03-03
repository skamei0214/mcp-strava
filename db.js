import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { join } from 'path';

const db = new Database(join(process.env.DATA_DIR || '.', 'claude-strava.db'));

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id          TEXT PRIMARY KEY,
    secret      TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,   -- JSON array
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strava_users (
    athlete_id    TEXT PRIMARY KEY,
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    scope         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_codes (
    code        TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    athlete_id  TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_tokens (
    token       TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    athlete_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);
const token = (bytes = 32) => randomBytes(bytes).toString('hex');

// ── Clients ───────────────────────────────────────────────────────────────────

export function registerClient({ redirectUris }) {
  const id = token(16);
  const secret = token(32);
  db.prepare(`
    INSERT INTO clients (id, secret, redirect_uris, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, secret, JSON.stringify(redirectUris), now());
  return { id, secret };
}

export function getClient(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
}

// ── Strava users ──────────────────────────────────────────────────────────────

export function upsertStravaUser({ athleteId, accessToken, refreshToken, expiresAt, scope }) {
  db.prepare(`
    INSERT INTO strava_users (athlete_id, access_token, refresh_token, expires_at, scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(athlete_id) DO UPDATE SET
      access_token  = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at    = excluded.expires_at,
      scope         = excluded.scope,
      updated_at    = excluded.updated_at
  `).run(athleteId, accessToken, refreshToken, expiresAt, scope, now(), now());
}

export function getStravaUser(athleteId) {
  return db.prepare('SELECT * FROM strava_users WHERE athlete_id = ?').get(athleteId);
}

export function updateStravaTokens(athleteId, { accessToken, refreshToken, expiresAt }) {
  db.prepare(`
    UPDATE strava_users SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
    WHERE athlete_id = ?
  `).run(accessToken, refreshToken, expiresAt, now(), athleteId);
}

// ── Auth codes ────────────────────────────────────────────────────────────────

export function createAuthCode({ clientId, athleteId, redirectUri }) {
  const code = token(24);
  db.prepare(`
    INSERT INTO auth_codes (code, client_id, athlete_id, redirect_uri, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(code, clientId, athleteId, redirectUri, now() + 300, now()); // 5 min expiry
  return code;
}

export function consumeAuthCode(code) {
  const row = db.prepare('SELECT * FROM auth_codes WHERE code = ? AND expires_at > ?').get(code, now());
  if (!row) return null;
  db.prepare('DELETE FROM auth_codes WHERE code = ?').run(code);
  return row;
}

// ── Access tokens ─────────────────────────────────────────────────────────────

export function createAccessToken({ clientId, athleteId }) {
  const t = token(32);
  db.prepare(`
    INSERT INTO access_tokens (token, client_id, athlete_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(t, clientId, athleteId, now());
  return t;
}

export function getAthleteIdFromToken(t) {
  const row = db.prepare('SELECT athlete_id FROM access_tokens WHERE token = ?').get(t);
  return row?.athlete_id ?? null;
}
