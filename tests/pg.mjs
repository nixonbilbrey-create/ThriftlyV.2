#!/usr/bin/env node
// Postgres data-layer integration test.
//
// Needs DATABASE_URL. Creates a throwaway schema, applies db/schema.sql there,
// exercises the async data layer, then drops the schema. It never touches the
// public tables, so it is safe against the Supabase project.
//
//   DATABASE_URL=... npm run test:pg
//
// CI runs it against a local postgres:17 service (see .github/workflows/ci.yml).
import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.log('pg test: skipped (DATABASE_URL is not set)');
  process.exit(0);
}

// Tests must never inherit a forced-SQLite switch from the developer's shell.
delete process.env.DB_FORCE_SQLITE;

const schema = `thriftly_test_${crypto.randomBytes(4).toString('hex')}`;
const isLocal = /(^|@)(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(DATABASE_URL) || /sslmode=disable/.test(DATABASE_URL);
const clientOptions = {
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
};

async function admin(sql) {
  const client = new Client(clientOptions);
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function main() {
  await admin(`create schema "${schema}"`);
  const ddl = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  const setup = new Client(clientOptions);
  await setup.connect();
  try {
    await setup.query(`set search_path to "${schema}"`);
    await setup.query(ddl);
  } finally {
    await setup.end();
  }

  process.env.PG_SCHEMA = schema;
  // db.js is CommonJS; createRequire gets the full export object (Node's ESM
  // named-export detection only sees part of a large object literal).
  const dbModule = createRequire(import.meta.url)('../db.js');
  const {
    initDb, publicUser,
    createUser, getUserById, getUserByEmail, markUserVerified, setUserGeminiKey, clearUserGeminiKey,
    setUserPasswordHash, setUserConsent, deleteUserRow,
    createSession, getSession, deleteSession, cleanupExpiredSessions, deleteSessionsForUser,
    createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser,
    createPasswordReset, getPasswordReset, deletePasswordResetsForUser,
    listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts, runCleanup,
  } = dbModule;

  const db = initDb();
  assert.equal(db.kind, 'pg', 'DATABASE_URL must select the Postgres backend');

  try {
    const user = await createUser(db, {
      id: 'pg-test-user', email: 'pg-test@thriftly.test', passwordHash: 'hash',
      consentVersion: '2026-11-04', consentAt: 12345,
    });
    assert.equal(user.email, 'pg-test@thriftly.test');
    assert.equal(user.email_verified, false);
    assert.equal(user.gemini_key_valid, false);
    assert.equal(Number(user.created_at) > 0, true);
    assert.equal(publicUser(user).emailVerified, false);

    assert.equal((await getUserByEmail(db, 'pg-test@thriftly.test')).id, user.id);
    assert.equal(await getUserByEmail(db, 'missing@thriftly.test'), null);

    await markUserVerified(db, user.id);
    assert.equal((await getUserById(db, user.id)).email_verified, true);

    await setUserGeminiKey(db, user.id, 'encrypted-key');
    let fresh = await getUserById(db, user.id);
    assert.equal(fresh.gemini_key_valid, true);
    assert.equal(fresh.gemini_key_enc, 'encrypted-key');
    await clearUserGeminiKey(db, user.id);
    fresh = await getUserById(db, user.id);
    assert.equal(fresh.gemini_key_valid, false);
    assert.equal(fresh.gemini_key_enc, null);

    await setUserPasswordHash(db, user.id, 'new-hash');
    await setUserConsent(db, user.id, '2026-12-01', 999);
    fresh = await getUserById(db, user.id);
    assert.equal(fresh.password_hash, 'new-hash');
    assert.equal(fresh.consent_version, '2026-12-01');
    assert.equal(Number(fresh.consent_at), 999);

    const sessionExpiry = Date.now() + 60_000;
    await createSession(db, { token: 'pg-session', userId: user.id, expiresAt: sessionExpiry });
    const session = await getSession(db, 'pg-session');
    assert.equal(session.user_id, user.id);
    assert.equal(Number(session.expires_at), sessionExpiry);

    await createEmailVerification(db, { token: 'pg-verify', userId: user.id, expiresAt: sessionExpiry });
    assert.equal((await getEmailVerification(db, 'pg-verify')).user_id, user.id);
    await deleteEmailVerificationsForUser(db, user.id);
    assert.equal(await getEmailVerification(db, 'pg-verify'), null);

    await createPasswordReset(db, { token: 'pg-reset', userId: user.id, expiresAt: sessionExpiry });
    assert.equal((await getPasswordReset(db, 'pg-reset')).user_id, user.id);
    await deletePasswordResetsForUser(db, user.id);
    assert.equal(await getPasswordReset(db, 'pg-reset'), null);

    const analysis = { item_type: 'test lamp', condition: 'used', estimated_price_low: 5, estimated_price_high: 15 };
    const draft = await createDraft(db, user.id, { analysis, thumb: '/api/photos/0123456789abcdef0123456789abcdef.jpg', selected: ['ebay'] });
    assert.equal(draft.analysis.item_type, 'test lamp');
    assert.deepEqual(draft.listings, {});
    assert.deepEqual(draft.selected, ['ebay']);
    assert.equal(typeof draft.createdAt, 'number');

    const updated = await updateDraft(db, user.id, draft.id, { listings: { ebay: { title: 'Lamp', posted: true } } });
    assert.equal(updated.listings.ebay.title, 'Lamp');
    assert.equal(updated.listings.ebay.posted, true);
    assert.equal(updated.analysis.condition, 'used');

    assert.equal((await listDrafts(db, user.id)).length, 1);
    assert.equal((await getDraft(db, user.id, draft.id)).id, draft.id);
    assert.equal(await getDraft(db, 'someone-else', draft.id), null);

    await deleteDraft(db, user.id, draft.id);
    assert.equal((await listDrafts(db, user.id)).length, 0);
    assert.equal(await getDraft(db, user.id, draft.id), null);

    // Expired-token housekeeping still removes the right rows.
    const expiredUser = await createUser(db, {
      id: 'pg-expired-user', email: 'pg-expired@thriftly.test', passwordHash: 'hash',
      consentVersion: '2026-11-04', consentAt: 1,
    });
    await createSession(db, { token: 'pg-expired-session', userId: expiredUser.id, expiresAt: Date.now() - 1000 });
    await createEmailVerification(db, { token: 'pg-expired-verify', userId: expiredUser.id, expiresAt: Date.now() - 1000 });
    await createPasswordReset(db, { token: 'pg-expired-reset', userId: expiredUser.id, expiresAt: Date.now() - 1000 });
    await cleanupExpiredSessions(db);
    await runCleanup(db);
    assert.equal(await getSession(db, 'pg-expired-session'), null);
    assert.equal(await getEmailVerification(db, 'pg-expired-verify'), null);
    assert.equal(await getPasswordReset(db, 'pg-expired-reset'), null);

    await deleteSessionsForUser(db, user.id);
    assert.equal(await getSession(db, 'pg-session'), null);
    await deleteSession(db, 'pg-session');
    await deleteUserRow(db, expiredUser.id);
    assert.equal(await getUserById(db, expiredUser.id), null);
    await clearDrafts(db, user.id);
    await deleteUserRow(db, user.id);
    assert.equal(await getUserById(db, user.id), null);

    console.log('pg test: ok — users, sessions, tokens, drafts and cleanup');
  } finally {
    await db.close();
  }
}

main()
  .catch((err) => {
    console.error('PG TEST FAIL:', err.stack || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin(`drop schema if exists "${schema}" cascade`).catch((err) => {
      console.error(`pg test: could not drop ${schema}:`, err.message);
    });
  });
