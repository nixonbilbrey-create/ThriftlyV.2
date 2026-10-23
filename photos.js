// ---------- photo storage ----------
// Photos used to live in SQLite as (full-size) base64 data URIs, which bloated
// the database and every backup with megabyte-plus text blobs. Now they're
// files on disk, referenced by an unguessable 128-bit id in drafts.thumb's URL.
//
// This is the ONLY module that knows how photos are stored. If the app outgrows
// single-server disk storage, replace it with an S3/R2 backend that exposes the
// same four functions — server.js and db.js need no further changes.
//
// Serving: GET /api/photos/:id returns the bytes. The id is a 128-bit random
// hex name (no directory traversal possible, and the ids are not guessable,
// which is why the route doesn't need auth — <img> tags can't send Bearer
// headers, so an auth requirement there would mean signed URLs instead).
// Tradeoff: draft image URLs work in any browser, not just the owner's —
// acceptable at this scale precisely because the ids are cryptographically
// unguessable, and worth revisiting if these images ever become sensitive.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

// ---------- photo processing (resize/compress before storing) ----------
// Still full-color for the model, but no longer multi-megabyte: longest edge
// capped at MAX_EDGE, re-encoded as JPEG. Saves SQLite-adjacent disk, network
// room in the Gemini upload, and page-load weight on the drafts sidebar.
const MAX_EDGE = 1400; // px, longest edge after resizing
const JPEG_QUALITY = 82;

// Returns { buffer, mimetype } for the normalized image, or rejects on a
// non-decodable upload (caller turns that into a 400).
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

// How a stored photo is named/validated: 32 hex chars + a short extension.
const PHOTO_ID_RE = /^[a-f0-9]{32}\.(jpg|png|gif|webp)$/;

function ensureDir() {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
}

// Store a photo; returns the filename (the "id") and the URL to hand to clients.
function savePhoto(buffer, mimetype) {
  ensureDir();
  const ext = EXT_FOR_MIME[mimetype] || 'png';
  const photoId = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(PHOTOS_DIR, photoId), buffer);
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

// Read a stored photo back; null if the id is malformed or the file is missing.
function readPhoto(photoId) {
  if (!isValidPhotoId(photoId)) return null;
  try {
    const buffer = fs.readFileSync(path.join(PHOTOS_DIR, photoId));
    const mimetype = MIME_FOR_EXT[path.extname(photoId).slice(1)] || 'application/octet-stream';
    return { buffer, mimetype };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// best-effort delete — a missing file is fine; a write failure is not silenced.
function deletePhoto(photoId) {
  if (!isValidPhotoId(photoId)) return false;
  try {
    fs.unlinkSync(path.join(PHOTOS_DIR, photoId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = { shrink, savePhoto, readPhoto, deletePhoto, isValidPhotoId, photoIdFromThumb, PHOTOS_DIR };
