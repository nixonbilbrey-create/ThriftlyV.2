'use strict';
// ---------- photo storage ----------
// Photos live either in a private Supabase Storage bucket (production) or on
// local disk (development/tests). The rest of the app only knows the four async
// functions below; /api/photos/:id serves the bytes in both modes, so the
// browser never talks to Supabase directly and no credentials reach the client.
//
// Storage object names are the same unguessable 128-bit ids used on disk, which
// keeps existing draft.thumb URLs valid across the migration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// ---------- photo processing (resize/compress before storing) ----------
const MAX_EDGE = 1400; // px, longest edge after resizing
const JPEG_QUALITY = 82;
// Ceiling on what a decoder is allowed to allocate: a 1400px cap only applies
// after the full image has been decoded, so a 200-megapixel header would be a
// memory bomb otherwise. extract.js shares this number rather than keeping its own.
const MAX_PIXELS = 40 * 1000 * 1000;

async function shrink(buffer) {
  const normalized = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
    .rotate() // auto-applies EXIF orientation so sideways phone photos stay upright
    .flatten({ background: '#ffffff' }) // transparent PNGs get paper, not black
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: 'inside', // preserve aspect ratio
      withoutEnlargement: true, // never upscale a small photo
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return { buffer: normalized, mimetype: 'image/jpeg' };
}

const EXT_FOR_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MIME_FOR_EXT = Object.fromEntries(Object.entries(EXT_FOR_MIME).map(([m, e]) => [e, m]));

const PHOTOS_DIR = process.env.PHOTOS_DIR || path.join(__dirname, 'data', 'photos');

// 32 hex chars + a short extension.
const PHOTO_ID_RE = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return {
    url: url.replace(/\/+$/, ''),
    key,
    bucket: process.env.SUPABASE_STORAGE_BUCKET || 'photos',
  };
}

function storageEnabled() {
  return Boolean(storageConfig());
}

// storageEnabled() only proves two env vars are non-empty. The bucket can still
// be missing, renamed, or the key revoked — which stays invisible until the first
// scan fails with a 400 halfway through a user's workflow. This asks Storage
// directly: GET /storage/v1/bucket/<name> answers 2xx only when the key is
// accepted and the bucket exists, so a wrong SUPABASE_STORAGE_BUCKET surfaces at
// boot and on /api/ready instead of on someone's first photo.
async function checkStorageUncached() {
  const config = storageConfig();
  if (!config) {
    return { ok: false, configured: false, reason: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set' };
  }
  try {
    const response = await fetch(`${config.url}/storage/v1/bucket/${encodeURIComponent(config.bucket)}`, {
      headers: { authorization: `Bearer ${config.key}`, apikey: config.key },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return { ok: true, configured: true, bucket: config.bucket };
    const detail = (await response.text().catch(() => '')).slice(0, 160);
    return {
      ok: false,
      configured: true,
      bucket: config.bucket,
      status: response.status,
      reason: `bucket "${config.bucket}" check returned ${response.status}${detail ? `: ${detail}` : ''}`,
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      bucket: config.bucket,
      reason: `bucket "${config.bucket}" check failed: ${err.message}`,
    };
  }
}

// /api/ready is public and every uptime probe hits it, so an uncached check would
// let any caller turn requests into Supabase Storage traffic — and a plain
// health-check flood would do it by accident. Results (failures included) are
// reused for STORAGE_CHECK_TTL_MS, and concurrent callers share one in-flight
// request, so a burst at expiry still costs Storage a single call.
const DEFAULT_STORAGE_CHECK_TTL_MS = 10000;

// The cache is a load limiter on a public endpoint, so a malformed value must not
// quietly switch it off: Number('abc') is NaN, and every TTL comparison against
// NaN is false, which would re-probe Storage on every request while looking
// configured. Anything unparseable, blank or negative falls back to the default
// and says so. An explicit 0 still disables caching, but loudly — that is a real
// foot-gun under probe traffic, not a hidden one.
function resolveStorageCheckTtl(raw) {
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_STORAGE_CHECK_TTL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`[storage] STORAGE_CHECK_TTL_MS="${raw}" is not a valid duration in ms — using ${DEFAULT_STORAGE_CHECK_TTL_MS}`);
    return DEFAULT_STORAGE_CHECK_TTL_MS;
  }
  if (value === 0) {
    console.warn('[storage] STORAGE_CHECK_TTL_MS=0 disables the bucket-check cache: every /api/ready request will call Supabase Storage');
  }
  return value;
}

const STORAGE_CHECK_TTL_MS = resolveStorageCheckTtl(process.env.STORAGE_CHECK_TTL_MS);
let storageCheckCache = null; // { at, result }
let storageCheckInFlight = null;

async function checkStorage() {
  if (storageCheckCache && Date.now() - storageCheckCache.at < STORAGE_CHECK_TTL_MS) {
    return storageCheckCache.result;
  }
  if (!storageCheckInFlight) {
    storageCheckInFlight = checkStorageUncached()
      .then((result) => {
        // Only cache a real answer: a negative TTL or a thrown error should not
        // pin the bucket as broken.
        if (STORAGE_CHECK_TTL_MS > 0) storageCheckCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => { storageCheckInFlight = null; });
  }
  return storageCheckInFlight;
}

function ensureDir() {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

async function storageRequest(photoId, options = {}) {
  const config = storageConfig();
  if (!config) throw new Error('Supabase Storage is not configured');
  const response = await fetch(
    `${config.url}/storage/v1/object/${encodeURIComponent(config.bucket)}/${encodeURIComponent(photoId)}`,
    {
      ...options,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(options.headers || {}),
      },
    },
  );
  return response;
}

// Store a photo under an explicit id (used by savePhoto and the local-to-
// Storage migration). Upserts, so re-running a migration is safe.
async function putPhoto(photoId, buffer, mimetype) {
  if (!isValidPhotoId(photoId)) throw new Error('invalid photo id');
  const config = storageConfig();
  if (config) {
    const response = await storageRequest(photoId, {
      method: 'POST',
      headers: {
        'content-type': mimetype || 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Supabase Storage upload failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    return;
  }
  ensureDir();
  fs.writeFileSync(path.join(PHOTOS_DIR, photoId), buffer);
}

// Store a photo; returns the filename (the "id") and the URL to hand to clients.
async function savePhoto(buffer, mimetype) {
  const ext = EXT_FOR_MIME[mimetype] || 'png';
  const photoId = crypto.randomBytes(16).toString('hex') + '.' + ext;
  await putPhoto(photoId, buffer, mimetype);
  return { photoId, url: `/api/photos/${photoId}` };
}

function isValidPhotoId(photoId) {
  return typeof photoId === 'string' && PHOTO_ID_RE.test(photoId);
}

// drafts.thumb stores the URL; pull the id back out of it (stored "data:" URIs
// from before this change return null and must not be touched).
function photoIdFromThumb(thumb) {
  const match = /^\/api\/photos\/([a-f0-9]{32}\.(?:jpg|png|gif|webp))$/.exec(String(thumb || ''));
  return match ? match[1] : null;
}

async function readPhoto(photoId) {
  if (!isValidPhotoId(photoId)) return null;
  const config = storageConfig();
  if (config) {
    const response = await storageRequest(photoId, { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Supabase Storage read failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimetype = response.headers.get('content-type') || MIME_FOR_EXT[path.extname(photoId).slice(1)] || 'application/octet-stream';
    return { buffer, mimetype };
  }
  try {
    const buffer = fs.readFileSync(path.join(PHOTOS_DIR, photoId));
    const mimetype = MIME_FOR_EXT[path.extname(photoId).slice(1)] || 'application/octet-stream';
    return { buffer, mimetype };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// best-effort delete — a missing object is fine; a write failure is not silenced.
async function deletePhoto(photoId) {
  if (!isValidPhotoId(photoId)) return false;
  const config = storageConfig();
  if (config) {
    const response = await storageRequest(photoId, { method: 'DELETE' });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Supabase Storage delete failed (${response.status})`);
    return true;
  }
  try {
    fs.unlinkSync(path.join(PHOTOS_DIR, photoId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  shrink, savePhoto, putPhoto, readPhoto, deletePhoto,
  isValidPhotoId, photoIdFromThumb, storageEnabled, checkStorage, resolveStorageCheckTtl,
  MAX_PIXELS, PHOTOS_DIR,
};
