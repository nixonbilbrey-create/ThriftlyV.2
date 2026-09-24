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
  initDb, createUser, getUserByEmail, getUserById, publicUser, markUserVerified, setUserGeminiKey, clearUserGeminiKey,
  createSession, getSession, deleteSession, cleanupExpiredSessions, startCleanupLoop,
  createEmailVerification, getEmailVerification, deleteEmailVerificationsForUser, cleanupExpiredVerifications,
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, clearDrafts,
} = db_;
const {
  SESSION_TTL_MS, EMAIL_VERIFICATION_TTL_MS, hashPassword, verifyPassword, DUMMY_HASH, newToken, encrypt, decrypt, requireAuth,
} = require('./auth');
const { sendVerificationEmail } = require('./mailer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  PLATFORMS, MODEL, testGeminiKey, callGeminiJSON,
  ANALYZE_SYSTEM_PROMPT, LISTING_SYSTEM_PROMPT, analyzeParts, listingParts,
} = require('./gemini');

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));

const db = initDb(process.env.DB_PATH);
cleanupExpiredSessions(db);
cleanupExpiredVerifications(db);
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
  const body = { error: err.message || 'Server error' };
  if (err.detail) body.detail = err.detail;
  if (err.raw) body.raw = err.raw;
  res.status(err.status || 500).json(body);
}

// ============ AUTH ============
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (getUserByEmail(db, email)) return res.status(409).json({ error: 'An account with that email already exists' });

  const id = crypto.randomBytes(8).toString('hex');
  const user = createUser(db, { id, email, passwordHash: await hashPassword(password) });

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

    const base64 = req.file.buffer.toString('base64');
    const analysis = await callGeminiJSON({
      apiKey, system: ANALYZE_SYSTEM_PROMPT, parts: analyzeParts(base64, req.file.mimetype),
    });

    const thumb = `data:${req.file.mimetype};base64,${base64}`;
    const draft = createDraft(db, req.userId, { analysis, thumb, selected: PLATFORMS });
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
  res.status(204).end();
});

app.delete('/api/drafts', auth, (req, res) => {
  clearDrafts(db, req.userId);
  res.status(204).end();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, dbPath: db.name }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Thriftly backend (multi-user, Gemini-powered) at http://localhost:${PORT}`));

process.on('SIGINT', () => { clearInterval(cleanupTimer); db.close(); process.exit(0); });
