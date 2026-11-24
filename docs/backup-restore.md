# Backups and restore

Production data lives in Supabase, not on the app's host:

| Where | Contents |
|---|---|
| Supabase Postgres | Accounts, password hashes, sessions, verification/reset tokens, drafts |
| Supabase Storage, private `photos` bucket | Draft photos (resized JPEGs; the 128-bit object id is the only access control) |

The Render container is disposable — no disk, nothing durable on it — so a
redeploy, a crash or a lost instance costs nothing. That also means the only
thing between you and losing every account is what Supabase keeps and what you
copy out of it yourself.

## Two layers, on purpose

1. **Supabase's own backups.** Dashboard → Database → Backups. Daily backups on
   the free plan; point-in-time recovery depends on what you're paying for.
   Lives in the same provider account as the app, so it covers "a row was
   deleted", not "the account is gone".
2. **An independent export you keep elsewhere.** A `pg_dump` of the database plus
   a copy of the bucket, stored off Supabase (R2/S3/B2, or a download you keep
   on your own machine). This is the layer that survives a provider problem.

Neither counts as a backup until one has been restored. The drill at the end is
what turns them into one.

## The independent export

Two commands, both safe against the live app (they only read):

```bash
# 1) database — consistent dump, no locking of the running service
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "thriftly-$(date +%F).dump"

# 2) photos — the private bucket, object ids unchanged
# --remote targets the linked hosted project (CLI v3 defaults to the local
# stack); --experimental is still required on the storage subcommands.
supabase --experimental storage cp --recursive --remote \
  ss:///photos "./thriftly-photos-$(date +%F)"
```

- `pg_dump` against the **session pooler** URI works the same as against a direct
  connection. Use a client at least as new as the server (Postgres 17), or it
  refuses and tells you so.
- The Storage copy needs the Supabase CLI (logged in and linked), or any S3
  client against the project's Storage endpoint (dashboard → Storage → S3 access
  keys). The CLI version is single-threaded and slow past a few thousand
  objects — `-j` raises the parallelism, and a large bucket is easier through
  the S3 endpoint. **Keep the object names.** A draft's image is
  `/api/photos/<object id>`, so a restore that renames objects breaks every
  draft image.
- Check the dump opened cleanly before trusting it:

```bash
pg_restore --list thriftly-<date>.dump | grep -c "TABLE DATA"
```

Five means it captured every table: `users`, `sessions`, `email_verifications`,
`password_resets`, `drafts`.

Then get both files somewhere else. An export sitting beside the thing it backs
up is not a backup.

### On a schedule

Supabase cannot run `pg_dump` for you, and Render has no cron that can read
anything this service owns, so the export is yours to schedule: a GitHub Action
with the connection string in repository secrets, `cron` on a machine you
control, or any runner with `pg_dump` and the Supabase CLI. Daily is plenty at
launch; Supabase's own backups cover the hours in between.

## Restore drill (do this before you need it)

### A. Restore into a scratch project (~10 minutes)

Never restore over live data until the restored copy has been served and
checked.

1. Create a scratch Supabase project (a local Postgres plus a second bucket
   works too), then apply the schema if it is empty:
   `psql "$SCRATCH_DATABASE_URL" -f db/schema.sql`.
2. Restore into it:

   ```bash
   pg_restore --no-owner --no-privileges \
     --dbname "$SCRATCH_DATABASE_URL" thriftly-<date>.dump
   supabase --experimental storage cp --recursive --remote \
     ./thriftly-photos-<date> ss:///photos
   ```

3. Boot the app against the scratch pair and check it like a user:

   ```bash
   PORT=3999 DATABASE_URL="$SCRATCH_DATABASE_URL" \
     SUPABASE_URL="$SCRATCH_SUPABASE_URL" \
     SUPABASE_SERVICE_ROLE_KEY="$SCRATCH_SERVICE_ROLE_KEY" \
     BASE_URL=http://localhost:3999 node server.js
   curl -s localhost:3999/api/ready        # {"ok":true,"db":"pg"}
   ```

   Then log in with an existing account, open the draft list, and load one draft
   photo. All three passing is what "the backup works" means — `/api/ready`
   alone only proves the database answered.

### B. Production drill

The same steps against a scratch Render service pointed at the scratch project.
Verify there, then move the domain. Because the service is stateless, switching
is an env-var change — there is no volume to copy between services and no
window where a disk holds the only copy.

### C. Recovering from Supabase's own backups

Dashboard → Database → Backups (or PITR, if the plan has it) → restore. Fastest
when the database itself is the casualty; it restores the database to a point in
time within the plan's window. Photos are **not** included — reconcile the
bucket against your independent export afterwards.

## The SQLite shape (local development, and only that)

`npm run backup` and `npm run restore` still exist and still work: a checksummed
online SQLite snapshot plus `data/photos/`, integrity-checked before anything is
restored. They serve local development, the smoke tests, and any instance that
has not moved to Supabase.

Under Postgres the in-process scheduler deliberately does nothing; at boot it
logs:

```
[backup] Postgres backend — use Supabase backups/PITR instead of the SQLite scheduler
```

so `BACKUP_INTERVAL_HOURS` is ignored. Don't reintroduce it as the production
backup story: it would archive a SQLite file the app isn't writing to and photos
it isn't storing.

## What "done" looks like

- [ ] Supabase plan's backup window confirmed in the dashboard
- [ ] One `pg_dump` + bucket export stored **off** Supabase
- [ ] `pg_restore --list` shows all five tables
- [ ] Restore drill (A) passed: `/api/ready` ok, login, draft list, photo
- [ ] The export runs on a schedule you will actually keep
- [ ] You know your RPO: Supabase's backup window, or your last export
