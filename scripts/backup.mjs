#!/usr/bin/env node
// Thriftly backup: one consistent, checksummed archive of the SQLite database
// and the photo directory, safe to run while the app is serving traffic.
//
// Env (all optional):
//   DB_PATH=...              default data/thriftly.db
//   PHOTOS_DIR=...           default data/photos
//   BACKUP_DIR=...           default backups/  (on a small disk use /tmp)
//   BACKUP_RETENTION_DAYS=7  local archives older than this are pruned
//   BACKUP_UPLOAD_CMD=...    shell command run after the archive is written;
//                            {file}, {sha256} and {name} are substituted, e.g.
//                            rclone copy {file} r2:thriftly-backups/prod
//
// Exits non-zero unless the snapshot passed SQLite integrity_check and both the
// archive and its .sha256 sidecar were written. See docs/backup-restore.md.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.resolve(process.env.DB_PATH || 'data/thriftly.db');
const PHOTOS_DIR = path.resolve(process.env.PHOTOS_DIR || 'data/photos');
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || 'backups');
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);
const UPLOAD_CMD = process.env.BACKUP_UPLOAD_CMD || '';

function fail(msg) {
  console.error(`backup: ${msg}`);
  process.exit(1);
}

function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) n++;
  }
  return n;
}

if (!fs.existsSync(DB_PATH)) fail(`no database at ${DB_PATH} — nothing to back up`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `thriftly-${stamp}.tar.gz`;
const archive = path.join(BACKUP_DIR, name);
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'thriftly-backup-'));
let photos = 0;

try {
  // 1) Online snapshot of the live DB. better-sqlite3's backup() is SQLite's
  //    backup API: consistent even while the server writes (WAL included).
  const db = new Database(DB_PATH, { readonly: true });
  const dbFile = path.join(staging, path.basename(DB_PATH));
  await db.backup(dbFile);
  db.close();

  const check = new Database(dbFile, { readonly: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  if (integrity !== 'ok') fail(`snapshot failed integrity_check: ${integrity}`);

  // 2) Photos are plain files — copied as-is, same names, so URLs keep working.
  if (fs.existsSync(PHOTOS_DIR)) {
    fs.cpSync(PHOTOS_DIR, path.join(staging, 'photos'), { recursive: true });
    photos = countFiles(path.join(staging, 'photos'));
  }

  // 3) One archive plus a checksum sidecar the restore step verifies.
  execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}

const sha = sha256File(archive);
fs.writeFileSync(`${archive}.sha256`, `${sha}  ${name}\n`);
const sizeMb = (fs.statSync(archive).size / (1024 * 1024)).toFixed(2);
console.log(`backup: wrote ${archive}`);
console.log(`backup: ${sizeMb} MB, ${photos} photo file(s), sha256 ${sha}`);

// 4) Upload off-provider, if configured. Local retention stays independent of
//    whatever lifecycle policy the remote bucket has.
if (UPLOAD_CMD) {
  const cmd = UPLOAD_CMD
    .replaceAll('{file}', archive)
    .replaceAll('{sha256}', `${archive}.sha256`)
    .replaceAll('{name}', name);
  console.log(`backup: uploading: ${cmd}`);
  execFileSync('/bin/sh', ['-c', cmd], { stdio: 'inherit' });
} else {
  console.log('backup: BACKUP_UPLOAD_CMD not set — archive is LOCAL only (still not off-provider).');
}

if (RETENTION_DAYS > 0) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    if (!/^thriftly-.*\.tar\.gz$/.test(file)) continue;
    const local = path.join(BACKUP_DIR, file);
    if (fs.statSync(local).mtimeMs < cutoff) {
      fs.rmSync(local, { force: true });
      fs.rmSync(`${local}.sha256`, { force: true });
      console.log(`backup: pruned ${file} (older than ${RETENTION_DAYS}d)`);
    }
  }
}
