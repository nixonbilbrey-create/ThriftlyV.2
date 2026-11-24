# Supabase migration (Postgres + Storage)

Thriftly launches on Supabase Postgres + Supabase Storage. This is the runbook
for standing that up on Render, and for moving an existing SQLite instance over
if you have one to carry (a fresh launch skips step 5).

**Current status:** the schema and private `photos` bucket are applied to the
Supabase project. The app boots on Postgres in production mode, and the whole
auth path works against it — signup → verify → login → `/api/auth/me`, with the
rows landing in Postgres and `/api/ready` reporting `pg`. `/api/ready` also asks
Storage for the bucket by name, and a production boot whose bucket does not
answer exits rather than serving an app that cannot store photos (see the
pairing note below). `npm run test:pg`
exercises every table against a throwaway schema; CI runs that and the smoke
suite against a local `postgres:17` service. It has **not yet run against the
live project** — the first Render deploy is that test, followed by the stranger
smoke pass in [LAUNCH.md](LAUNCH.md). `DATABASE_URL` unset still means SQLite,
which is what local development and the tests use.

The pairing is enforced at boot, twice: a production process with `DATABASE_URL`
set but no Storage credentials exits with an explanatory message instead of
silently writing photos to an ephemeral container disk (`PHOTOS_ALLOW_LOCAL=1`
overrides for a host with a real persistent volume), and a process whose bucket
does not answer exits too. That second check is the one that matters
operationally: credentials present is not the same as a working bucket, and
`GET /storage/v1/bucket/<name>` is what tells them apart — 2xx means the key is
accepted and the bucket exists. `/api/ready` reports the database backend **and**
Storage (`"storage":"ok"`), returning 503 when either can't be reached, so an
external monitor catches a Postgres *or* a Storage outage that `/api/health`
would not. Because that endpoint is public, the bucket answer is cached for
`STORAGE_CHECK_TTL_MS` (10 s by default, failures included, concurrent probes
sharing one request) — otherwise health-check traffic would become Storage
traffic.

## 1. Resume the project

The connected project (`odellcwrjcsoeoqqwpmu`, us-east-1, Postgres 17) is
**paused** — free projects pause after inactivity, and until resumed every
connection and SQL call fails with "Database is possibly not accessible".

In the Supabase dashboard: open the project → **Resume project**. If the
project has been paused for a long time, the dashboard will say whether a paid
plan is required.

## 2. Get the connection string

Supabase's direct host (`db.<ref>.supabase.co`) is IPv6-only, and Render's
egress is IPv4. Use the **Supavisor pooler** instead:

- Dashboard → **Connect** → copy the **pooler** string, or build it:
  `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
- Prefer **session mode (port 5432)** for a long-lived single Render service.
  Transaction mode (6543) works for short queries but restricts session-level
  features.
- The database password is shown once at project creation; if it's lost,
  **Settings → Database → Reset database password**. Never paste it into chat.

Add it to this workspace's `.env` (file panel) as `DATABASE_URL`, and to Render
as a secret.

## 3. Apply the schema

Paste [db/schema.sql](../db/schema.sql) into the Supabase **SQL editor**, or:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

The schema is `create table if not exists` — safe to re-run.

## 4. Create the photo bucket

Dashboard → **Storage** → **New bucket**:

- Name: `photos`
- **Private** (the server reads it with the service-role key; the browser never
  talks to Supabase directly)

Add to the environment (workspace `.env` and Render secrets):

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role key>
SUPABASE_STORAGE_BUCKET=photos
```

The service-role key bypasses row-level security. It is server-only: never put
it in `public/`, never return it from an API, and rotate it if it leaks. The
browser continues to use only Thriftly's `/api/photos/:id` route.

## 5. Copy existing data (skip on a fresh launch)

This step is only for an instance that already has users and drafts on SQLite.
A launch with no real users has nothing to move: go straight to step 6.

With the app still on SQLite (so writes are consistent), run:

```bash
DATABASE_URL=... node scripts/migrate-to-postgres.mjs
```

The script reads `data/thriftly.db`, upserts every user and draft, copies
sessions/tokens, verifies per-table counts, and commits only if nothing is
missing. It is idempotent and safe to re-run. It does **not** copy photos:
run the Storage copy separately once the bucket exists:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-photos-to-storage.mjs
```

The photo copy keeps the same object ids, so `draft.thumb` URLs do not change.
It reads files referenced by the SQLite drafts and upserts them into the
bucket; it does not touch the database. `npm test` runs this script against a
fake bucket (see `tests/storage.mjs`), covering byte-for-byte copies, skipped
null/legacy thumbs, idempotent re-runs and the non-zero exit when a referenced
file is missing — but it has not run against your project until you run it here.

Do this during a quiet window, or re-run it immediately before cutover (user
rows are upserted; tokens are insert-if-absent).

## 6. What the app already does (no action needed)

The repo side of the cutover is done; this section is the checklist it meets, so
you can verify it rather than repeat it:

- select the Postgres backend when `DATABASE_URL` is set (SQLite stays for
  local dev and tests);
- make the data layer async end to end, including `requireAuth`;
- store photos through Supabase Storage when configured (local disk otherwise,
  for development), keeping `/api/photos/:id` as the public URL;
- replace the SQLite backup scheduler with the Supabase backup/PITR story on
  your plan, plus an independent export ([backup-restore.md](backup-restore.md));
- add a CI job against a real Postgres service so the SQL is exercised on every
  push;
- carry no Render disk and no `BACKUP_*` vars in `render.yaml` — production
  writes nothing to the container.

This shape has no Render disk. If you are moving an instance that still has
one, keep its SQLite data and volume until the Postgres app has run cleanly for
a full backup cycle; a fresh launch has neither to keep. Do not delete the
Supabase project or its bucket at any point — that is the data.

## 7. Deploy on Render

`render.yaml` carries the service, health check and env slots; there is no disk
to create, and a redeploy or a second instance changes nothing because the
container writes nothing durable.

1. **New + → Blueprint**, connect GitHub, pick the repo, branch `main`.
2. The blueprint prompts once for every `sync: false` variable. Order:
   `ENCRYPTION_KEY` (fresh), `DATABASE_URL` (session pooler), `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, then `SMTP_*`, then Turnstile. Leave `BASE_URL`
   blank — set it after the first deploy, once you know the hostname.
   `SUPABASE_STORAGE_BUCKET` is already `photos`.
3. Watch the first deploy's logs for
   `Supabase Storage bucket "photos" reachable`. If you instead see
   `Supabase Storage is configured but unusable`, the deploy stopped on purpose:
   the bucket name or the service-role key is wrong.
4. Set `BASE_URL` to `https://<service>.onrender.com` and let it redeploy.

### Prove it is really on Supabase

| Check | Pass | Means |
|---|---|---|
| `GET /api/ready` | `{"ok":true,"db":"pg","storage":"ok"}` | Postgres backend selected, bucket answering. `"db":"sqlite"` = `DATABASE_URL` missing. |
| Sign up, then Supabase → Table editor → `users` | the row is there | the app writes to *this* project, not a local file |
| Connect a Gemini key, scan a photo, check Storage → `photos` | one `a1b2…32hex.jpg` object | uploads go to the bucket, and the name is the draft's photo id |
| `curl -I /api/photos/<id>` | 200 `image/jpeg` | the app serves photos back out of Storage |
| Delete the draft | object disappears from the bucket | deletion goes through `deletePhoto()`, not a local unlink |

Upload errors are specific: `Supabase Storage upload failed (400)` is the bucket
name or existence, `(401)`/`(403)` is not the service-role key.

## Backups and deletion

Supabase's automated backups and PITR depend on the plan — check what your
project actually has, and keep an independent export either way. Account and
draft deletion already go through `deletePhoto()` in [photos.js](../photos.js),
which removes the Storage object when Storage is configured and the local file
otherwise — the same code path serves both backends, so there is nothing extra
to wire at cutover.
