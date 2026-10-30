# Backups and restore

Everything Thriftly owns lives under `data/`:

| Path | Contents |
|---|---|
| `data/thriftly.db` | Accounts, password hashes, sessions, verification/reset tokens, drafts |
| `data/photos/` | Draft photos (resized JPEGs; filenames are the only access control) |

Losing that directory means losing every account and every draft. Treat it like
production data even while the app is small.

## Two layers, on purpose

1. **Render's automatic disk snapshot** — Render snapshots an attached disk
   once every 24 hours and keeps snapshots for 7 days
   ([docs](https://render.com/docs/disks)). Good against "the disk was
   deleted/destroyed", but it lives in the same provider account as the app.
2. **Off-provider archives** — `scripts/backup.mjs` produces one tar.gz per run
   (consistent SQLite snapshot + photos + sha256 sidecar) and can upload it
   anywhere. This is the copy that survives "Render account problem".

A backup you have never restored is a guess. The last section is a drill — run
it once now, not on the day you need it.

## The scripts

`scripts/backup.mjs`

```bash
npm run backup
# equivalent: node scripts/backup.mjs
```

- Takes an **online** SQLite snapshot with the SQLite backup API — safe while
  the server is writing. It does not stop or lock the app.
- Runs `PRAGMA integrity_check` on the snapshot and exits non-zero if it fails.
- Copies `data/photos/` as-is and packs everything into
  `backups/thriftly-<timestamp>.tar.gz` + `.sha256`.
- Prunes local archives older than `BACKUP_RETENTION_DAYS` (default 7).
- Config via env: `DB_PATH`, `PHOTOS_DIR`, `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`,
  `BACKUP_UPLOAD_CMD`.

`scripts/restore.mjs`

```bash
npm run restore -- backups/thriftly-<timestamp>.tar.gz --target data --force
```

- Verifies the sha256 sidecar before extracting anything.
- Extracts to a temp dir and runs `integrity_check` **before** touching `data/`.
- Refuses a non-empty target unless `--force` is passed.
- Deletes stale `*.db-wal` / `*.db-shm` files so old WAL pages can't mix with
  restored data.

## Running a backup on Render

Backups must read the service's disk, so they run **inside** the service. Shell
access is available on paid instances (Render docs:
[SSH and shell access](https://render.com/docs/ssh)).

```bash
# In the Render dashboard: your service → Shell
cd /app
BACKUP_DIR=/tmp/backups npm run backup
sha256sum -c /tmp/backups/thriftly-*.tar.gz.sha256
```

Keep archives **off the 1 GB disk** (`/tmp` is ephemeral, which is fine — the
next step uploads them). Then get them off-provider with the upload hook:

```bash
# rclone configured with an R2/B2/S3 remote (recommended: no extra app changes)
BACKUP_DIR=/tmp/backups \
BACKUP_UPLOAD_CMD='rclone copy {file} r2:thriftly-backups/prod && rclone copy {sha256} r2:thriftly-backups/prod' \
npm run backup
```

```bash
# AWS CLI alternative (install it in the image or run from a machine with the
# archive downloaded first)
BACKUP_UPLOAD_CMD='aws s3 cp {file} s3://my-bucket/thriftly/'
```

The image (`node:22-slim`) ships `tar`/`gzip` and Node but **not** `rclone` or
`aws` — either bake one into the Dockerfile, or download the archive to your
machine and upload from there. A one-off copy via `scp`/browser download is a
perfectly valid off-provider backup for low-volume apps.

Until automated, put a recurring reminder in your calendar: **one backup per
week, uploaded, checksum recorded.** Render unchanged means nothing new, but a
delete or corruption is discovered late otherwise.

## Restore drill (do this before you need it)

### A. Local drill — proves the archive is usable (5 minutes)

```bash
# 1) produce an archive from the dev database
BACKUP_DIR=/tmp/bk npm run backup

# 2) restore it somewhere that is NOT the live data dir
npm run restore -- /tmp/bk/thriftly-*.tar.gz --target /tmp/restored-data --force

# 3) boot the app against the restored copy and confirm it works
PORT=3999 DB_PATH=/tmp/restored-data/thriftly.db \
  PHOTOS_DIR=/tmp/restored-data/photos BASE_URL=http://localhost:3999 \
  node server.js
# in another terminal:
curl -s localhost:3999/api/health
# then log in to the UI with an existing account and open a draft + its photo
```

Passing checks: `integrity_check` is `ok` (the restore script enforces it),
login succeeds, the draft list matches, and a photo URL loads.

### B. Restore on Render (planned outage, ~15 minutes)

Preferred: **restore into a new service, then switch over** — the live data is
never overwritten until the restored copy is verified.

1. Take a fresh backup of the current state first (the old data may contain
   accounts created after the backup you're restoring).
2. Create a new Render service from the same repo/image with its own disk at
   `/app/data`, and the same env vars. Don't point your domain at it yet.
3. In the new service's Shell, get the archive and restore:

   ```bash
   cd /tmp
   # download the archive + sidecar (any method: rclone, presigned URL, scp)
   rclone copy r2:thriftly-backups/prod/thriftly-<timestamp>.tar.gz .
   rclone copy r2:thriftly-backups/prod/thriftly-<timestamp>.tar.gz.sha256 .
   cd /app
   DATA_DIR=/app/data npm run restore -- /tmp/thriftly-<timestamp>.tar.gz --force
   ```

4. Restart the new service, run the same checks as the local drill (health,
   login, drafts, photo), then move the custom domain to it.
5. Keep the old service's disk untouched until the new one has run clean for a
   day — it's your rollback.

In-place restore (only when a new service isn't possible): run the same restore
inside the Shell **with the app stopped or immediately before a manual
restart**; the restore script removes stale WAL files, but the running process
still holds the old database open. Restart right after and re-run the checks.

### C. Recovering from a Render disk snapshot

Dashboard → service → Disks → snapshot → restore. This is whole-disk and
replaces everything under the mount, including photos. It's the fastest path
when the disk itself is the casualty, but it restores the disk as of the
snapshot time — up to 24 hours of data can be missing. Use it to get service
back, then cross-check against your newest off-provider archive.

## What "done" looks like

- [ ] One archive created, checksum verified, and downloaded/uploaded off Render
- [ ] Local restore drill (A) passed end-to-end
- [ ] Upload command (or manual routine) runs on a schedule you'll actually keep
- [ ] You know your RPO: ≤24 h (snapshots) and up to the last upload (archives)
