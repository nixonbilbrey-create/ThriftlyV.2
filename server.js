require('dotenv').config();
const express = require('express');
require('express-async-errors');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { version: APP_VERSION } = require('./package.json');

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error(
    'ENCRYPTION_KEY is missing or invalid in .env — it must be a 64-character hex string (32 bytes).\n' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

const db_ = require('./db');
const {
  initDb, createUser, getUserByEmail, getUserById, publicUser, markUserVerified, setUserGeminiKey, clearUserGeminiKey, deleteUserRow, setUserConsent,
  createSession, getSession, deleteSession, cleanupExpiredSessions, startCleanupLoop,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  createPasswordReset, getPasswordReset, deletePasswordResetsForUser, cleanupExpiredPasswordResets,
  setUserPasswordHash, deleteSessionsForUser,
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts, ping,
} = db_;
const {
  SESSION_TTL_MS, EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS, hashPassword, verifyPassword, DUMMY_HASH, newToken, encrypt, decrypt, requireAuth,
} = require('./auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./mailer');
const { shrink, savePhoto, readPhoto, deletePhoto, photoIdFromThumb, storageEnabled, checkStorage, looksLikeHeic } = require('./photos');
const { runBackup } = require('./backup');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  PLATFORMS, MODEL, testGeminiKey, callGeminiJSON,
  ANALYZE_SYSTEM_PROMPT, LISTING_SYSTEM_PROMPT, analyzeParts, listingParts,
} = require('./gemini');

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// Must match the version shown/dated in public/privacy.html. Bump BOTH when the
// policy changes — every signup records it, and /api/auth/me reports it back.
const PRIVACY_VERSION = '2026-11-18';

const app = express();
// The app always runs behind a TLS-terminating proxy in production (Render,
// preview host, etc.) that forwards the client's real IP in X-Forwarded-For.
// 'trust proxy', 1 trusts exactly one hop, resolving the client IP correctly;
// without it express-rate-limit 8 hard-errors on forwarded requests
// (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
// ---------- baseline security headers ----------
// Registered FIRST so static file responses get them too. Kept explicit rather
// than pulled in via helmet: the app renders inline scripts, so its CSP must
// allow exactly that and nothing more. You'll want an HSTS header on top of
// these once the app runs behind real HTTPS.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  // HSTS only in production: on a local http:// origin it would pin the browser
  // to https for localhost and break development.
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'none'; " +
    "base-uri 'self'; form-action 'self'");
  // Don't let browsers or shared caches hold onto per-user API responses; the
  // photo route sets its own (long-lived) caching and is treated as uncachable
  // user data still — unguessable ids instead of ACLs.
  if (req.path.startsWith('/api/') && !req.path.startsWith('/api/photos/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));

// ---------- request log ----------
// One line per API call: method, path, status, duration. Path only — never the
// query string, because reset/verification tokens live there. Health checks are
// skipped so an uptime monitor doesn't drown the log.
app.use((req, res, next) => {
  // Health/readiness probes are polled by monitors, so they'd drown the log.
  if (!req.path.startsWith('/api/') || req.path === '/api/health' || req.path === '/api/ready') return next();
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`);
  });
  next();
});

const db = initDb(process.env.DB_PATH);

// ---------- database / photo-storage pairing ----------
// Postgres without Supabase Storage is a silent data-loss trap: after cutover
// the Render disk is gone, so photos would be written to the container's
// ephemeral filesystem and disappear with the next deploy. Refuse to boot that
// way in production (PHOTOS_ALLOW_LOCAL=1 is the escape hatch for a host that
// really does have a persistent disk), and warn loudly everywhere else.
if (db.kind === 'pg' && !storageEnabled() && process.env.PHOTOS_ALLOW_LOCAL !== '1') {
  const message =
    'DATABASE_URL selects Postgres but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing, so photos ' +
    'would be written to the container filesystem and lost on the next deploy. Set both Storage variables ' +
    '(docs/SUPABASE.md), or set PHOTOS_ALLOW_LOCAL=1 if this host has a persistent disk for photos.';
  if (process.env.NODE_ENV === 'production') {
    console.error(`[startup] ${message}`);
    process.exit(1);
  }
  console.warn(`[startup] ${message}`);
}

cleanupExpiredSessions(db).catch(err => console.error('[cleanup] sessions:', err.message));
cleanupExpiredVerifications(db).catch(err => console.error('[cleanup] verifications:', err.message));
cleanupExpiredPasswordResets(db).catch(err => console.error('[cleanup] resets:', err.message));
const cleanupTimer = startCleanupLoop(db); // hourly purge of expired sessions/verification tokens
const auth = requireAuth(db);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- rate limiting ----------
// All in-memory (resets on restart, per server instance) — right for a single-process
// deployment; swap in a shared store before running multiple instances.
// Login is keyed by email when provided (so brute-forcing ONE account from many IPs
// still trips the limit) with IP as the fallback dimension.
function jsonRateLimit({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: message }),
  });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.email ? String(req.body.email).toLowerCase() : ipKeyGenerator(req.ip)),
  handler: (_req, res) => res.status(429).json({ error: 'Too many login attempts — try again in 15 minutes' }),
});

// Shared by signup and resend-verification: both are free emails if abused.
const authLimiter = jsonRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many requests — try again in an hour',
});

// Scanning burns the user's own Gemini quota, but each image is also multi-MB upload +
// AI work on the server. Rate limiting it keeps any one IP from hogging the box.
const scanLimiter = jsonRateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: 'Scan limit reached (30/hour) — try again later',
});

function verifyPageHtml({ ok, message }) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Thriftly</title>
  <style>body{font-family:system-ui,sans-serif;max-width:400px;margin:80px auto;text-align:center;color:#1c1a17;padding:0 20px;}
  h1{font-size:18px;}p{color:#4a4438;font-size:14px;line-height:1.5;}
  a{display:inline-block;margin-top:14px;background:#1c1a17;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:13.5px;font-weight:600;}</style>
  </head><body><h1>${ok ? '✅ Email verified' : '⚠️ Verification failed'}</h1><p>${message}</p><a href="/">Continue to Thriftly</a></body></html>`;
}

function sendError(res, err) {
  console.error(err);
  // 5xx means something blew up server-side (Gemini outage, unexpected crash) —
  // the full error lives in the server log only; the client gets a generic line
  // so internals never leak. 4xx errors are user-actionable by contract:
  // message/detail/raw come straight through so the harness and real pages can
  // show exactly what went wrong with the user's own input or key.
  if ((err.status || 500) >= 500) {
    return res.status(err.status || 500).json({ error: 'Something went wrong — try again in a moment' });
  }
  const body = { error: err.message || 'Server error' };
  if (err.detail) body.detail = err.detail;
  if (err.raw) body.raw = err.raw;
  res.status(err.status).json(body);
}

// ---------- signup CAPTCHA (Cloudflare Turnstile) ----------
// Off unless TURNSTILE_SECRET is set. The site key is public (served to the
// browser); the secret stays server-side and is used only against Turnstile's
// siteverify endpoint. Fail closed: if Cloudflare can't be reached, signup is
// refused rather than silently skipping the check.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_VERIFY_URL = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Fail loudly at boot (but don't refuse to start: CI and smoke tests run the
// production image/binary without email or CAPTCHA configured).
if (process.env.NODE_ENV === 'production') {
  // Fatal, unlike the warnings below: an API-origin override would redirect every
  // user's Gemini key to another host. gemini.js already ignores the value in
  // production; this makes the misconfiguration impossible to miss.
  if (process.env.GEMINI_API_BASE) {
    console.error('[startup] GEMINI_API_BASE is set in production — unset it. Gemini keys must only ever be sent to Google\'s API.');
    process.exit(1);
  }
  if (!process.env.SMTP_HOST) {
    console.warn('[startup] SMTP is not configured: verification/reset emails will NOT be delivered and links will be returned in API responses. Do not allow public signups in this state.');
  }
  if (!TURNSTILE_SECRET) console.warn('[startup] Turnstile is off: signup CAPTCHA is disabled.');
  if (!/^https:\/\//.test(BASE_URL)) {
    console.warn(`[startup] BASE_URL is "${BASE_URL}" — set it to the public https origin before inviting users, or email links will point at the wrong host.`);
  }
}

app.get('/api/config', (req, res) => res.json({ turnstileSiteKey: TURNSTILE_SITE_KEY || null, privacyVersion: PRIVACY_VERSION }));

async function verifyCaptcha(token, remoteip) {
  if (!TURNSTILE_SECRET) return { ok: true }; // not configured — dev / tests
  if (!token) return { ok: false, error: 'Please complete the CAPTCHA check' };
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token) });
    if (remoteip) body.set('remoteip', remoteip);
    const response = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body });
    const data = await response.json().catch(() => ({}));
    if (!data.success) return { ok: false, error: 'CAPTCHA check failed — please try again' };
    return { ok: true };
  } catch (err) {
    console.error('[captcha] siteverify unreachable:', err.message);
    return { ok: false, status: 503, error: 'CAPTCHA service is unavailable — try again in a moment' };
  }
}

// ============ AUTH ============
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, agree, captchaToken } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  // Consent is enforced server-side, not just by the UI checkbox — an API caller
  // can't create an account that never accepted the privacy policy.
  if (agree !== true) return res.status(400).json({ error: 'You must agree to the Privacy Policy and Terms of Service to create an account' });
  const captcha = await verifyCaptcha(captchaToken, req.ip);
  if (!captcha.ok) return res.status(captcha.status || 400).json({ error: captcha.error });
  if (await getUserByEmail(db, email)) return res.status(409).json({ error: 'An account with that email already exists' });

  const id = crypto.randomBytes(8).toString('hex');
  const user = await createUser(db, {
    id, email, passwordHash: await hashPassword(password),
    consentVersion: PRIVACY_VERSION, consentAt: Date.now(),
  });

  const token = newToken();
  await createEmailVerification(db, { token, userId: user.id, expiresAt: Date.now() + EMAIL_VERIFICATION_TTL_MS });
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;
  const mail = await sendVerificationEmail(email, verifyUrl);

  res.status(201).json({
    message: 'Account created — check your email to verify it before logging in.',
    // Only present when we couldn't actually email it (no SMTP configured, or sending failed) —
    // a real SMTP setup means this never appears. See README before relying on this for real users.
    devVerifyLink: mail.sent ? undefined : mail.devLink,
  });
});

app.get('/api/auth/verify-email', async (req, res) => {
  const token = req.query.token;
  const record = token && await getEmailVerification(db, token);
  if (!record || Number(record.expires_at) < Date.now()) {
    return res.status(400).send(verifyPageHtml({
      ok: false,
      message: 'This verification link is invalid or has expired. Go back and use "Resend verification email" to get a new one.',
    }));
  }
  await markUserVerified(db, record.user_id);
  await deleteEmailVerificationsForUser(db, record.user_id);
  res.send(verifyPageHtml({ ok: true, message: 'Your email is verified. You can log in now.' }));
});

// Resend cooldown: at most one verification email per address per minute. The
// timestamp is recorded for every address that asks — existing or not — so the
// throttle's response can't be used to probe which emails have accounts.
const RESEND_COOLDOWN_MS = 60 * 1000;
const resendSentAt = new Map();

function resendRetryAfterSeconds(email) {
  const last = resendSentAt.get(email);
  if (!last) return 0;
  return Math.ceil(Math.max(0, RESEND_COOLDOWN_MS - (Date.now() - last)) / 1000);
}

app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  const key = String(email || '').trim().toLowerCase();
  const retryAfter = key ? resendRetryAfterSeconds(key) : 0;
  if (retryAfter > 0) {
    return res.status(429).json({ error: `Please wait ${retryAfter}s before requesting another verification email`, retryAfter });
  }
  // Always the same response, whether or not the account exists or is already verified —
  // don't let this endpoint be used to check who has an account.
  const generic = { message: 'If that email needs verifying, we just sent a new link.' };
  if (!key) return res.json(generic);
  resendSentAt.set(key, Date.now());
  if (resendSentAt.size > 500) {
    for (const [addr, ts] of resendSentAt) if (Date.now() - ts > RESEND_COOLDOWN_MS) resendSentAt.delete(addr);
  }

  const user = await getUserByEmail(db, key);
  if (!user || user.email_verified) return res.json(generic);

  await deleteEmailVerificationsForUser(db, user.id);
  const token = newToken();
  await createEmailVerification(db, { token, userId: user.id, expiresAt: Date.now() + EMAIL_VERIFICATION_TTL_MS });
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;
  const mail = await sendVerificationEmail(key, verifyUrl);
  res.json({ ...generic, devVerifyLink: mail.sent ? undefined : mail.devLink });
});

app.post('/api/auth/request-reset', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Same generic response whether or not the account exists — combined with the
  // authLimiter (10/hour/IP), this can't be used to check who has an account.
  const generic = { message: 'If that email has a Thriftly account, we just sent a password-reset link.' };
  const user = email && await getUserByEmail(db, email);
  if (!user) return res.json(generic);

  // Only the newest link per user is ever valid — requesting again voids earlier ones.
  await deletePasswordResetsForUser(db, user.id);
  const token = newToken();
  await createPasswordReset(db, { token, userId: user.id, expiresAt: Date.now() + PASSWORD_RESET_TTL_MS });
  const resetUrl = `${BASE_URL}/set-password.html?token=${token}`;
  const mail = await sendPasswordResetEmail(user.email, resetUrl);
  res.json({ ...generic, devResetLink: mail.sent ? undefined : mail.devLink });
});

app.post('/api/auth/set-password', async (req, res) => {
  const { token, password } = req.body || {};
  const record = token && await getPasswordReset(db, token);
  if (!record || Number(record.expires_at) < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one from the login page.' });
  }
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const passwordHash = await hashPassword(password);
  await setUserPasswordHash(db, record.user_id, passwordHash);
  await deletePasswordResetsForUser(db, record.user_id);
  // Whoever set a password just proved they control the mailbox — the same thing
  // email verification proves — so treat the account as verified too.
  await markUserVerified(db, record.user_id);
  // The old password is gone; log out every existing session (all devices).
  await deleteSessionsForUser(db, record.user_id);
  res.json({ ok: true, message: 'Password updated — you can log in with the new password now.' });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? await getUserByEmail(db, email) : null;
  // Always run exactly one bcrypt compare — against a fixed dummy hash when the email
  // doesn't exist — so response timing can't be used to enumerate accounts.
  const passwordOk = await verifyPassword(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!passwordOk) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in', needsVerification: true });
  }
  const token = newToken();
  await createSession(db, { token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await deleteSession(db, req.token);
  res.status(204).end();
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json(publicUser(req.user));
});

// Re-consent: when the policy version moves past what an account accepted, the
// UI prompts before the app is usable. This is the recorded acceptance — the
// version stays server-authoritative (PRIVACY_VERSION), never client-supplied.
app.post('/api/auth/consent', auth, async (req, res) => {
  const { agree } = req.body || {};
  if (agree !== true) return res.status(400).json({ error: 'You must agree to the Privacy Policy to continue' });
  await setUserConsent(db, req.userId, PRIVACY_VERSION, Date.now());
  res.json(publicUser(await getUserById(db, req.userId)));
});

// ============ ACCOUNT: Gemini key ============
app.post('/api/account/gemini-key', auth, async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || apiKey.length < 10) return res.status(400).json({ error: 'A Gemini API key is required' });
  try {
    await testGeminiKey(apiKey); // cheap call — lists models, doesn't burn generation quota
    await setUserGeminiKey(db, req.userId, encrypt(apiKey));
    res.json({ connected: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/account/gemini-key', auth, async (req, res) => {
  await clearUserGeminiKey(db, req.userId);
  res.status(204).end();
});

// Self-service data export — the other half of the deletion promise: take your
// stuff with you before you go. One JSON file with the account (secrets aside),
// every draft with its analysis/listings, and each photo inline as base64 so the
// download stands alone once the account is gone.
app.get('/api/account/export', auth, async (req, res) => {
  const drafts = await listDrafts(db, req.userId);
  const photos = {};
  for (const draft of drafts) {
    const photoId = photoIdFromThumb(draft.thumb);
    if (!photoId || photos[photoId]) continue;
    const photo = await readPhoto(photoId);
    if (!photo) continue; // file already gone — export what still exists
    photos[photoId] = { mimetype: photo.mimetype, base64: photo.buffer.toString('base64') };
  }

  const exportedAt = new Date().toISOString();
  const payload = {
    exportedAt,
    note: 'Thriftly data export. Drafts reference photos by filename; the photo bytes are in "photos" as base64.',
    account: publicUser(req.user),
    drafts,
    photos,
  };
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="thriftly-export-${exportedAt.slice(0, 10)}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Self-service account deletion — the privacy policy promises it, so it's a real
// endpoint: drafts + their photos, sessions, and every pending token go, then the
// user row itself. Idempotent-safe: 404 once the account is gone.
app.delete('/api/account', auth, async (req, res) => {
  for (const draft of await listDrafts(db, req.userId)) {
    const photoId = photoIdFromThumb(draft.thumb);
    if (photoId) await deletePhoto(photoId);
  }
  await clearDrafts(db, req.userId);
  await deleteSessionsForUser(db, req.userId);
  await deleteEmailVerificationsForUser(db, req.userId);
  await deletePasswordResetsForUser(db, req.userId);
  await deleteUserRow(db, req.userId);
  res.status(204).end();
});

function usersGeminiKey(user) {
  if (!user.gemini_key_enc) return null;
  return decrypt(user.gemini_key_enc);
}

// ============ THE REAL PIPELINE ============

// Photo in -> identify + price it (using THIS user's own Gemini key) -> save as a new draft
app.post('/api/scan', auth, scanLimiter, upload.single('photo'), async (req, res) => {
  try {
    const apiKey = usersGeminiKey(req.user);
    if (!apiKey) return res.status(400).json({ error: 'Connect your Gemini API key in Settings before scanning' });
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded — send multipart/form-data with field name "photo"' });
    // iPhone photos are HEIC by default, and this build's sharp cannot decode
    // HEVC — so say what to do, rather than "unsupported image type". The browser
    // re-encodes HEIC to JPEG before upload when it can, which is why this is the
    // fallback path and not the normal one.
    const heicMessage =
      'That looks like an iPhone HEIC photo, which Thriftly can\'t read directly. ' +
      'On the iPhone: Settings → Camera → Formats → Most Compatible, then retake it — ' +
      'or open Photos, share/export the photo as JPEG and upload that.';
    // Signature before the declared type: a HEIC uploaded as image/heic, as
    // image/jpeg, or as application/octet-stream (some clients label uploads
    // that way) should all get the same instruction rather than "unsupported
    // image type: application/octet-stream".
    if (looksLikeHeic(req.file.buffer)) return res.status(415).json({ error: heicMessage });

    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: `Unsupported image type: ${req.file.mimetype}. Use jpeg, png, gif, or webp.`,
      });
    }

    // One resize pass serves both consumers: the (smaller) same image goes to
    // Gemini and to disk. The upload never survives in full size.
    let normalized;
    try {
      normalized = await shrink(req.file.buffer);
    } catch (err) {
      const bad = new Error('That file couldn\'t be read as an image — try a jpg, png, gif, or webp.');
      bad.status = 400;
      throw bad;
    }
    const base64 = normalized.buffer.toString('base64');
    const analysis = await callGeminiJSON({
      apiKey, system: ANALYZE_SYSTEM_PROMPT, parts: analyzeParts(base64, normalized.mimetype),
    });

    // Photo stored as a resized file, referenced by URL — see photos.js.
    const photo = await savePhoto(normalized.buffer, normalized.mimetype);
    let draft;
    try {
      draft = await createDraft(db, req.userId, { analysis, thumb: photo.url, selected: PLATFORMS });
    } catch (err) {
      // The upload is already stored; don't leave it orphaned when the row fails.
      await deletePhoto(photo.photoId).catch(() => {});
      throw err;
    }
    res.status(201).json(draft);
  } catch (err) {
    sendError(res, err);
  }
});

// Saved analysis -> real per-platform listing drafts (using THIS user's own key) -> saved back
app.post('/api/drafts/:id/generate-listing', auth, async (req, res) => {
  try {
    const apiKey = usersGeminiKey(req.user);
    if (!apiKey) return res.status(400).json({ error: 'Connect your Gemini API key in Settings before generating listings' });

    const existing = await getDraft(db, req.userId, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Draft not found' });

    const generated = await callGeminiJSON({
      apiKey, system: LISTING_SYSTEM_PROMPT, parts: listingParts(existing.analysis), maxTokens: 900,
    });

    const missing = PLATFORMS.filter(p => !generated[p]);
    if (missing.length) return res.status(502).json({ error: `Model response was missing: ${missing.join(', ')}`, raw: generated });

    const listingsPatch = {};
    for (const platform of PLATFORMS) {
      listingsPatch[platform] = { ...generated[platform], posted: existing.listings[platform]?.posted || false };
    }

    res.json(await updateDraft(db, req.userId, req.params.id, { listings: listingsPatch }));
  } catch (err) {
    sendError(res, err);
  }
});

// ============ DRAFT CRUD (all scoped to the logged-in user) ============

// Photo serving doesn't need a Bearer token: <img> tags can't send headers, and
// the ids are 128-bit random names — unguessable, therefore effectively ACL'd.
app.get('/api/photos/:id', async (req, res) => {
  const photo = await readPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  res.set('Content-Type', photo.mimetype);
  res.set('Cache-Control', 'private, max-age=31536000, immutable'); // content never changes for a given id
  res.send(photo.buffer);
});
app.get('/api/drafts', auth, async (req, res) => res.json(await listDrafts(db, req.userId)));

app.get('/api/drafts/:id', auth, async (req, res) => {
  const draft = await getDraft(db, req.userId, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

app.put('/api/drafts/:id', auth, async (req, res) => {
  const updated = await updateDraft(db, req.userId, req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Draft not found' });
  res.json(updated);
});

app.delete('/api/drafts/:id', auth, async (req, res) => {
  const existing = await getDraft(db, req.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Draft not found' });
  await deleteDraft(db, req.userId, req.params.id);
  const photoId = photoIdFromThumb(existing.thumb);
  if (photoId) await deletePhoto(photoId); // best-effort: the draft row is already gone
  res.status(204).end();
});

app.delete('/api/drafts', auth, async (req, res) => {
  for (const draft of await listDrafts(db, req.userId)) {
    const photoId = photoIdFromThumb(draft.thumb);
    if (photoId) await deletePhoto(photoId);
  }
  await clearDrafts(db, req.userId);
  res.status(204).end();
});

// Health checks are public and unauthenticated: expose liveness only, never
// filesystem paths or configuration.
app.get('/api/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, uptime: Math.round(process.uptime()) }));

// Readiness differs from liveness: it touches the database, so a monitor can
// tell "process up" apart from "process able to serve". Point an external uptime
// check here once the app runs on Postgres. Render's own health check stays on
// /api/health so a database blip can't put the service into a restart loop.
app.get('/api/ready', async (_req, res) => {
  try {
    await ping(db);
  } catch (err) {
    console.error('[ready] database ping failed:', err && err.message);
    return res.status(503).json({ ok: false, db: db.kind });
  }
  // Storage credentials existing is not the same as the bucket answering: a
  // renamed bucket or a revoked key only shows up on the first scan otherwise.
  const storage = await checkStorage();
  if (storage.configured && !storage.ok) {
    console.error(`[ready] Supabase Storage unusable — ${storage.reason}`);
    return res.status(503).json({ ok: false, db: db.kind, storage: 'unreachable', detail: storage.reason });
  }
  res.json({ ok: true, db: db.kind, storage: storage.configured ? 'ok' : 'not-configured' });
});

// Async route/middleware failures reach one place; sendError keeps 5xx details
// in the server log and 4xx messages client-actionable.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  sendError(res, err);
});

// ---------- scheduled backups ----------
// Optional and off by default. On Render, set BACKUP_INTERVAL_HOURS=24 and keep
// BACKUP_DIR inside the mounted disk (/app/data/backups): a Render cron job is a
// separate service and cannot read this service's disk. Off-provider upload
// still needs BACKUP_UPLOAD_CMD (see docs/backup-restore.md).
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 0);
let backupTimer = null;
if (BACKUP_INTERVAL_HOURS > 0 && db.kind !== 'pg') {
  const intervalMs = Math.max(5000, Math.round(BACKUP_INTERVAL_HOURS * 60 * 60 * 1000));
  if (!process.env.BACKUP_DIR) {
    console.warn('[backup] BACKUP_DIR is not set — archives may live outside the persistent disk and be lost on redeploy.');
  }
  backupTimer = setInterval(async () => {
    try {
      const result = await runBackup();
      console.log(`[backup] wrote ${result.name} (${result.sizeMb} MB, ${result.photos} photo file(s))`);
      for (const file of result.pruned) console.log(`[backup] pruned ${file}`);
    } catch (err) {
      console.error('[backup] scheduled backup failed:', err.message);
    }
  }, intervalMs);
  backupTimer.unref();
  console.log(`[backup] scheduled every ${BACKUP_INTERVAL_HOURS}h into ${process.env.BACKUP_DIR || 'backups/'}`);
} else if (BACKUP_INTERVAL_HOURS > 0) {
  console.log('[backup] Postgres backend — use Supabase backups/PITR instead of the SQLite scheduler');
}

const PORT = process.env.PORT || 3001;

// A production process whose bucket doesn't answer would boot happily and then
// fail every scan, so prove the bucket before accepting traffic. In development
// a failure is only a warning, because the tests deliberately run against fakes.
(async () => {
  if (db.kind === 'pg' && storageEnabled()) {
    const storage = await checkStorage();
    if (storage.ok) {
      console.log(`[startup] Supabase Storage bucket "${storage.bucket}" reachable`);
    } else {
      console.error(`[startup] Supabase Storage is configured but unusable — ${storage.reason}`);
      console.error(`[startup] check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and that a private bucket named "${storage.bucket}" exists (docs/SUPABASE.md step 4).`);
      if (process.env.NODE_ENV === 'production') process.exit(1);
    }
  }
  app.listen(PORT, () => console.log(`Thriftly backend (multi-user, Gemini-powered) at http://localhost:${PORT}`));
})();

async function shutdown(signal) {
  console.log(`[shutdown] ${signal} — closing database`);
  clearInterval(cleanupTimer);
  if (backupTimer) clearInterval(backupTimer);
  try {
    await db.close();
  } catch (err) {
    console.error('[shutdown] close failed:', err.message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
