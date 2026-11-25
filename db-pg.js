'use strict';
// Postgres implementation of the Thriftly data layer (Supabase).
//
// Every function is async and mirrors the SQLite behaviour in db.js one-for-one:
// epoch-millisecond timestamps stay bigint, JSON columns are jsonb, and the
// caller (server.js) always awaits. db.js picks this backend when DATABASE_URL
// is set; SQLite remains the default for local development and tests.
const { Pool } = require('pg');

function open(connectionString) {
  const local = /(^|@)(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(connectionString) || /sslmode=disable/.test(connectionString);
  const schema = /^[a-z0-9_]+$/.test(process.env.PG_SCHEMA || '') ? process.env.PG_SCHEMA : null;
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase requires TLS. Local Postgres and sslmode=disable skip it.
    ssl: local ? false : { rejectUnauthorized: false },
    // Used by tests/pg.mjs to keep a whole run inside a throwaway schema.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', (err) => console.error('[pg] idle client error:', err.message));
  return {
    kind: 'pg',
    pool,
    close: () => pool.end(),
  };
}

async function one(db, sql, params) {
  const result = await db.pool.query(sql, params);
  return result.rows[0] || null;
}

// ---------- users ----------
async function createUser(db, { id, email, passwordHash, consentVersion, consentAt }) {
  await db.pool.query(
    `insert into users (id, email, password_hash, email_verified, consent_version, consent_at, gemini_key_valid, created_at)
     values ($1, $2, $3, false, $4, $5, false, $6)`,
    [id, email, passwordHash, consentVersion || null, consentAt || null, Date.now()],
  );
  return getUserById(db, id);
}

async function getUserByEmail(db, email) {
  return one(db, 'select * from users where email = $1', [email]);
}

async function getUserById(db, id) {
  return one(db, 'select * from users where id = $1', [id]);
}

async function deleteUserRow(db, userId) {
  await db.pool.query('delete from users where id = $1', [userId]);
}

async function markUserVerified(db, userId) {
  await db.pool.query('update users set email_verified = true where id = $1', [userId]);
}

async function setUserGeminiKey(db, userId, encryptedKey) {
  await db.pool.query(
    'update users set gemini_key_enc = $1, gemini_key_valid = true, gemini_key_updated_at = $2 where id = $3',
    [encryptedKey, Date.now(), userId],
  );
}

async function clearUserGeminiKey(db, userId) {
  await db.pool.query(
    'update users set gemini_key_enc = null, gemini_key_valid = false, gemini_key_updated_at = $1 where id = $2',
    [Date.now(), userId],
  );
}

async function setUserPasswordHash(db, userId, passwordHash) {
  await db.pool.query('update users set password_hash = $1 where id = $2', [passwordHash, userId]);
}

async function setUserConsent(db, userId, version, at) {
  await db.pool.query('update users set consent_version = $1, consent_at = $2 where id = $3', [version, at, userId]);
}

// ---------- sessions ----------
async function createSession(db, { token, userId, expiresAt }) {
  await db.pool.query(
    'insert into sessions (token, user_id, created_at, expires_at) values ($1, $2, $3, $4)',
    [token, userId, Date.now(), expiresAt],
  );
}

async function getSession(db, token) {
  return one(db, 'select * from sessions where token = $1', [token]);
}

// Session + user in one round trip. Every authenticated request used to make
// two: look up the session, then the user. The join also enforces expiry in SQL.
async function getSessionUser(db, token) {
  return one(db,
    'select u.* from sessions s join users u on u.id = s.user_id where s.token = $1 and s.expires_at >= $2',
    [token, Date.now()]);
}

async function deleteSession(db, token) {
  await db.pool.query('delete from sessions where token = $1', [token]);
}

async function cleanupExpiredSessions(db) {
  await db.pool.query('delete from sessions where expires_at < $1', [Date.now()]);
}

async function deleteSessionsForUser(db, userId) {
  await db.pool.query('delete from sessions where user_id = $1', [userId]);
}

// ---------- email verification tokens ----------
async function createEmailVerification(db, { token, userId, expiresAt }) {
  await db.pool.query(
    'insert into email_verifications (token, user_id, created_at, expires_at) values ($1, $2, $3, $4)',
    [token, userId, Date.now(), expiresAt],
  );
}

async function getEmailVerification(db, token) {
  return one(db, 'select * from email_verifications where token = $1', [token]);
}

async function deleteEmailVerificationsForUser(db, userId) {
  await db.pool.query('delete from email_verifications where user_id = $1', [userId]);
}

async function cleanupExpiredVerifications(db) {
  await db.pool.query('delete from email_verifications where expires_at < $1', [Date.now()]);
}

// ---------- password reset tokens ----------
async function createPasswordReset(db, { token, userId, expiresAt }) {
  await db.pool.query(
    'insert into password_resets (token, user_id, created_at, expires_at) values ($1, $2, $3, $4)',
    [token, userId, Date.now(), expiresAt],
  );
}

async function getPasswordReset(db, token) {
  return one(db, 'select * from password_resets where token = $1', [token]);
}

async function deletePasswordResetsForUser(db, userId) {
  await db.pool.query('delete from password_resets where user_id = $1', [userId]);
}

async function cleanupExpiredPasswordResets(db) {
  await db.pool.query('delete from password_resets where expires_at < $1', [Date.now()]);
}

// ---------- periodic cleanup ----------
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function runCleanup(db) {
  try {
    const now = Date.now();
    const sessions = await db.pool.query('delete from sessions where expires_at < $1', [now]);
    const verifications = await db.pool.query('delete from email_verifications where expires_at < $1', [now]);
    const resets = await db.pool.query('delete from password_resets where expires_at < $1', [now]);
    if (sessions.rowCount || verifications.rowCount || resets.rowCount) {
      console.log(`[cleanup] removed ${sessions.rowCount} expired session(s), ${verifications.rowCount} expired verification token(s), ${resets.rowCount} expired reset token(s)`);
    }
  } catch (err) {
    console.error('[cleanup] failed:', err.message);
  }
}

function startCleanupLoop(db, intervalMs = CLEANUP_INTERVAL_MS) {
  return setInterval(() => { runCleanup(db); }, intervalMs).unref();
}

// ---------- drafts ----------
function rowToDraft(row) {
  if (!row) return null;
  const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
  return {
    id: row.id,
    analysis: parse(row.analysis),
    thumb: row.thumb,
    listings: parse(row.listings),
    selected: parse(row.selected),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function listDrafts(db, userId) {
  const result = await db.pool.query('select * from drafts where user_id = $1 order by updated_at desc', [userId]);
  return result.rows.map(rowToDraft);
}

async function getDraft(db, userId, id) {
  return rowToDraft(await one(db, 'select * from drafts where id = $1 and user_id = $2', [id, userId]));
}

async function createDraft(db, userId, { analysis, thumb, selected }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = Date.now();
  const row = await one(
    db,
    `insert into drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
     returning *`,
    [id, userId, JSON.stringify(analysis), thumb || null, JSON.stringify({}), JSON.stringify(selected || []), now, now],
  );
  return rowToDraft(row);
}

async function updateDraft(db, userId, id, patch) {
  const existing = await getDraft(db, userId, id);
  if (!existing) return null;

  const mergedListings = { ...existing.listings };
  if (patch.listings) {
    for (const [platform, fields] of Object.entries(patch.listings)) {
      mergedListings[platform] = { ...(mergedListings[platform] || {}), ...fields };
    }
  }

  const row = await one(
    db,
    `update drafts
        set analysis = $1::jsonb, thumb = $2, listings = $3::jsonb, selected = $4::jsonb, updated_at = $5
      where id = $6 and user_id = $7
      returning *`,
    [
      JSON.stringify(patch.analysis !== undefined ? patch.analysis : existing.analysis),
      patch.thumb !== undefined ? patch.thumb : existing.thumb,
      JSON.stringify(mergedListings),
      JSON.stringify(patch.selected !== undefined ? patch.selected : existing.selected),
      Date.now(), id, userId,
    ],
  );
  return rowToDraft(row);
}

async function deleteDraft(db, userId, id) {
  await db.pool.query('delete from drafts where id = $1 and user_id = $2', [id, userId]);
}

async function clearDrafts(db, userId) {
  await db.pool.query('delete from drafts where user_id = $1', [userId]);
}

module.exports = {
  open,
  createUser, getUserByEmail, getUserById, deleteUserRow,
  markUserVerified, setUserGeminiKey, clearUserGeminiKey,
  setUserPasswordHash, setUserConsent,
  createSession, getSession, getSessionUser, deleteSession, cleanupExpiredSessions, deleteSessionsForUser,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  createPasswordReset, getPasswordReset, deletePasswordResetsForUser, cleanupExpiredPasswordResets,
  runCleanup, startCleanupLoop, CLEANUP_INTERVAL_MS,
  rowToDraft, listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts,
};
