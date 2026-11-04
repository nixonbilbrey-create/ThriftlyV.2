#!/usr/bin/env node
// CLI wrapper around backup.js — produces one checksummed archive of the SQLite
// database and photos. Safe while the app is serving. See docs/backup-restore.md.
//
// Env (all optional):
//   DB_PATH=...              default data/thriftly.db
//   PHOTOS_DIR=...           default data/photos
//   BACKUP_DIR=...           default backups/  (on a small disk use /tmp)
//   BACKUP_RETENTION_DAYS=7  local archives older than this are pruned
//   BACKUP_UPLOAD_CMD=...    shell command run after the archive is written;
//                            {file}, {sha256} and {name} are substituted, e.g.
//                            rclone copy {file} r2:thriftly-backups/prod
import backupModule from '../backup.js';

const { runBackup } = backupModule;

try {
  const result = await runBackup();
  console.log(`backup: wrote ${result.archive}`);
  console.log(`backup: ${result.sizeMb} MB, ${result.photos} photo file(s), sha256 ${result.sha256}`);
  if (result.uploaded) {
    console.log('backup: uploaded via BACKUP_UPLOAD_CMD');
  } else {
    console.log('backup: BACKUP_UPLOAD_CMD not set — archive is LOCAL only (still not off-provider).');
  }
  for (const file of result.pruned) console.log(`backup: pruned ${file}`);
} catch (err) {
  console.error(`backup: ${err.message}`);
  process.exit(1);
}
