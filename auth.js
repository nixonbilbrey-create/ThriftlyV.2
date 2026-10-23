const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------- passwords ----------
// Async (thread-pool) variants — bcrypt's sync forms block the event loop ~100ms per call.
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Fixed hash used to equalize login timing: when an email doesn't exist we still run one
// bcrypt compare against this, so response time can't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('thriftly-timing-equalizer', 10);

// ---------- session tokens ----------
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---------- at-rest encryption for stored Gemini keys (AES-256-GCM) ----------
function getEncryptionKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be set in .env as a 64-character hex string (32 bytes). ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------- auth middleware ----------
// Reads "Authorization: Bearer <token>", looks the session up, attaches req.userId / req.user.
function requireAuth(db) {
  const { getSession, getUserById } = require('./db');
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization header (Bearer token)' });

    const session = getSession(db, token);
    if (!session || session.expires_at < Date.now()) {
      return res.status(401).json({ error: 'Invalid or expired session — log in again' });
    }
    const user = getUserById(db, session.user_id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.token = token;
    req.userId = user.id;
    req.user = user;
    next();
  };
}

module.exports = {
  SESSION_TTL_MS, EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS, hashPassword, verifyPassword, DUMMY_HASH, newToken, encrypt, decrypt, requireAuth,
};
