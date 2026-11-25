'use strict';
// Data layer facade.
//
// DATABASE_URL selects the async Postgres backend (db-pg.js, Supabase). Without
// it the app uses SQLite exactly as before, which is what local development and
// the smoke tests run on. Every exported data function is async in both modes,
// so server.js always awaits.
//
// Tests set DB_FORCE_SQLITE=1 to make sure a developer's .env DATABASE_URL can
// never point the test suite at a real database.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const pg = require('./db-pg');

function openSqlite(customPath) {
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
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_expires ON email_verifications(expires_at);
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON password_resets(expires_at);
  `);
  // Safe no-op migrations for databases created before these columns existed.
  try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0'); } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN consent_version TEXT'); } catch (_) { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN consent_at INTEGER'); } catch (_) { /* already exists */ }
  db.kind = 'sqlite';
  return db;
}

function initDb(customPath) {
  if (process.env.DATABASE_URL && !process.env.DB_FORCE_SQLITE) {
    return pg.open(process.env.DATABASE_URL);
  }
  return openSqlite(customPath);
}

function backend(db) {
  return db.kind === 'pg' ? pg : sqlite;
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

// ---------- SQLite backend ----------
const sqlite = {
  async createUser(db, { id, email, passwordHash, consentVersion, consentAt }) {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, consent_version, consent_at, gemini_key_valid, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(id, email, passwordHash, consentVersion || null, consentAt || null, Date.now());
    return this.getUserById(db, id);
  },

  async getUserByEmail(db, email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  },

  async getUserById(db, id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  },

  async deleteUserRow(db, userId) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  },

  async markUserVerified(db, userId) {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(userId);
  },

  async setUserGeminiKey(db, userId, encryptedKey) {
    db.prepare('UPDATE users SET gemini_key_enc = ?, gemini_key_valid = 1, gemini_key_updated_at = ? WHERE id = ?')
      .run(encryptedKey, Date.now(), userId);
  },

  async clearUserGeminiKey(db, userId) {
    db.prepare('UPDATE users SET gemini_key_enc = NULL, gemini_key_valid = 0, gemini_key_updated_at = ? WHERE id = ?')
      .run(Date.now(), userId);
  },

  async setUserPasswordHash(db, userId, passwordHash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  },

  async setUserConsent(db, userId, version, at) {
    db.prepare('UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?').run(version, at, userId);
  },

  async createSession(db, { token, userId, expiresAt }) {
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, Date.now(), expiresAt);
  },

  async getSession(db, token) {
    return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) || null;
  },

  // Session + user in one query, mirroring db-pg's join; expired sessions are
  // filtered in SQL so callers cannot accidentally accept one.
  async getSessionUser(db, token) {
    return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token = ? AND s.expires_at >= ?`).get(token, Date.now()) || null;
  },

  async deleteSession(db, token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },

  async cleanupExpiredSessions(db) {
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  },

  async deleteSessionsForUser(db, userId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  },

  async createEmailVerification(db, { token, userId, expiresAt }) {
    db.prepare('INSERT INTO email_verifications (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, Date.now(), expiresAt);
  },

  async getEmailVerification(db, token) {
    return db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token) || null;
  },

  async deleteEmailVerificationsForUser(db, userId) {
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(userId);
  },

  async cleanupExpiredVerifications(db) {
    db.prepare('DELETE FROM email_verifications WHERE expires_at < ?').run(Date.now());
  },

  async createPasswordReset(db, { token, userId, expiresAt }) {
    db.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, userId, Date.now(), expiresAt);
  },

  async getPasswordReset(db, token) {
    return db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token) || null;
  },

  async deletePasswordResetsForUser(db, userId) {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(userId);
  },

  async cleanupExpiredPasswordResets(db) {
    db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(Date.now());
  },

  async runCleanup(db) {
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
  },

  startCleanupLoop(db, intervalMs = 60 * 60 * 1000) {
    return setInterval(() => { this.runCleanup(db); }, intervalMs).unref();
  },

  rowToDraft(row) {
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
  },

  async listDrafts(db, userId) {
    return db.prepare('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map(this.rowToDraft);
  },

  async getDraft(db, userId, id) {
    return this.rowToDraft(db.prepare('SELECT * FROM drafts WHERE id = ? AND user_id = ?').get(id, userId));
  },

  async createDraft(db, userId, { analysis, thumb, selected }) {
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
    return this.getDraft(db, userId, id);
  },

  async updateDraft(db, userId, id, patch) {
    const existing = await this.getDraft(db, userId, id);
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
    return this.getDraft(db, userId, id);
  },

  async deleteDraft(db, userId, id) {
    db.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').run(id, userId);
  },

  async clearDrafts(db, userId) {
    db.prepare('DELETE FROM drafts WHERE user_id = ?').run(userId);
  },
};

// ---------- facade ----------
// Cheap liveness check against whichever backend is in use (/api/ready).
async function ping(db) {
  if (db.kind === 'pg') { await db.pool.query('select 1'); return; }
  db.prepare('SELECT 1').get();
}

async function createUser(db, args) { return backend(db).createUser(db, args); }
async function getUserByEmail(db, email) { return backend(db).getUserByEmail(db, email); }
async function getUserById(db, id) { return backend(db).getUserById(db, id); }
async function deleteUserRow(db, userId) { return backend(db).deleteUserRow(db, userId); }
async function markUserVerified(db, userId) { return backend(db).markUserVerified(db, userId); }
async function setUserGeminiKey(db, userId, key) { return backend(db).setUserGeminiKey(db, userId, key); }
async function clearUserGeminiKey(db, userId) { return backend(db).clearUserGeminiKey(db, userId); }
async function setUserPasswordHash(db, userId, hash) { return backend(db).setUserPasswordHash(db, userId, hash); }
async function setUserConsent(db, userId, version, at) { return backend(db).setUserConsent(db, userId, version, at); }
async function createSession(db, args) { return backend(db).createSession(db, args); }
async function getSession(db, token) { return backend(db).getSession(db, token); }
async function getSessionUser(db, token) { return backend(db).getSessionUser(db, token); }
async function deleteSession(db, token) { return backend(db).deleteSession(db, token); }
async function cleanupExpiredSessions(db) { return backend(db).cleanupExpiredSessions(db); }
async function deleteSessionsForUser(db, userId) { return backend(db).deleteSessionsForUser(db, userId); }
async function createEmailVerification(db, args) { return backend(db).createEmailVerification(db, args); }
async function getEmailVerification(db, token) { return backend(db).getEmailVerification(db, token); }
async function deleteEmailVerificationsForUser(db, userId) { return backend(db).deleteEmailVerificationsForUser(db, userId); }
async function cleanupExpiredVerifications(db) { return backend(db).cleanupExpiredVerifications(db); }
async function createPasswordReset(db, args) { return backend(db).createPasswordReset(db, args); }
async function getPasswordReset(db, token) { return backend(db).getPasswordReset(db, token); }
async function deletePasswordResetsForUser(db, userId) { return backend(db).deletePasswordResetsForUser(db, userId); }
async function cleanupExpiredPasswordResets(db) { return backend(db).cleanupExpiredPasswordResets(db); }
async function runCleanup(db) { return backend(db).runCleanup(db); }
function startCleanupLoop(db, intervalMs) { return backend(db).startCleanupLoop(db, intervalMs); }
async function listDrafts(db, userId) { return backend(db).listDrafts(db, userId); }
async function getDraft(db, userId, id) { return backend(db).getDraft(db, userId, id); }
async function createDraft(db, userId, args) { return backend(db).createDraft(db, userId, args); }
async function updateDraft(db, userId, id, patch) { return backend(db).updateDraft(db, userId, id, patch); }
async function deleteDraft(db, userId, id) { return backend(db).deleteDraft(db, userId, id); }
async function clearDrafts(db, userId) { return backend(db).clearDrafts(db, userId); }

module.exports = {
  initDb, publicUser, ping,
  createUser, getUserByEmail, getUserById, markUserVerified, setUserGeminiKey, clearUserGeminiKey, deleteUserRow,
  createSession, getSession, getSessionUser, deleteSession, cleanupExpiredSessions, runCleanup, startCleanupLoop, CLEANUP_INTERVAL_MS: 60 * 60 * 1000,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  createPasswordReset, getPasswordReset, deletePasswordResetsForUser, cleanupExpiredPasswordResets,
  setUserPasswordHash, setUserConsent, deleteSessionsForUser,
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts,
};
