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

async function shrink(buffer) {
  const normalized = await sharp(buffer)
    .rotate() // auto-applies EXIF orientation so sideways phone photos stay upright
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
  isValidPhotoId, photoIdFromThumb, storageEnabled, PHOTOS_DIR,
};
