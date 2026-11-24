#!/usr/bin/env node
// Committed end-to-end smoke test. Run with: npm test
//
// Boots the real server as a child process on its own port with its own SQLite
// database and photo dir, then drives the API the way a browser would (fetch,
// verification links via the dev fallback, bearer tokens). Covers the flows
// that don't need a real Gemini key: accounts, email verification, password
// reset, drafts CRUD shape, photo storage/serving, rate limiting.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Tests always run on SQLite + local disk, even when the developer's .env has
// DATABASE_URL/Supabase credentials. Children inherit these via ...process.env.
process.env.DB_FORCE_SQLITE = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DIR = 'data-test';
const DB_PATH = `${TEST_DIR}/smoke.db`;
// Set for OUR process too: photos.js (also loaded here to seed fixtures) reads
// this at module load, and it must match what the server child gets.
process.env.PHOTOS_DIR = `${TEST_DIR}/photos`;

// ---------- helpers ----------
const plainHeaders = { 'content-type': 'application/json' };
const authHeaders = (token) => ({ ...plainHeaders, authorization: `Bearer ${token}` });
const json = async (res) => { try { return await res.json(); } catch { return {}; } };
const tokenFrom = (link) => {
  const m = /[?&]token=([a-f0-9]+)/.exec(link || '');
  return m ? m[1] : null;
};

function startServer() {
  // DB + photos live under a throwaway dir so the repo stays clean.
  mkdirSync(TEST_DIR, { recursive: true });
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      // dotenv (inside server.js) never overrides already-set env vars, so this
      // wins over any BASE_URL in the developer's .env — links must point at
      // this test server, not whatever the .env says.
      BASE_URL: `http://127.0.0.1:${PORT}`,
      // No SMTP in tests → the dev fallback returns links in API responses,
      // which is how the tests reach verify/reset URLs without a mailbox.
    },
    stdio: 'ignore',
  });
  return child;
}

async function waitForServer(deadlineMs = 10000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

// ---------- flows ----------
async function authAndVerifyFlow() {
  // consent gate first: no agreement, no account (server-side, not just UI)
  const noAgree = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'noagree@test.dev', password: 'long-enough-pass' }),
  });
  assert.equal(noAgree.status, 400, 'signup without consent must 400');
  assert.match((await json(noAgree)).error || '', /Privacy Policy/, 'consent error must name the policy');

  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'smoke-password-1', agree: true }),
  });
  const signupBody = await json(signup);
  assert.equal(signup.status, 201, `signup -> ${signup.status} ${JSON.stringify(signupBody)}`);
  assert.ok(signupBody.devVerifyLink, 'no SMTP → signup must return devVerifyLink');

  // the whole point of emailed verification: no login token exists until the
  // mailbox is proven — the UI depends on needsVerification to show the resend
  // affordance.
  const preVerifyLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'smoke-password-1' }),
  });
  assert.equal(preVerifyLogin.status, 403, 'login before verification must 403');
  const preVerifyBody = await json(preVerifyLogin);
  assert.equal(preVerifyBody.needsVerification, true, 'login before verification must flag needsVerification');
  assert.equal(preVerifyBody.token, undefined, 'unverified login must not issue a session token');

  const dup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'smoke-password-1', agree: true }),
  });
  assert.equal(dup.status, 409, 'duplicate signup must 409');

  const unknown = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'other@test.dev', password: 'long-enough-password' }),
  });
  assert.equal(unknown.status, 401, 'unknown email must 401');

  const wrong = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'wrong-password' }),
  });
  assert.equal(wrong.status, 401, 'wrong password must 401');

  const verify = await fetch(signupBody.devVerifyLink);
  assert.equal(verify.status, 200, 'verify-email link must 200');
  assert.ok((await verify.text()).includes('Email verified'), 'verify page must confirm');

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'smoke-password-1' }),
  });
  assert.equal(login.status, 200, 'login before verification must still be allowed after verify');
  const { token } = await json(login);
  assert.ok(/^[a-f0-9]{64}$/.test(token), 'session token shape');

  const me = await json(await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) }));
  assert.equal(me.email, 'smoke@test.dev');
  assert.equal(me.emailVerified, true);
  assert.ok(me.policyVersion && me.policyAcceptedAt, ' consent version + timestamp recorded');
  const policyPage = await (await fetch(`${BASE}/privacy.html`)).text();
  assert.ok(policyPage.includes(me.policyVersion), 'served policy page version must match the recorded consent version');

  // launch surface: terms page exists, health exposes liveness only (no paths).
  const termsPage = await (await fetch(`${BASE}/terms.html`)).text();
  assert.match(termsPage, /Terms of Service/, 'served terms page must exist');
  const health = await json(await fetch(`${BASE}/api/health`));
  assert.equal(health.ok, true, 'health must report ok');
  assert.equal(health.dbPath, undefined, 'health must not leak the database path');
  // readiness actually touches the database, so it fails when the app can't serve
  const ready = await json(await fetch(`${BASE}/api/ready`));
  assert.equal(ready.ok, true, 'readiness must report ok against a reachable database');
  assert.equal(ready.db, 'sqlite', 'readiness must name the backend');

  // re-consent: config exposes the current version, a stale account can record
  // acceptance of it, and the endpoint is authenticated and explicit.
  const appConfig = await json(await fetch(`${BASE}/api/config`));
  assert.equal(appConfig.privacyVersion, me.policyVersion, 'config must expose the current policy version');
  const Database = (await import('better-sqlite3')).default;
  const testDb = new Database(DB_PATH);
  testDb.prepare("UPDATE users SET consent_version = '2020-01-01' WHERE email = 'smoke@test.dev'").run();
  testDb.close();
  const staleMe = await json(await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) }));
  assert.equal(staleMe.policyVersion, '2020-01-01', 'stale consent version must be visible to the client');
  const consentNoAgree = await fetch(`${BASE}/api/auth/consent`, {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ agree: false }),
  });
  assert.equal(consentNoAgree.status, 400, 're-consent without agree:true must 400');
  const consent = await fetch(`${BASE}/api/auth/consent`, {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ agree: true }),
  });
  assert.equal(consent.status, 200, 're-consent must 200');
  assert.equal((await json(consent)).policyVersion, appConfig.privacyVersion, 're-consent records the current version');
  const anonConsent = await fetch(`${BASE}/api/auth/consent`, {
    method: 'POST', headers: plainHeaders, body: '{"agree":true}',
  });
  assert.equal(anonConsent.status, 401, 're-consent requires authentication');

  const noAuth = await fetch(`${BASE}/api/auth/me`);
  assert.equal(noAuth.status, 401, 'missing bearer must 401');
  const badAuth = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: 'Bearer deadbeef' } });
  assert.equal(badAuth.status, 401, 'bogus bearer must 401');
  const junkAuth = await fetch(`${BASE}/api/auth/me`, { headers: { authorization: 'Basic abc' } });
  assert.equal(junkAuth.status, 401, 'non-Bearer scheme must 401');

  await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders(token) });
  const afterLogout = await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) });
  assert.equal(afterLogout.status, 401, 'logout must invalidate the session');

  const rel = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'smoke-password-1' }),
  });
  const relBody = await json(rel);
  assert.equal(rel.status, 200, 're-login must work');
  return relBody.token;
}

async function passwordResetFlow(loginToken) {
  const unknown = await json(await fetch(`${BASE}/api/auth/request-reset`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'ghost@test.dev' }),
  }));
  assert.ok(unknown.message, 'unknown email gets a generic message');
  assert.ok(!unknown.devResetLink, 'unknown email must not get a link');

  const r1 = await json(await fetch(`${BASE}/api/auth/request-reset`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smoke@test.dev' }),
  }));
  assert.ok(r1.devResetLink, 'known email must return devResetLink without SMTP');
  const t1 = tokenFrom(r1.devResetLink);
  assert.ok(t1, 'reset link must carry a token');

  // re-request voids the earlier link
  await fetch(`${BASE}/api/auth/request-reset`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smoke@test.dev' }),
  });
  const voided = await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ token: t1, password: 'second-password-2' }),
  });
  assert.equal(voided.status, 400, 'voided token must not set a password');

  // login still works with the previous session token (reset hasn't happened yet)
  const meBefore = await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(loginToken) });
  assert.equal(meBefore.status, 200, 'session unaffected before reset completes');

  const r2 = await json(await fetch(`${BASE}/api/auth/request-reset`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smoke@test.dev' }),
  }));
  const t2 = tokenFrom(r2.devResetLink);
  const short = await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ token: t2, password: 'short' }),
  });
  assert.equal(short.status, 400, 'short password must 400');
  const done = await json(await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ token: t2, password: 'reset-new-pass-9' }),
  }));
  assert.equal(done.ok, true, 'valid reset must succeed');

  const reuse = await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ token: t2, password: 'again-password-3' }),
  });
  assert.equal(reuse.status, 400, 'used token must be dead');

  // completing a reset revokes all existing sessions — including ours
  const afterReset = await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(loginToken) });
  assert.equal(afterReset.status, 401, 'reset must revoke existing sessions');

  const relogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke@test.dev', password: 'reset-new-pass-9' }),
  });
  const relBody = await json(relogin);
  assert.equal(relogin.status, 200, 'login with new password must work');
  return relBody.token;
}

// Second account so cross-user scoping of drafts can be verified.
async function secondUserFlow() {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke2@test.dev', password: 'second-pass-123', agree: true }),
  });
  const { devVerifyLink } = await json(signup);
  assert.equal(signup.status, 201, 'second signup must 201');
  assert.ok((await fetch(devVerifyLink)).status === 200, 'second verify must succeed');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'smoke2@test.dev', password: 'second-pass-123' }),
  });
  const { token } = await json(login);
  assert.equal(login.status, 200, 'second login must work');
  return token;
}

// Self-service deletion promised by the privacy policy: everything gone, then login dead.
async function accountDeleteFlow() {
  const signup = await fetch(`${BASE}/api/auth/signup`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'deleteme@test.dev', password: 'delete-me-pass-1', agree: true }),
  });
  assert.equal(signup.status, 201, 'third signup must 201');
  const { devVerifyLink } = await json(signup);
  await fetch(devVerifyLink);
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'deleteme@test.dev', password: 'delete-me-pass-1' }),
  });
  const { token } = await json(login);
  assert.equal(login.status, 200, 'third login must work');

  const del = await fetch(`${BASE}/api/account`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(del.status, 204, 'account deletion must 204');
  const sessionDead = await fetch(`${BASE}/api/auth/me`, { headers: authHeaders(token) });
  assert.equal(sessionDead.status, 401, 'session must die with the account');
  const rel = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ email: 'deleteme@test.dev', password: 'delete-me-pass-1' }),
  });
  assert.equal(rel.status, 401, 'login after account deletion must 401');
}

async function photoAndDraftsFlow(token, otherToken) {
  // Seed a draft + photo through the same save path /api/scan uses, then check
  // the API surfaces and serves it. (The scan itself needs a live Gemini key,
  // so the AI call is out of scope here.)
  const { initDb } = await import('../db.js');
  const { savePhoto } = await import('../photos.js');
  const db = initDb(DB_PATH);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get('smoke@test.dev');
  const photo = await savePhoto(Buffer.from('smoke-photo-bytes-0123456789'), 'image/jpeg');
  const analysis = { item_type: 'test lamp', condition: 'used', estimated_price_low: 5, estimated_price_high: 15, confidence: 'medium' };
  db.prepare(`INSERT INTO drafts (id, user_id, analysis, thumb, listings, selected, created_at, updated_at)
              VALUES ('smokedraft1', ?, ?, ?, '{}', ?, ?, ?)`)
    .run(user.id, JSON.stringify(analysis), photo.url, JSON.stringify(['ebay']), Date.now(), Date.now());
  db.close();

  const list = await json(await fetch(`${BASE}/api/drafts`, { headers: authHeaders(token) }));
  assert.equal(list.length, 1, 'draft list must show the seeded draft');
  assert.equal(list[0].thumb, photo.url, 'thumb must be a storage URL');
  assert.equal(list[0].analysis.item_type, 'test lamp');

  // full CRUD shape + strict user scoping
  const noAuthList = await fetch(`${BASE}/api/drafts`);
  assert.equal(noAuthList.status, 401, 'drafts need a bearer');
  const got = await json(await fetch(`${BASE}/api/drafts/smokedraft1`, { headers: authHeaders(token) }));
  assert.equal(got.id, 'smokedraft1', 'owner can GET a single draft');
  const foreignGet = await fetch(`${BASE}/api/drafts/smokedraft1`, { headers: authHeaders(otherToken) });
  assert.equal(foreignGet.status, 404, "another user's draft must be invisible");

  const put = await fetch(`${BASE}/api/drafts/smokedraft1`, {
    method: 'PUT', headers: authHeaders(token),
    body: JSON.stringify({ listings: { ebay: { title: 'Smoke title', price: 9.5, posted: true } } }),
  });
  const updated = await json(put);
  assert.equal(put.status, 200, 'draft update must 200');
  assert.equal(updated.listings.ebay.title, 'Smoke title', 'update must persist listings');
  assert.equal(updated.listings.ebay.posted, true, 'update must persist posted flag');
  const foreignPut = await fetch(`${BASE}/api/drafts/smokedraft1`, {
    method: 'PUT', headers: authHeaders(otherToken),
    body: JSON.stringify({ listings: { ebay: { title: 'hijack' } } }),
  });
  assert.equal(foreignPut.status, 404, "another user must not update someone else's draft");
  const missingPut = await fetch(`${BASE}/api/drafts/nonexistent`, {
    method: 'PUT', headers: authHeaders(token), body: JSON.stringify({}),
  });
  assert.equal(missingPut.status, 404, 'updating an unknown draft must 404');

  const photoRes = await fetch(`${BASE}${photo.url}`);
  assert.equal(photoRes.status, 200, 'photo must serve');
  assert.equal(photoRes.headers.get('content-type'), 'image/jpeg');
  assert.equal(await photoRes.text(), 'smoke-photo-bytes-0123456789', 'photo bytes must round-trip');

  assert.equal((await fetch(`${BASE}/api/photos/ffffffffffffffffffffffffffffffff.png`)).status, 404, 'unknown photo must 404');
  assert.equal((await fetch(`${BASE}/api/photos/..%2f..%2fetc%2fpasswd`)).status, 404, 'traversal must 404');

  // data export: everything the account owns, photos included, as a download
  const exportRes = await fetch(`${BASE}/api/account/export`, { headers: authHeaders(token) });
  assert.equal(exportRes.status, 200, 'export must 200');
  assert.match(exportRes.headers.get('content-disposition') || '', /attachment/, 'export must be a file download');
  const exportBody = await json(exportRes);
  assert.equal(exportBody.account.email, 'smoke@test.dev', 'export must include the account');
  assert.equal(exportBody.drafts.length, 1, 'export must include the draft');
  const exportedPhoto = exportBody.photos[photo.url.split('/').pop()];
  assert.ok(exportedPhoto, 'export must include the photo bytes');
  assert.equal(Buffer.from(exportedPhoto.base64, 'base64').toString(), 'smoke-photo-bytes-0123456789', 'exported photo bytes must match');
  const otherExport = await json(await fetch(`${BASE}/api/account/export`, { headers: authHeaders(otherToken) }));
  assert.ok(!otherExport.drafts.some((d) => d.id === 'smokedraft1'), 'export must not leak another user\'s drafts');

  const del = await fetch(`${BASE}/api/drafts/smokedraft1`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(del.status, 204, 'draft delete must 204');
  const delForeign = await fetch(`${BASE}/api/drafts/smokedraft1`, { method: 'DELETE', headers: authHeaders(otherToken) });
  if (delForeign.status !== 404) throw new Error('foreign delete unexpectedly succeeded — draft still there?');
  assert.equal((await fetch(`${BASE}${photo.url}`)).status, 404, 'photo file gone after draft delete');

  const emptyList = await json(await fetch(`${BASE}/api/drafts`, { headers: authHeaders(token) }));
  assert.equal(emptyList.length, 0, 'list is empty after delete');
}

async function resizeFlow() {
  const sharp = (await import('sharp')).default;
  const { shrink } = await import('../photos.js');

  // A large, realistically-encoded photo (2000x3000, jpeg q95)
  const big = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: 'slateblue' } })
    .jpeg({ quality: 95 }).toBuffer();
  const out = await shrink(big);
  assert.equal(out.mimetype, 'image/jpeg', 'shrink must emit jpeg');
  const meta = await sharp(out.buffer).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 1400, `longest edge must be <= 1400 (got ${meta.width}x${meta.height})`);
  const ratio = meta.width / meta.height;
  assert.ok(Math.abs(ratio - 2000 / 3000) < 0.02, 'aspect ratio must be preserved');
  assert.ok(out.buffer.length < big.length * 0.5, `output must be < 50% of input (got ${out.buffer.length}/${big.length})`);

  // tiny photos are never upscaled
  const tiny = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'black' } }).jpeg().toBuffer();
  const smallMeta = await sharp((await shrink(tiny)).buffer).metadata();
  assert.equal(smallMeta.width, 40, 'shrink must not upscale a small photo');

  // undecodable upload is rejected (server turns it into a 400)
  await assert.rejects(
    () => shrink(Buffer.from('definitely-not-an-image')),
    undefined,
    'corrupt image must reject',
  );
}

// Backups: run the real scripts against this run's data, then restore into a
// fresh directory and prove the snapshot survives the roundtrip.
async function backupRestoreFlow() {
  const backupDir = `${TEST_DIR}/backups`;
  const env = { ...process.env, DB_PATH, PHOTOS_DIR: `${TEST_DIR}/photos`, BACKUP_DIR: backupDir };
  execFileSync('node', ['scripts/backup.mjs'], { env, stdio: 'pipe' });
  const archives = readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, 'backup must produce exactly one archive');
  const archive = `${backupDir}/${archives[0]}`;
  assert.ok(existsSync(`${archive}.sha256`), 'backup must write a sha256 sidecar');

  const restored = `${TEST_DIR}/restored-data`;
  execFileSync('node', ['scripts/restore.mjs', archive, '--target', restored, '--force'], { env, stdio: 'pipe' });
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(`${restored}/smoke.db`, { readonly: true });
  const integrity = db.pragma('integrity_check', { simple: true });
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  db.close();
  assert.equal(integrity, 'ok', 'restored database must pass integrity_check');
  assert.ok(users >= 2, `restored database must keep the accounts from earlier flows (got ${users})`);
  assert.ok(existsSync(`${restored}/photos`), 'restored archive must include the photos directory');
}

// Security: when SMTP is configured but fails (dead relay), setup/reset links
// must NOT appear in API responses — tokens must only ever be logged server-side.
// Runs against its own server child on another port with a refused SMTP relay.
async function smtpFailureFlow() {
  const PORT2 = 3124;
  const smtpChild = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT2),
      DB_PATH: `${TEST_DIR}/smtp.db`,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      BASE_URL: `http://127.0.0.1:${PORT2}`,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',       // nothing listens — connection refused, fails fast
      SMTP_FROM: 'noreply@thriftly.test',
    },
    stdio: 'ignore',
  });
  const B2 = `http://127.0.0.1:${PORT2}`;
  try {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try { if ((await fetch(`${B2}/api/health`)).ok) break; } catch { /* not up yet */ }
      await sleep(150);
    }
    const signup = await fetch(`${B2}/api/auth/signup`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email: 'smtpfail@test.dev', password: 'smtp-fail-pass-1', agree: true }),
    });
    const body = await json(signup);
    assert.equal(signup.status, 201, `signup should still 201 when the send fails (got ${signup.status})`);
    assert.ok(!body.devVerifyLink, 'failed SMTP send must NOT leak the verification link in the API response');
    const reset = await json(await fetch(`${B2}/api/auth/request-reset`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smtpfail@test.dev' }),
    }));
    assert.ok(!reset.devResetLink, 'failed SMTP send must NOT leak the reset link in the API response');
    // the token still exists server-side: re-requesting and then succeeding via dev links isn't
    // testable without a real relay, so we only assert the API surface stays clean

    // resend cooldown: one verification email per address per minute, and the
    // throttle applies even to addresses with no account (no enumeration signal)
    const r1 = await fetch(`${B2}/api/auth/resend-verification`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smtpfail@test.dev' }),
    });
    assert.equal(r1.status, 200, 'first resend must be allowed');
    assert.ok(!(await json(r1)).devVerifyLink, 'failed SMTP send must not leak the verification link either');
    const r2 = await fetch(`${B2}/api/auth/resend-verification`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smtpfail@test.dev' }),
    });
    assert.equal(r2.status, 429, 'second resend inside the cooldown must 429');
    const r2body = await json(r2);
    assert.ok(r2body.retryAfter > 0 && r2body.retryAfter <= 60, 'cooldown must report retryAfter seconds');
    const ghost1 = await fetch(`${B2}/api/auth/resend-verification`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'ghost-cooldown@test.dev' }),
    });
    assert.equal(ghost1.status, 200, 'unknown address first resend stays generic 200');
    const ghost2 = await fetch(`${B2}/api/auth/resend-verification`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'ghost-cooldown@test.dev' }),
    });
    assert.equal(ghost2.status, 429, 'unknown addresses share the same cooldown — no enumeration difference');
  } finally {
    smtpChild.kill('SIGTERM');
    await sleep(300);
    rmSync(`${TEST_DIR}/smtp.db`, { force: true });
    rmSync(`${TEST_DIR}/smtp.db-shm`, { force: true });
    rmSync(`${TEST_DIR}/smtp.db-wal`, { force: true });
  }
}

// CAPTCHA gate: with TURNSTILE_SECRET configured, signup must be refused without
// a token, and the public config exposes only the site key (never the secret).
async function captchaFlow() {
  const PORT3 = 3125;
  const child3 = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT3),
      DB_PATH: `${TEST_DIR}/captcha.db`,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      BASE_URL: `http://127.0.0.1:${PORT3}`,
      TURNSTILE_SITE_KEY: 'test-site-key',
      TURNSTILE_SECRET: 'test-secret',
    },
    stdio: 'ignore',
  });
  const B3 = `http://127.0.0.1:${PORT3}`;
  try {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      try { if ((await fetch(`${B3}/api/health`)).ok) break; } catch { /* not up yet */ }
      await sleep(150);
    }
    const cfg = await json(await fetch(`${B3}/api/config`));
    assert.equal(cfg.turnstileSiteKey, 'test-site-key', 'public config must expose the site key');
    assert.equal(cfg.turnstileSecret, undefined, 'public config must never expose the secret');
    const csp = (await fetch(`${B3}/`)).headers.get('content-security-policy') || '';
    assert.ok(csp.includes('challenges.cloudflare.com'), 'CSP must allow the Turnstile script/frame');

    const noToken = await fetch(`${B3}/api/auth/signup`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email: 'captcha@test.dev', password: 'captcha-pass-1', agree: true }),
    });
    assert.equal(noToken.status, 400, 'signup without a CAPTCHA token must 400');
    assert.match((await json(noToken)).error || '', /CAPTCHA/, 'error must name the CAPTCHA');
  } finally {
    child3.kill('SIGTERM');
    await sleep(300);
    rmSync(`${TEST_DIR}/captcha.db`, { force: true });
    rmSync(`${TEST_DIR}/captcha.db-shm`, { force: true });
    rmSync(`${TEST_DIR}/captcha.db-wal`, { force: true });
  }
}

// GEMINI_API_BASE exists for the tests only. In production gemini.js ignores it
// and the server refuses to boot while it is set, so a stray value can never
// send users' own API keys to another host.
async function configGuardFlow() {
  const elsewhere = 'http://gemini.invalid/v1beta';
  const runNode = (args, extraEnv) => spawnSync('node', args, {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ENCRYPTION_KEY: 'a'.repeat(64), ...extraEnv },
  });

  const prodBase = runNode(['-e', "console.log(require('./gemini.js').API_BASE)"], {
    NODE_ENV: 'production', GEMINI_API_BASE: elsewhere,
  });
  assert.equal(prodBase.status, 0, `gemini.js must still load in production: ${prodBase.stderr}`);
  assert.equal(
    prodBase.stdout.trim(), 'https://generativelanguage.googleapis.com/v1beta',
    'production must ignore GEMINI_API_BASE, whatever it is set to',
  );

  const testBase = runNode(['-e', "console.log(require('./gemini.js').API_BASE)"], {
    NODE_ENV: 'test', GEMINI_API_BASE: elsewhere,
  });
  assert.equal(testBase.stdout.trim(), elsewhere, 'tests can point the client at a local fake');

  const boot = runNode(['server.js'], {
    NODE_ENV: 'production',
    GEMINI_API_BASE: elsewhere,
    PORT: '3129',
    DB_PATH: `${TEST_DIR}/guard.db`,
    PHOTOS_DIR: `${TEST_DIR}/photos`,
    BASE_URL: 'http://127.0.0.1:3129',
  });
  assert.equal(boot.status, 1, 'production must refuse to boot with an API-origin override');
  assert.match(boot.stderr, /GEMINI_API_BASE is set in production/, 'the refusal names the variable');
}

// ENCRYPTION_KEY must be hex, not merely 64 characters. A passphrase of the right
// length used to clear boot and then blow up inside encrypt() — on a user's first
// scan, in production, as a 500 — so the boot guard and the crypto layer have to
// reject the same values.
function encryptionKeyGuardFlow() {
  const runNode = (args, extraEnv) => spawnSync('node', args, {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PORT: '3131',
      DB_PATH: `${TEST_DIR}/key-guard.db`,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      BASE_URL: 'http://127.0.0.1:3131',
      ...extraEnv,
    },
  });

  // 64 characters, not one of them hex: exactly what the length-only check let
  // through to fail later.
  const passphrase = 'z'.repeat(64);
  assert.equal(passphrase.length, 64, 'the rejected value must be the length the old check accepted');
  const boot = runNode(['server.js'], { ENCRYPTION_KEY: passphrase });
  assert.equal(boot.status, 1, 'a 64-character passphrase must stop boot, not fail on the first scan');
  assert.match(boot.stderr, /64 hex characters/i, 'the refusal says the key must be hex');
  assert.match(boot.stderr, /randomBytes/, 'and shows how to generate a real one');

  const short = runNode(['server.js'], { ENCRYPTION_KEY: 'abc123' });
  assert.equal(short.status, 1, 'a short key still stops boot');

  const missing = runNode(['server.js'], { ENCRYPTION_KEY: '' });
  assert.equal(missing.status, 1, 'a missing key still stops boot');

  // The crypto layer must agree with the guard, or a bad key could still reach
  // encrypt() by another path.
  const direct = runNode([
    '-e',
    "process.env.ENCRYPTION_KEY = 'z'.repeat(64); const { encrypt } = require('./auth'); " +
    "try { encrypt('x'); process.stdout.write('accepted'); } catch (e) { process.stdout.write('refused:' + e.message); }",
  ], { ENCRYPTION_KEY: '' });
  assert.match(direct.stdout, /refused:.*hex/i, 'encrypt() refuses the same value the boot check does');

  // And a genuine key still works, upper-case hex included (it is hex either way).
  const roundtrip = runNode([
    '-e',
    "process.env.ENCRYPTION_KEY = 'A'.repeat(64); const { encrypt, decrypt } = require('./auth'); " +
    "process.stdout.write(decrypt(encrypt('hello')) === 'hello' ? 'roundtrip-ok' : 'mismatch');",
  ], { ENCRYPTION_KEY: '' });
  assert.match(roundtrip.stdout, /roundtrip-ok/, 'a real 64-hex key still encrypts and decrypts');
}

// A booted instance on its own port and database, for tests that need different
// environment than the main server.
async function bootInstance(port, dbName, extraEnv = {}) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: `${TEST_DIR}/${dbName}`,
      PHOTOS_DIR: `${TEST_DIR}/photos`,
      BASE_URL: base,
      ...extraEnv,
    },
    stdio: 'ignore',
  });
  const end = Date.now() + 10000;
  let up = false;
  while (Date.now() < end && !up) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* still starting */ }
    if (!up) await sleep(100);
  }
  assert.ok(up, `instance on ${port} must boot`);
  return { child, base };
}

// REQUIRE_EMAIL_VERIFICATION=false exists for instances with no mail relay. It must
// mean a session at signup — not a 201 followed by a login that refuses — and it
// must stay opt-in, so the same flow is run against a default instance and gated.
async function verificationOptOutFlow() {
  const off = await bootInstance(3132, 'noverify.db', { REQUIRE_EMAIL_VERIFICATION: 'false' });
  const on = await bootInstance(3133, 'verify-on.db');
  try {
    const email = 'noverify@test.dev';
    const signup = await fetch(`${off.base}/api/auth/signup`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email, password: 'noverify-pass-1', agree: true }),
    });
    assert.equal(signup.status, 201, 'signup succeeds on the no-verification instance');
    const created = await json(signup);
    assert.match(created.token || '', /^[a-f0-9]{64}$/, 'signup hands back a session instead of an inbox errand');
    assert.equal(created.user.emailVerified, true, 'and the account is not left half-created');
    assert.equal(created.devVerifyLink, undefined, 'no useless verification link is produced');

    const me = await json(await fetch(`${off.base}/api/auth/me`, { headers: authHeaders(created.token) }));
    assert.equal(me.email, email, 'the session works immediately');
    const drafts = await json(await fetch(`${off.base}/api/drafts`, { headers: authHeaders(created.token) }));
    assert.ok(Array.isArray(drafts), 'and the app behind it is open, not just the auth endpoints');

    const login = await fetch(`${off.base}/api/auth/login`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email, password: 'noverify-pass-1' }),
    });
    assert.equal(login.status, 200, 'later logins need no verification step either');

    const resend = await fetch(`${off.base}/api/auth/resend-verification`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email }),
    });
    assert.equal(resend.status, 400, 'resend says verification is off rather than pretending to send');

    // The flag is opt-in: a default instance must still withhold the session.
    const gatedEmail = 'still-gated@test.dev';
    const created2 = await json(await fetch(`${on.base}/api/auth/signup`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email: gatedEmail, password: 'still-gated-1', agree: true }),
    }));
    assert.equal(created2.token, undefined, 'without the flag, signup still withholds the session');
    const refused = await fetch(`${on.base}/api/auth/login`, {
      method: 'POST', headers: plainHeaders,
      body: JSON.stringify({ email: gatedEmail, password: 'still-gated-1' }),
    });
    assert.equal(refused.status, 403, 'and login still refuses an unverified account');
    assert.equal((await json(refused)).needsVerification, true, 'telling the UI to offer a resend');
  } finally {
    off.child.kill('SIGTERM');
    on.child.kill('SIGTERM');
    await sleep(300);
  }
}

async function limiterChecks() {
  // Runs last: the authLimiter (shared by signup/resend/request-reset,
  // 10/hour/IP) is deliberately exhausted here so nothing earlier is affected.
  for (let i = 0; i < 10; i++) {
    await fetch(`${BASE}/api/auth/request-reset`, {
      method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smoke@test.dev' }),
    });
  }
  const limited = await fetch(`${BASE}/api/auth/request-reset`, {
    method: 'POST', headers: plainHeaders, body: JSON.stringify({ email: 'smoke@test.dev' }),
  });
  assert.equal(limited.status, 429, 'auth limiter must trip 429');
  // unrelated endpoints unaffected
  const setp = await fetch(`${BASE}/api/auth/set-password`, {
    method: 'POST', headers: plainHeaders,
    body: JSON.stringify({ token: 'f'.repeat(64), password: 'whatever-pass-1' }),
  });
  assert.equal(setp.status, 400, 'set-password stays usable past the limiter');
}

// ---------- shell: boot → run → teardown ----------
const child = startServer();
let failed = false;
try {
  await waitForServer();
  console.log('thriftly smoke test');
  const t0 = Date.now();
  const tokenA = await authAndVerifyFlow();
  console.log(`  ok   auth + verify + session lifecycle (${Date.now() - t0}ms)`);
  const t1 = Date.now();
  const tokenB = await passwordResetFlow(tokenA);
  console.log(`  ok   password reset flow (${Date.now() - t1}ms)`);
  const t2 = Date.now();
  const tokenC = await secondUserFlow();
  await photoAndDraftsFlow(tokenB, tokenC);
  console.log(`  ok   photos + drafts (${Date.now() - t2}ms)`);
  const t25 = Date.now();
  await resizeFlow();
  console.log(`  ok   photo resize/compress (${Date.now() - t25}ms)`);
  const tAbs = Date.now();
  await accountDeleteFlow();
  console.log(`  ok   account deletion (${Date.now() - tAbs}ms)`);
  const tBk = Date.now();
  await backupRestoreFlow();
  console.log(`  ok   backup + restore roundtrip (${Date.now() - tBk}ms)`);
  const t26 = Date.now();
  await smtpFailureFlow();
  console.log(`  ok   smtp failure keeps links private (${Date.now() - t26}ms)`);
  const tCapt = Date.now();
  await captchaFlow();
  console.log(`  ok   signup captcha gate (${Date.now() - tCapt}ms)`);
  const tCfg = Date.now();
  await configGuardFlow();
  console.log(`  ok   gemini endpoint override locked to tests (${Date.now() - tCfg}ms)`);
  const tKey = Date.now();
  encryptionKeyGuardFlow();
  console.log(`  ok   ENCRYPTION_KEY must be hex, not just 64 characters (${Date.now() - tKey}ms)`);
  const tNoVerify = Date.now();
  await verificationOptOutFlow();
  console.log(`  ok   REQUIRE_EMAIL_VERIFICATION=false signs up without email, default still gates (${Date.now() - tNoVerify}ms)`);
  const t3 = Date.now();
  await limiterChecks();
  console.log(`  ok   rate limiting (${Date.now() - t3}ms)`);
} catch (err) {
  failed = true;
  console.error('SMOKE TEST FAIL:', err.stack || err);
} finally {
  child.kill('SIGTERM');
  await sleep(300);
  rmSync(TEST_DIR, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
