const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function initDb(customPath) {
  const dbPath = customPath || path.join(__dirname, 'data', 'thriftly.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                    TEXT PRIMARY KEY,
      email                 TEXT NOT NULL UNIQUE,
      password_hash         TEXT NOT NULL,
      email_verified        INTEGER NOT NULL DEFAULT 0,
      consent_version       TEXT,
      consent_at            INTEGER,
      gemini_key_enc        TEXT,
      gemini_key_valid      INTEGER NOT NULL DEFAULT 0,
      gemini_key_updated_at INTEGER,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      analysis    TEXT NOT NULL,
      thumb       TEXT,
      listings    TEXT NOT NULL DEFAULT '{}',
      selected    TEXT NOT NULL DEFAULT '[]',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
  `);
  // Safe no-op migrations for databases created before these columns existed.
  try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN consent_version TEXT'); } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN consent_at INTEGER'); } catch (_) { /* already exists */ }
  return db;
}

// ---------- users ----------
function createUser(db, { id, email, passwordHash, consentVersion, consentAt }) {
  db.prepare(`
    INSERT INTO users (id, email, password_hash, consent_version, consent_at, gemini_key_valid, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(id, email, passwordHash, consentVersion || null, consentAt || null, Date.now());
  return getUserById(db, id);
}

function getUserByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
}

function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function deleteUserRow(db, userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.email_verified,
    policyVersion: user.consent_version,
    policyAcceptedAt: user.consent_at,
    geminiKeyConnected: !!user.gemini_key_enc,
    geminiKeyValid: !!user.gemini_key_valid,
    geminiKeyUpdatedAt: user.gemini_key_updated_at,
  };
}

function markUserVerified(db, userId) {
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
}

function setUserGeminiKey(db, userId, encryptedKey) {
  db.prepare('UPDATE users SET gemini_key_enc = ?, gemini_key_valid = 1, gemini_key_updated_at = ? WHERE id = ?')
    .run(encryptedKey, Date.now(), userId);
}

function clearUserGeminiKey(db, userId) {
  db.prepare('UPDATE users SET gemini_key_enc = NULL, gemini_key_valid = 0, gemini_key_updated_at = ? WHERE id = ?')
    .run(Date.now(), userId);
}

// ---------- sessions ----------
function createSession(db, { token, userId, expiresAt }) {
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, Date.now(), expiresAt);
}

function getSession(db, token) {
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function cleanupExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

// ---------- email verification tokens ----------
function createEmailVerification(db, { token, userId, expiresAt }) {
  db.prepare('INSERT INTO email_verifications (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, Date.now(), expiresAt);
}

function getEmailVerification(db, token) {
  return db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token) || null;
}

function deleteEmailVerificationsForUser(db, userId) {
  db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
}

function cleanupExpiredVerifications(db) {
  db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(Date.now());
}

// ---------- password reset tokens ----------
function createPasswordReset(db, { token, userId, expiresAt }) {
  db.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, Date.now(), expiresAt);
}

function getPasswordReset(db, token) {
  return db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token) || null;
}

function deletePasswordResetsForUser(db, userId) {
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
}

function cleanupExpiredPasswordResets(db) {
  db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
}

function setUserPasswordHash(db, userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

// Records acceptance of a policy version (used by the re-consent prompt when the
// policy moves on after an account was created).
function setUserConsent(db, userId, version, at) {
  db.prepare('UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?').run(version, at, userId);
}

function deleteSessionsForUser(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------- periodic cleanup ----------
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

// One housekeeping pass: purge expired sessions and verification tokens.
function runCleanup(db) {
  try {
    const sessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    const verifications = db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(Date.now());
    const resets = db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
    if (sessions.changes || verifications.changes || resets.changes) {
      console.log(`[cleanup] removed ${sessions.changes} expired session(s), ${verifications.changes} expired verification token(s), ${resets.changes} expired reset token(s)`);
    }
  } catch (err) {
    console.error('[cleanup] failed:', err.message);
  }
}

// Hourly housekeeping timer. unref()'d so it never keeps the process alive on its own.
function startCleanupLoop(db, intervalMs = CLEANUP_INTERVAL_MS) {
  return setInterval(() => runCleanup(db), intervalMs).unref();
}

// ---------- drafts (always scoped to a user) ----------
function rowToDraft(row) {
  if (!row) return null;
  return {
    id: row.id,
    analysis: JSON.parse(row.analysis),
    thumb: row.thumb,
    listings: JSON.parse(row.listings),
    selected: JSON.parse(row.selected),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listDrafts(db, userId) {
  return db.prepare('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map(rowToDraft);
}

function getDraft(db, userId, id) {
  return rowToDraft(db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(id, userId));
}

function createDraft(db, userId, { analysis, thumb, selected }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = Date.now();
  db.prepare(`
    INSERT INTO drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at)
    VALUES (@id, @user_id, @analysis, @thumb, @listings, @selected, @created_at, @updated_at)
  `).run({
    id, user_id: userId,
    analysis: JSON.stringify(analysis),
    thumb: thumb || null,
    listings: JSON.stringify({}),
    selected: JSON.stringify(selected || []),
    created_at: now, updated_at: now,
  });
  return getDraft(db, userId, id);
}

function updateDraft(db, userId, id, patch) {
  const existing = getDraft(db, userId, id);
  if (!existing) return null;

  const mergedListings = { ...existing.listings };
  if (patch.listings) {
    for (const [platform, fields] of Object.entries(patch.listings)) {
      mergedListings[platform] = { ...(mergedListings[platform] || {}), ...fields };
    }
  }

  const merged = {
    id, user_id: userId,
    analysis: JSON.stringify(patch.analysis !== undefined ? patch.analysis : existing.analysis),
    thumb: patch.thumb !== undefined ? patch.thumb : existing.thumb,
    listings: JSON.stringify(mergedListings),
    selected: JSON.stringify(patch.selected !== undefined ? patch.selected : existing.selected),
    updated_at: Date.now(),
  };
  db.prepare(`
    UPDATE drafts SET analysis=@analysis, thumb=@thumb, listings=@listings, selected=@selected, updated_at=@updated_at
    WHERE id=@id AND user_id=@user_id
  `).run(merged);
  return getDraft(db, userId, id);
}

function deleteDraft(db, userId, id) {
  db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(id, userId);
}

function clearDrafts(db, userId) {
  db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
}

module.exports = {
  initDb,
  createUser, getUserByEmail, getUserById, publicUser, markUserVerified, setUserGeminiKey, clearUserGeminiKey, deleteUserRow,
  createSession, getSession, deleteSession, cleanupExpiredSessions, runCleanup, startCleanupLoop, CLEANUP_INTERVAL_MS,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  createPasswordReset, getPasswordReset, deletePasswordResetsForUser, cleanupExpiredPasswordResets,
  setUserPasswordHash, setUserConsent, deleteSessionsForUser,
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts,
};
