#!/usr/bin/env node
// Restore a Thriftly backup archive (output of scripts/backup.mjs).
//
// Usage:
//   node scripts/restore.mjs <archive.tar.gz> [--target <dir>] [--force]
//
// Safety: verifies the .sha256 sidecar when present, extracts to a temp dir,
// runs SQLite integrity_check on the restored database, and refuses to touch a
// non-empty target without --force. Stop the app first when restoring a live
// data directory — SQLite must reopen the files afterwards.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const archiveArg = args[0];
if (!archiveArg || archiveArg.startsWith('--')) {
  console.error('usage: node scripts/restore.mjs <archive.tar.gz> [--target <dir>] [--force]');
  process.exit(2);
}
const archive = path.resolve(archiveArg);
let target = path.resolve(process.env.DATA_DIR || 'data');
let force = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--target') {
    if (!args[i + 1]) { console.error('restore: --target needs a directory'); process.exit(2); }
    target = path.resolve(args[++i]);
  } else if (args[i] === '--force') {
    force = true;
  } else {
    console.error(`restore: unknown argument ${args[i]}`);
    process.exit(2);
  }
}

function fail(msg) {
  console.error(`restore: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(archive)) fail(`no archive at ${archive}`);

// 1) Checksum first — never extract unverified bytes.
const sidecar = `${archive}.sha256`;
if (fs.existsSync(sidecar)) {
  const expected = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
  const hash = createHash('sha256');
  const data = fs.readFileSync(archive);
  hash.update(data);
  const actual = hash.digest('hex');
  if (actual !== expected) fail(`sha256 mismatch (expected ${expected}, got ${actual}) — archive is corrupt`);
  console.log('restore: sha256 OK');
} else {
  console.warn('restore: no .sha256 sidecar next to the archive — skipping checksum verification');
}

// 2) Extract and validate the database before it can replace anything live.
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'thriftly-restore-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
  const dbName = fs.readdirSync(staging).find((f) => f.endsWith('.db'));
  if (!dbName) fail('archive contains no .db file');

  const db = new Database(path.join(staging, dbName), { readonly: true });
  const integrity = db.pragma('integrity_check', { simple: true });
  db.close();
  if (integrity !== 'ok') fail(`restored database failed integrity_check: ${integrity}`);
  console.log(`restore: database integrity OK (${dbName})`);

  const existing = fs.existsSync(target) ? fs.readdirSync(target) : [];
  if (existing.length && !force) {
    fail(`target ${target} is not empty — stop the app and re-run with --force to overwrite`);
  }

  // 3) Install. Stale -wal/-shm files from the previous database must go, or
  // SQLite could replay WAL pages belonging to the old data.
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry.endsWith('.db') || entry.endsWith('.db-wal') || entry.endsWith('.db-shm')) {
      fs.rmSync(path.join(target, entry), { force: true });
    }
  }
  fs.rmSync(path.join(target, 'photos'), { recursive: true, force: true });
  fs.cpSync(staging, target, { recursive: true });

  const restored = fs.readdirSync(target);
  console.log(`restore: wrote ${restored.length} entr${restored.length === 1 ? 'y' : 'ies'} into ${target}`);
  console.log('restore: done — restart the app now so SQLite reopens the restored files.');
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
