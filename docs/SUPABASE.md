# Supabase migration (Postgres + Storage)

Thriftly ships on SQLite + a local photo directory. This is the runbook for
moving it to Supabase Postgres and Supabase Storage, and for deploying the
result on Render.

**Current status:** the app still runs on SQLite. The schema
([db/schema.sql](../db/schema.sql)) and the data-copy script
([scripts/migrate-to-postgres.mjs](../scripts/migrate-to-postgres.mjs)) are
ready; the async data layer and Storage backend are the next commit. That code
must be exercised against the real database before it replaces SQLite in
production.

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

## 5. Copy the data

With the app still on SQLite (so writes are consistent), run:

```bash
DATABASE_URL=... node scripts/migrate-to-postgres.mjs
```

The script reads `data/thriftly.db`, upserts every user and draft, copies
sessions/tokens, verifies per-table counts, and commits only if nothing is
missing. It is idempotent and safe to re-run. It does **not** copy photos:
Storage migration is a separate step once the bucket exists.

Do this during a quiet window, or re-run it immediately before cutover (user
rows are upserted; tokens are insert-if-absent).

## 6. Cut over the app

The cutover commit must:

- select the Postgres backend when `DATABASE_URL` is set (SQLite stays for
  local dev and tests);
- make the data layer async end to end, including `requireAuth`;
- store photos through Supabase Storage when configured (local disk otherwise),
  keeping `/api/photos/:id` as the public URL;
- replace the SQLite backup scheduler with the Supabase backup/PITR story on
  your plan, plus an off-provider export;
- add a CI job against a real Postgres service so the SQL is exercised on every
  push;
- remove the Render disk and `BACKUP_*` vars from `render.yaml` once production
  no longer writes to disk.

**Do not delete the SQLite data or Render disk until** the Postgres app has run
cleanly for a full backup cycle.

## 7. Deploy on Render

`render.yaml` already carries the service, health check and env slots. With
Supabase:

- `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET` added as secrets;
- no persistent disk (remove the `disk:` block only after cutover is verified);
- `BASE_URL` set to the public origin;
- SMTP and Turnstile configured as in [LAUNCH.md](LAUNCH.md).

## Backups and deletion

Supabase's automated backups and PITR depend on the plan — check what your
project actually has, and keep an independent export either way. Account
deletion must remove Storage objects too; the current SQLite delete path only
removes local files, so the cutover has to call Storage delete for each photo.
