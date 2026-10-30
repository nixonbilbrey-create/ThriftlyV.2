#!/usr/bin/env node
// Committed end-to-end smoke test. Run with: npm test
//
// Boots the real server as a child process on its own port with its own SQLite
// database and photo dir, then drives the API the way a browser would (fetch,
// verification links via the dev fallback, bearer tokens). Covers the flows
// that don't need a real Gemini key: accounts, email verification, password
// reset, drafts CRUD shape, photo storage/serving, rate limiting.
import { spawn, execFileSync } from 'node:child_process';
import { rmSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

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
  const photo = savePhoto(Buffer.from('smoke-photo-bytes-0123456789'), 'image/jpeg');
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
  } finally {
    smtpChild.kill('SIGTERM');
    await sleep(300);
    rmSync(`${TEST_DIR}/smtp.db`, { force: true });
    rmSync(`${TEST_DIR}/smtp.db-shm`, { force: true });
    rmSync(`${TEST_DIR}/smtp.db-wal`, { force: true });
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
