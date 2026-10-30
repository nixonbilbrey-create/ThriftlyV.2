require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  console.error(
    'ENCRYPTION_KEY is missing or invalid in .env — it must be a 64-character hex string (32 bytes).\n' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
  process.exit(1);
}

const db_ = require('./db');
const {
  initDb, createUser, getUserByEmail, getUserById, publicUser, markUserVerified, setUserGeminiKey, clearUserGeminiKey, deleteUserRow,
  createSession, getSession, deleteSession, cleanupExpiredSessions, startCleanupLoop,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  createPasswordReset, getPasswordReset, deletePasswordResetsForUser, cleanupExpiredPasswordResets,
  setUserPasswordHash, deleteSessionsForUser,
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts,
} = db_;
const {
  SESSION_TTL_MS, EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS, hashPassword, verifyPassword, DUMMY_HASH, newToken, encrypt, decrypt, requireAuth,
} = require('./auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./mailer');
const { shrink, savePhoto, readPhoto, deletePhoto, photoIdFromThumb } = require('./photos');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  PLATFORMS, MODEL, testGeminiKey, callGeminiJSON,
  ANALYZE_SYSTEM_PROMPT, LISTING_SYSTEM_PROMPT, analyzeParts, listingParts,
} = require('./gemini');

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// Must match the version shown/dated in public/privacy.html. Bump BOTH when the
// policy changes — every signup records it, and /api/auth/me reports it back.
const PRIVACY_VERSION = '2026-10-23';

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
  res.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
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

const db = initDb(process.env.DB_PATH);
cleanupExpiredSessions(db);
cleanupExpiredVerifications(db);
cleanupExpiredPasswordResets(db);
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

// ============ AUTH ============
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password, agree } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  // Consent is enforced server-side, not just by the UI checkbox — an API caller
  // can't create an account that never accepted the privacy policy.
  if (agree !== true) return res.status(400).json({ error: 'You must agree to the Privacy Policy to create an account' });
  if (getUserByEmail(db, email)) return res.status(409).json({ error: 'An account with that email already exists' });

  const id = crypto.randomBytes(8).toString('hex');
  const user = createUser(db, {
    id, email, passwordHash: await hashPassword(password),
    consentVersion: PRIVACY_VERSION, consentAt: Date.now(),
  });

  const token = newToken();
  createEmailVerification(db, { token, userId: user.id, expiresAt: Date.now() + EMAIL_VERIFICATION_TTL_MS });
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;
  const mail = await sendVerificationEmail(email, verifyUrl);

  res.status(201).json({
    message: 'Account created — check your email to verify it before logging in.',
    // Only present when we couldn't actually email it (no SMTP configured, or sending failed) —
    // a real SMTP setup means this never appears. See README before relying on this for real users.
    devVerifyLink: mail.sent ? undefined : mail.devLink,
  });
});

app.get('/api/auth/verify-email', (req, res) => {
  const token = req.query.token;
  const record = token && getEmailVerification(db, token);
  if (!record || record.expires_at < Date.now()) {
    return res.status(400).send(verifyPageHtml({
      ok: false,
      message: 'This verification link is invalid or has expired. Go back and use "Resend verification email" to get a new one.',
    }));
  }
  markUserVerified(db, record.user_id);
  deleteEmailVerificationsForUser(db, record.user_id);
  res.send(verifyPageHtml({ ok: true, message: 'Your email is verified. You can log in now.' }));
});

app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Always the same response, whether or not the account exists or is already verified —
  // don't let this endpoint be used to check who has an account.
  const generic = { message: 'If that email needs verifying, we just sent a new link.' };
  const user = email && getUserByEmail(db, email);
  if (!user || user.email_verified) return res.json(generic);

  deleteEmailVerificationsForUser(db, user.id);
  const token = newToken();
  createEmailVerification(db, { token, userId: user.id, expiresAt: Date.now() + EMAIL_VERIFICATION_TTL_MS });
  const verifyUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;
  const mail = await sendVerificationEmail(email, verifyUrl);
  res.json({ ...generic, devVerifyLink: mail.sent ? undefined : mail.devLink });
});

app.post('/api/auth/request-reset', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  // Same generic response whether or not the account exists — combined with the
  // authLimiter (10/hour/IP), this can't be used to check who has an account.
  const generic = { message: 'If that email has a Thriftly account, we just sent a password-reset link.' };
  const user = email && getUserByEmail(db, email);
  if (!user) return res.json(generic);

  // Only the newest link per user is ever valid — requesting again voids earlier ones.
  deletePasswordResetsForUser(db, user.id);
  const token = newToken();
  createPasswordReset(db, { token, userId: user.id, expiresAt: Date.now() + PASSWORD_RESET_TTL_MS });
  const resetUrl = `${BASE_URL}/set-password.html?token=${token}`;
  const mail = await sendPasswordResetEmail(user.email, resetUrl);
  res.json({ ...generic, devResetLink: mail.sent ? undefined : mail.devLink });
});

app.post('/api/auth/set-password', async (req, res) => {
  const { token, password } = req.body || {};
  const record = token && getPasswordReset(db, token);
  if (!record || record.expires_at < Date.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one from the login page.' });
  }
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const passwordHash = await hashPassword(password);
  setUserPasswordHash(db, record.user_id, passwordHash);
  deletePasswordResetsForUser(db, record.user_id);
  // Whoever set a password just proved they control the mailbox — the same thing
  // email verification proves — so treat the account as verified too.
  markUserVerified(db, record.user_id);
  // The old password is gone; log out every existing session (all devices).
  deleteSessionsForUser(db, record.user_id);
  res.json({ ok: true, message: 'Password updated — you can log in with the new password now.' });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const user = email ? getUserByEmail(db, email) : null;
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
  createSession(db, { token, userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  deleteSession(db, req.token);
  res.status(204).end();
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json(publicUser(req.user));
});

// ============ ACCOUNT: Gemini key ============
app.post('/api/account/gemini-key', auth, async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || apiKey.length < 10) return res.status(400).json({ error: 'A Gemini API key is required' });
  try {
    await testGeminiKey(apiKey); // cheap call — lists models, doesn't burn generation quota
    setUserGeminiKey(db, req.userId, encrypt(apiKey));
    res.json({ connected: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/account/gemini-key', auth, (req, res) => {
  clearUserGeminiKey(db, req.userId);
  res.status(204).end();
});

// Self-service account deletion — the privacy policy promises it, so it's a real
// endpoint: drafts + their photos, sessions, and every pending token go, then the
// user row itself. Idempotent-safe: 404 once the account is gone.
app.delete('/api/account', auth, (req, res) => {
  for (const draft of listDrafts(db, req.userId)) {
    const photoId = photoIdFromThumb(draft.thumb);
    if (photoId) deletePhoto(photoId);
  }
  clearDrafts(db, req.userId);
  deleteSessionsForUser(db, req.userId);
  deleteEmailVerificationsForUser(db, req.userId);
  deletePasswordResetsForUser(db, req.userId);
  deleteUserRow(db, req.userId);
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
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(400).json({ error: `Unsupported image type: ${req.file.mimetype}. Use jpeg, png, gif, or webp.` });
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
    const { url } = savePhoto(normalized.buffer, normalized.mimetype);
    const draft = createDraft(db, req.userId, { analysis, thumb: url, selected: PLATFORMS });
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

    const existing = getDraft(db, req.userId, req.params.id);
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

    res.json(updateDraft(db, req.userId, req.params.id, { listings: listingsPatch }));
  } catch (err) {
    sendError(res, err);
  }
});

// ============ DRAFT CRUD (all scoped to the logged-in user) ============

// Photo serving doesn't need a Bearer token: <img> tags can't send headers, and
// the ids are 128-bit random names — unguessable, therefore effectively ACL'd.
app.get('/api/photos/:id', (req, res) => {
  const photo = readPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  res.set('Content-Type', photo.mimetype);
  res.set('Cache-Control', 'private, max-age=31536000, immutable'); // content never changes for a given id
  res.send(photo.buffer);
});
app.get('/api/drafts', auth, (req, res) => res.json(listDrafts(db, req.userId)));

app.get('/api/drafts/:id', auth, (req, res) => {
  const draft = getDraft(db, req.userId, req.params.id);
  if (!draft) return res.status(404).json({ error: 'Draft not found' });
  res.json(draft);
});

app.put('/api/drafts/:id', auth, (req, res) => {
  const updated = updateDraft(db, req.userId, req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Draft not found' });
  res.json(updated);
});

app.delete('/api/drafts/:id', auth, (req, res) => {
  const existing = getDraft(db, req.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Draft not found' });
  deleteDraft(db, req.userId, req.params.id);
  const photoId = photoIdFromThumb(existing.thumb);
  if (photoId) deletePhoto(photoId); // best-effort: the draft row is already gone
  res.status(204).end();
});

app.delete('/api/drafts', auth, (req, res) => {
  for (const draft of listDrafts(db, req.userId)) {
    const photoId = photoIdFromThumb(draft.thumb);
    if (photoId) deletePhoto(photoId);
  }
  clearDrafts(db, req.userId);
  res.status(204).end();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, dbPath: db.name }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Thriftly backend (multi-user, Gemini-powered) at http://localhost:${PORT}`));

process.on('SIGINT', () => { clearInterval(cleanupTimer); db.close(); process.exit(0); });
