'use strict';
// Shared backup implementation. Used by the CLI (scripts/backup.mjs) and by the
// in-process nightly scheduler in server.js (BACKUP_INTERVAL_HOURS), because
// Render has no cron that can read a web service's disk.
//
// One consistent, checksummed archive of the SQLite database (online snapshot,
// integrity-checked) plus the photo directory. Safe while the app is serving
// traffic. Config comes from options, falling back to the same env vars the CLI
// documents: DB_PATH, PHOTOS_DIR, BACKUP_DIR, BACKUP_RETENTION_DAYS,
// BACKUP_UPLOAD_CMD. See docs/backup-restore.md.
const Database = require('better-sqlite3');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

async function runBackup(options = {}) {
  const dbPath = path.resolve(options.dbPath || process.env.DB_PATH || 'data/thriftly.db');
  const photosDir = path.resolve(options.photosDir || process.env.PHOTOS_DIR || 'data/photos');
  const backupDir = path.resolve(options.backupDir || process.env.BACKUP_DIR || 'backups');
  const retentionDays = options.retentionDays ?? Number(process.env.BACKUP_RETENTION_DAYS || 7);
  const uploadCmd = options.uploadCmd ?? (process.env.BACKUP_UPLOAD_CMD || '');

  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath} — nothing to back up`);
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `thriftly-${stamp}.tar.gz`;
  const archive = path.join(backupDir, name);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'thriftly-backup-'));
  let photos = 0;

  try {
    // 1) Online snapshot of the live DB. better-sqlite3's backup() is SQLite's
    //    backup API: consistent even while the server writes (WAL included).
    const db = new Database(dbPath, { readonly: true });
    const dbFile = path.join(staging, path.basename(dbPath));
    await db.backup(dbFile);
    db.close();

    const check = new Database(dbFile, { readonly: true });
    const integrity = check.pragma('integrity_check', { simple: true });
    check.close();
    if (integrity !== 'ok') throw new Error(`snapshot failed integrity_check: ${integrity}`);

    // 2) Photos are plain files — copied as-is, same names, so URLs keep working.
    if (fs.existsSync(photosDir)) {
      fs.cpSync(photosDir, path.join(staging, 'photos'), { recursive: true });
      photos = countFiles(path.join(staging, 'photos'));
    }

    // 3) One archive plus a checksum sidecar the restore step verifies.
    execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const sha = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${sha}  ${name}\n`);
  const sizeMb = Number((fs.statSync(archive).size / (1024 * 1024)).toFixed(2));

  // 4) Upload off-provider, if configured. Local retention stays independent of
  //    whatever lifecycle policy the remote bucket has.
  if (uploadCmd) {
    const cmd = uploadCmd
      .replaceAll('{file}', archive)
      .replaceAll('{sha256}', `${archive}.sha256`)
      .replaceAll('{name}', name);
    execFileSync('/bin/sh', ['-c', cmd], { stdio: 'inherit' });
  }

  const pruned = [];
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(backupDir)) {
      if (!/^thriftly-.*\.tar\.gz$/.test(file)) continue;
      const local = path.join(backupDir, file);
      if (fs.statSync(local).mtimeMs < cutoff) {
        fs.rmSync(local, { force: true });
        fs.rmSync(`${local}.sha256`, { force: true });
        pruned.push(file);
      }
    }
  }

  return { archive, name, sha256: sha, photos, sizeMb, pruned, uploaded: Boolean(uploadCmd) };
}

module.exports = { runBackup };
