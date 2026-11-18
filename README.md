# Thriftly Backend — multi-user, bring-your-own-key, Gemini-powered

[![CI](https://github.com/OWNER/thriftly/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/thriftly/actions/workflows/ci.yml)
<!-- Replace OWNER with your GitHub username or org after pushing the repo. -->

Real accounts. Each user connects their own Gemini API key. Every scan and
every generated listing runs on *their* key, not a shared one you pay for.
This is the shape that makes "free for me and the users" actually true: you
never pay for anyone's usage — each person's own free-tier Gemini key funds
their own use of the app.

```
signup/login ──► session token
                    │
                    ▼
Settings: paste a Gemini key ──► validated live, encrypted, stored per-user
                    │
                    ▼
POST /api/scan (their key) ──► Gemini identifies the item + estimates price
                    │            └─ saved as a new draft, owned by them
                    ▼
POST /api/drafts/:id/generate-listing (their key) ──► 4 platform listings
                    │                                    └─ saved onto the draft
                    ▼
GET/PUT/DELETE /api/drafts ──► only ever their own drafts
```

## Why this isn't Claude anymore

Claude's API has no ongoing free tier — a one-time signup credit, then it's
paid. Google's Gemini API does have a real, renewing free tier, which is
what makes a $0-for-the-operator model possible. That's the whole reason
this backend now calls `generativelanguage.googleapis.com` instead of
`api.anthropic.com`. Worth knowing: free-tier usage on most providers,
Google included, generally means your inputs may be used to improve their
models — a real tradeoff for real photos, different from a paid tier's
usual privacy terms. Confirm current terms before relying on this for
anything sensitive.

## Setup

```
cd thriftly-backend
npm install
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # copy this
cp .env.example .env    # paste that value in as ENCRYPTION_KEY
npm start

npm test   # optional: end-to-end smoke test in its own throwaway DB/port
```

Open **http://localhost:3001** — sign up, connect a Gemini key (the page
links straight to https://aistudio.google.com/apikey), then scan a photo.

Each person who runs or uses this needs their **own** Gemini key — there's
no key baked into the server. That's the point.

## Endpoints

**Auth**
| Method | Path | Does what |
|---|---|---|
| POST | `/api/auth/signup` | `{email, password, agree:true}` — consent to the Privacy Policy is required and recorded (version + timestamp) |
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
| POST | `/api/auth/consent` | `{agree:true}` → records acceptance of the current Privacy Policy version (used when the policy changes) |
| POST | `/api/auth/logout` | Invalidates the current session |
| GET | `/api/auth/me` | Current user + whether a Gemini key is connected |
| POST | `/api/auth/request-reset` | `{email}` — always the same response; if the account exists, emails a single-use reset link (valid 1 hour) |
| POST | `/api/auth/set-password` | `{token, password}` — completes a reset, sets the new password, voids the token, kills all existing sessions |

All routes below require `Authorization: Bearer <token>`.

**Account**
| Method | Path | Does what |
|---|---|---|
| POST | `/api/account/gemini-key` | `{apiKey}` → validates it live against Google (a free models-list call, not a billed generation), then encrypts and stores it |
| DELETE | `/api/account/gemini-key` | Removes the stored key |
| GET | `/api/account/export` | Downloads everything the account owns as one JSON file: profile, drafts with analysis/listings, and photos inline (base64) |
| DELETE | `/api/account` | Self-service account deletion: drafts, photos, sessions, tokens, and the user row go immediately (what the privacy policy promises) |

**The pipeline**
| Method | Path | Does what |
|---|---|---|
| POST | `/api/scan` | `multipart/form-data`, field `photo` → identifies + prices the item using **your** key, saves it, returns the draft |
| POST | `/api/drafts/:id/generate-listing` | Drafts real per-platform copy using **your** key, saves it onto the draft. Re-callable — refreshes copy, keeps any `posted` flags. |
| GET/PUT/DELETE | `/api/drafts[/:id]` | Full CRUD, always scoped to the logged-in user — nobody can see or touch another user's drafts |

## Security notes — read before trusting this with real users

This is a real, working multi-user system, but it's a starter one. Specifically:

- **Gemini keys are encrypted at rest** (AES-256-GCM, keyed by your server's
  `ENCRYPTION_KEY`) — not stored as plain text. But whoever controls that
  env var can decrypt every stored key, so protect it like the secret it is.
- **Passwords are hashed** with bcrypt (async variants — logins never block the
  event loop), never stored in plain text. Login always runs exactly one
  bcrypt compare, even for unknown emails (against a fixed dummy hash), so
  response timing can't be used to enumerate accounts.
- **Rate limiting** via express-rate-limit (in-memory, per process): 10 login
  attempts / 15 min keyed by email (fallback: IP), 10 signup or
  resend-verification requests / hour per IP, 30 scans / hour per IP. Limits
  reset on restart — run a single process, or swap in a shared store before
  scaling out.
- **Password reset flow exists** and follows the verification-token playbook:
  request-reset returns the same generic response for known and unknown emails,
  is rate-limited 10/hour per IP, only one live token per user (a new request
  voids the old link), tokens are single-use and expire in 1 hour, and
  completing a reset logs out every existing session for the account. With no
  SMTP configured, the reset link is printed to the console and returned as
  `devResetLink` — same crutch as the verification link; don't ship that way.
  When SMTP IS configured but a send fails, the link is only logged server-side,
  never handed back through the API, so failure windows can't leak live tokens.
  Completing a reset also marks the account's email verified: setting the
  password required reading that mailbox, which is what verification proves.
- **Sessions are simple bearer tokens** stored in SQLite, 30-day expiry, no
  refresh flow. Logging out deletes the row; that's the whole revocation
  story. An hourly cleanup pass purges expired sessions and verification
  tokens from the database.
- **Consent is enforced per account**: every signup must agree to the Privacy
  Policy (checked server-side, not just in the UI), and the account records
  which policy version it accepted. The policy itself is served at
  `/privacy.html`, and account deletion — also promised there — is a real
  endpoint. When you revise the policy, bump both the version in
  `public/privacy.html` and `PRIVACY_VERSION` in `server.js`; existing accounts
  keep the version they agreed to.
- **Baseline security headers** are set on every response: nosniff, deny
  framing, a CSP that permits only self + inline scripts/styles (what the
  harness needs), a restrictive referrer policy, and `no-store` on API
  responses. Add an HSTS header once the app sits behind real HTTPS.
- **Must run behind HTTPS** in anything beyond local testing — tokens,
  passwords, and API keys all travel in plain headers otherwise. 5xx errors
  stay generic to the client (details are logged server-side only), so an
  outage can't leak internals to users.
- **Photos live in private storage**, referenced from each draft by a
  same-origin URL — no multi-megabyte base64 blobs in the database. With
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set they're uploaded to a
  private Supabase Storage bucket; otherwise they're files under
  `data/photos/` (configurable via `PHOTOS_DIR`). Uploads get one resize pass
  first (`photos.js` → `shrink()`): longest edge capped at 1400 px, re-encoded
  as JPEG q82, EXIF orientation auto-applied — and that single normalized
  image is both what Gemini sees and what's stored; the original is never
  kept. They're served without auth over unguessable 128-bit random ids,
  since `<img>` tags can't send Bearer headers; swap in signed URLs if draft
  images ever become sensitive. Object ids survive either backend, so the
  same draft URLs keep working across the move to Supabase. Setting
  `DATABASE_URL` without Storage credentials refuses to boot in production
  (`PHOTOS_ALLOW_LOCAL=1` is the escape hatch), so photos can't silently land
  on an ephemeral container disk.

## Deploying (Render profile)

The app is a long-running Node process with its own SQLite db + photo
files, so it needs a container host with a persistent disk — Render is
the reference target here (starter plan + 1 GB disk ≈ $7.25/mo).
Everything durable lives under `data/` by default (SQLite at
`data/thriftly.db`, photos in `data/photos/`), so the Render disk
mounts once at `/app/data` and covers both. `render.yaml` declares it;
`Dockerfile` builds the image (multi-stage, build tools only in the
build layer).

**Environment variables** (all read from `process.env`, listed in
`.env.example`; on Render they sit in the dashboard, never in the
image):

| Variable | Required | What it does |
|---|---|---|
| `ENCRYPTION_KEY` | yes | 64-char hex (32 bytes); encrypts each user's Gemini key at rest. Server refuses to start without it |
| `BASE_URL` | after first deploy | Public origin used to build verification/reset email links |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | for real email | SMTP relay (e.g. `smtp-relay.brevo.com`, 587, `false` for STARTTLS). Absent → dev mode prints links and returns them in API responses — do not ship that way |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | for real email | Relay credentials + verified sender address |
| `GEMINI_MODEL` | optional | Model override (default `gemini-3.5-flash`) |
| `DB_PATH` / `PHOTOS_DIR` | optional | Overrides for the on-disk locations |
| `TURNSTILE_SITE_KEY` | optional | Cloudflare Turnstile site key — renders the signup CAPTCHA widget |
| `TURNSTILE_SECRET` | optional | Turnstile secret. When set, signup is refused without a valid challenge (fails closed if Cloudflare is unreachable) |
| `DATABASE_URL` | for Postgres | Supabase **session-pooler** URI (port 5432). Set → Postgres data layer; unset → SQLite (local dev, tests) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | with `DATABASE_URL` | Private `photos` bucket. The service-role key is server-only: it must never reach the browser |
| `SUPABASE_STORAGE_BUCKET` | optional | Bucket name; defaults to `photos` |
| `PHOTOS_ALLOW_LOCAL` | optional | `1` lets a Postgres app keep photos on a local disk, for hosts with a real persistent volume |
| `PORT` | optional | Listen port (Render injects it; defaults to 10000 in Docker, 3001 locally) |

> Turning on Turnstile means Cloudflare processes signup visitors' IP
> addresses — the privacy policy (version 2026-11-18) already discloses it in
> the third-party list; leaving the keys blank keeps the CAPTCHA off.

**Postgres + Supabase Storage:** set `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` and the app stops
touching the disk — the SQLite file and photo directory are ignored, the
nightly in-process backup says so in the log, and Supabase's own
backups/PITR become the backup story. [docs/SUPABASE.md](docs/SUPABASE.md) is
the cutover runbook, including the data and photo copy scripts. `/api/health`
stays a pure liveness check for Render; `/api/ready` pings the database, so
point an external uptime monitor at that one.

**Launch readiness:** [docs/LAUNCH.md](docs/LAUNCH.md) is the ordered
checklist for a real launch — repo/CI, SMTP, CAPTCHA, Render, backups,
monitoring and the first post-launch week. Terms of Service live at
`/terms.html` and are linked from signup alongside the Privacy Policy.

**Deploy checklist**

1. `git init` a GitHub repo and push this code to it (Render deploys
   from git or a container registry).
2. In Render: "New +" → Blueprint → pick the repo; the `render.yaml`
   pre-fills the service, health check (`/api/health`) and the 1 GB
   disk at `/app/data`.
3. Generate a fresh `ENCRYPTION_KEY` for this environment
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
   and fill in the `SMTP_*` values in Render → Environment.
4. First deploy → note the `*.onrender.com` URL → set `BASE_URL` to it
   (or your custom domain) → redeploy so email links point at the
   right origin. Passthrough deploys won't change the disk mount.
5. Smoke-test the live deploy: `/api/health` and `/api/ready`, a full signup →
   verify email → login flow, a photo scan, and a password reset with SMTP.
6. Add a custom domain in Render → Settings → Networking (HTTPS cert
   is managed). HTTP behind the proxy is fine — the HSTS header is the
   one to add on top.

**Backups:** Render snapshots the disk daily (kept 7 days), but a disk is
not a backup. `npm run backup` writes one checksummed archive of the
SQLite database (online snapshot, integrity-checked) plus photos, with
an optional upload hook (`BACKUP_UPLOAD_CMD`) for R2/S3/B2;
`npm run restore` verifies and restores it. Setting
`BACKUP_INTERVAL_HOURS=24` (already in `render.yaml`) runs the same backup
nightly inside the server, because a Render cron job can't read the
service's disk; keep `BACKUP_DIR` inside `/app/data`. See
[docs/backup-restore.md](docs/backup-restore.md) for the Render runbook
and the restore drill — run the drill once before you need it.

## What changed from the single-user version

- `analysis`/`listings` on a draft are unchanged in shape.
- Every draft now has a `user_id` and every query is scoped to it.
- The AI provider swapped from Anthropic (server-paid) to Gemini
  (user-paid) — same two-step pipeline, same JSON contract, different
  vendor underneath.
- `ebay-auto-post` is still its own separate project, still on hold.
