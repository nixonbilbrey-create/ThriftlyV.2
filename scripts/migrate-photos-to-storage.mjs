#!/usr/bin/env node
// Copy existing local photo files into the Supabase Storage bucket.
//
// Drafts store /api/photos/<id> URLs and Storage objects use the same id, so
// this script only uploads bytes — it never rewrites the database. It is
// idempotent (uploads upsert), so it is safe to re-run.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_STORAGE_BUCKET=photos \
//     node scripts/migrate-photos-to-storage.mjs
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   SUPABASE_STORAGE_BUCKET                   default photos
//   DB_PATH                                   default data/thriftly.db
//   PHOTOS_DIR                                default data/photos
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import photos from '../photos.js';

const { storageEnabled, putPhoto, photoIdFromThumb, PHOTOS_DIR } = photos;
const DB_PATH = path.resolve(process.env.DB_PATH || 'data/thriftly.db');

function fail(message) {
  console.error(`migrate:photos: ${message}`);
  process.exit(1);
}

if (!storageEnabled()) {
  fail('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}
if (!fs.existsSync(DB_PATH)) fail(`no SQLite database at ${DB_PATH}`);

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare("select distinct thumb from drafts where thumb is not null").all();
db.close();

const ids = [...new Set(rows.map((row) => photoIdFromThumb(row.thumb)).filter(Boolean))];
let uploaded = 0;
let missing = 0;

for (const photoId of ids) {
  const file = path.join(PHOTOS_DIR, photoId);
  if (!fs.existsSync(file)) {
    console.warn(`migrate:photos: ${photoId} referenced by a draft but not on disk — skipped`);
    missing += 1;
    continue;
  }
  const ext = path.extname(photoId).slice(1);
  const mimetype = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[ext] || 'application/octet-stream';
  await putPhoto(photoId, fs.readFileSync(file), mimetype);
  uploaded += 1;
  console.log(`migrate:photos: uploaded ${photoId}`);
}

console.log(`migrate:photos: done — ${uploaded} uploaded, ${missing} missing, ${ids.length} referenced`);
if (missing) process.exitCode = 1;
