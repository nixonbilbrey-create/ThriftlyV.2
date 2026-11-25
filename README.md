# Thriftly Backend — multi-user, bring-your-own-key, Gemini-powered

[![CI](https://github.com/nixonbilbrey-create/ThriftlyV.2/actions/workflows/ci.yml/badge.svg)](https://github.com/nixonbilbrey-create/ThriftlyV.2/actions/workflows/ci.yml)

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

npm test   # optional: end-to-end smoke test, plus the Storage backend against local fakes
           # (no Gemini or Supabase credentials needed — everything runs on 127.0.0.1)
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
- **Every upload is treated as hostile.** The scan route accepts documents, so
  `extract.js` sniffs bytes instead of trusting extensions: executables (MZ/ELF/
  Mach-O/shebang) are named and refused, images are capped at 40 megapixels from
  their headers before anything decodes them, zip members claiming more than 25 MB
  are skipped before inflation under a 48 MB total budget, absolute and `../`
  member paths are ignored, and SVGs are refused unless every reference is an
  internal `#fragment` (and they carry no scripts, no entities and no side over
  8000 px) — an upload can never make the server fetch a URL. Whatever comes out is re-encoded by `shrink()`, which discards the original
  bytes, appended payloads and EXIF: the stored file is always a fresh JPEG, served
  with `nosniff` and a `default-src 'none'; sandbox` CSP. A malformed container is
  a 415, never a 500.
- **Photos live in private storage**, referenced from each draft by a
  same-origin URL — no multi-megabyte base64 blobs in the database. With
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set they're uploaded to a
  private Supabase Storage bucket; otherwise they're files under
  `data/photos/` (configurable via `PHOTOS_DIR`). Uploads get one resize pass
  first (`photos.js` → `shrink()`): longest edge capped at 1400 px, re-encoded
  as JPEG q82, EXIF orientation auto-applied — and that single normalized
  image is both what Gemini sees and what's stored; the original is never
  kept. Uploads don't have to be photos: `extract.js` looks inside PDFs, the
  zip-based formats (docx, xlsx, pptx, odt, epub, plain zip), SVG and — for
  everything else — whatever `sharp` can decode, so a listing can start from a
  receipt or a document and a newly supported format works without a list to edit. Only the extracted image is stored and sent to Gemini —
  the container itself is processed in memory and discarded.
  iPhone HEIC photos are re-encoded to JPEG in the browser before upload,
  because this image pipeline (`sharp`'s prebuilt libvips) has no HEVC decoder; a
  HEIC that reaches the API anyway is refused with instructions, not a vague error.
  Every other photo is downscaled to 1400 px in the browser first too — the same
  ceiling the server applies — so a 12 MP camera shot uploads as a few hundred KB
  instead of several megabytes. The server still re-validates and re-encodes.
  They're served without auth over unguessable 128-bit random ids,
  since `<img>` tags can't send Bearer headers; swap in signed URLs if draft
  images ever become sensitive. Object ids survive either backend, so the
  same draft URLs keep working across the move to Supabase. Setting
  `DATABASE_URL` without Storage credentials refuses to boot in production
  (`PHOTOS_ALLOW_LOCAL=1` is the escape hatch), so photos can't silently land
  on an ephemeral container disk.

## Deploying (Render profile)

In production the app is a stateless container: Supabase Postgres holds accounts
and drafts, Supabase Storage holds photos, so nothing durable lives on the host
and a redeploy or restart is free. It is still a long-running Node process, so
it needs a container host — Render is the reference target here (starter plan,
no disk, ≈ $7/mo). `render.yaml` declares that shape; `Dockerfile` builds the
image (multi-stage, build tools only in the build layer). Locally and in the
tests, SQLite at `data/thriftly.db` and photos in `data/photos/` stand in for
the two Supabase services.

**Environment variables** (all read from `process.env`, listed in
`.env.example`; on Render they sit in the dashboard, never in the
image):

| Variable | Required | What it does |
|---|---|---|
| `ENCRYPTION_KEY` | yes | 64 hex characters (32 bytes); encrypts each user's Gemini key at rest. The server refuses to start without it, and rejects a passphrase of the same length |
| `BASE_URL` | after first deploy | Public origin used to build verification/reset email links |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | for real email | SMTP relay (e.g. `smtp-relay.brevo.com`, 587, `false` for STARTTLS). Absent → dev mode prints links and returns them in API responses — do not ship that way |
| `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | for real email | Relay credentials + verified sender address |
| `REQUIRE_EMAIL_VERIFICATION` | optional | Overrides a default that follows SMTP: unset, the gate is on when `SMTP_HOST` is set and off when it isn't (a link that can never be delivered would lock every new account out). `true` requires it regardless; `false` skips it regardless and weakens signup abuse protection |
| `GEMINI_MODEL` | optional | Model override (default `gemini-3.8-flash`). If Google retires it, `GEMINI_MODEL_FALLBACKS` are tried in order and the winner is reused |
| `GEMINI_API_BASE` | tests only | Points the client at a local fake. Ignored in production, where the server refuses to start if it is set — keys only go to Google |
| `DB_PATH` / `PHOTOS_DIR` | optional | Overrides for the on-disk locations |
| `TURNSTILE_SITE_KEY` | optional | Cloudflare Turnstile site key — renders the signup CAPTCHA widget |
| `TURNSTILE_SECRET` | optional | Turnstile secret. When set, signup is refused without a valid challenge (fails closed if Cloudflare is unreachable) |
| `DATABASE_URL` | for Postgres | Supabase **session-pooler** URI (port 5432). Set → Postgres data layer; unset → SQLite (local dev, tests) |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | with `DATABASE_URL` | Private `photos` bucket. The service-role key is server-only: it must never reach the browser |
| `SUPABASE_STORAGE_BUCKET` | optional | Bucket name; defaults to `photos` |
| `PHOTOS_ALLOW_LOCAL` | optional | `1` lets a Postgres app keep photos on a local disk, for hosts with a real persistent volume |
| `PORT` | optional | Listen port (Render injects it; defaults to 10000 in Docker, 3001 locally) |

> Turning on Turnstile means Cloudflare processes signup visitors' IP
> addresses — the privacy policy (version 2026-11-24) already discloses it in
> the third-party list; leaving the keys blank keeps the CAPTCHA off.

**Postgres + Supabase Storage:** set `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` and the app stops
touching the filesystem — the SQLite file and photo directory are ignored, the
in-process backup scheduler logs that it is skipped, and Supabase's own backups
plus an independent export are the backup story
([docs/backup-restore.md](docs/backup-restore.md)). [docs/SUPABASE.md](docs/SUPABASE.md)
is the runbook for standing that up, and for moving an existing SQLite instance
(data and photo copy scripts included). `/api/health`
stays a pure liveness check for Render; `/api/ready` pings the database **and**
asks Supabase for the bucket by name, so point an external uptime monitor at
that one — it returns 503 when either is down, and the server refuses to boot if
the bucket doesn't answer.

**Launch readiness:** [docs/LAUNCH.md](docs/LAUNCH.md) is the ordered
checklist for a real launch — repo/CI, SMTP, CAPTCHA, Render, backups,
monitoring and the first post-launch week. Terms of Service live at
`/terms.html` and are linked from signup alongside the Privacy Policy.

**Deploy checklist**

1. `git init` a GitHub repo and push this code to it (Render deploys
   from git or a container registry).
2. In Render: "New +" → Blueprint → pick the repo; the `render.yaml`
   pre-fills the service, the health check (`/api/health`) and the Supabase env
   slots. There is no disk to create.
3. Generate a fresh `ENCRYPTION_KEY` for this environment
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
   add `DATABASE_URL` (session pooler) and the three `SUPABASE_*` values from
   [docs/SUPABASE.md](docs/SUPABASE.md), and fill in the `SMTP_*` values in
   Render → Environment.
4. First deploy → note the `*.onrender.com` URL → set `BASE_URL` to it
   (or your custom domain) → redeploy so email links point at the
   right origin. The container is stateless, so a redeploy has nothing to move.
5. Smoke-test the live deploy: `/api/health` and `/api/ready`, a full signup →
   verify email → login flow, a photo scan, and a password reset with SMTP.
6. Add a custom domain in Render → Settings → Networking (HTTPS cert
   is managed). HTTP behind the proxy is fine — the HSTS header is the
   one to add on top.

**Backups:** nothing durable sits on the Render host, so there is no disk to
snapshot. Supabase keeps daily backups of the **database** on paid plans only —
7 days on Pro, 14 on Team, up to 30 on Enterprise, and **none at all on the free
plan** — and no plan's database backup includes the Storage objects that are your
photos. Where they exist they cover "a row was deleted" but not "the provider
account is gone".
The second layer is an independent export — `pg_dump` of `DATABASE_URL` plus a
copy of the `photos` bucket — kept off Supabase. Both commands, the restore
drill and the definition of done are in
[docs/backup-restore.md](docs/backup-restore.md). `npm run backup` /
`npm run restore` remain for the SQLite shape (local development and tests);
under Postgres the scheduler logs that it is skipped, and `render.yaml` sets no
`BACKUP_*` at all.

## What changed from the single-user version

- `analysis`/`listings` on a draft are unchanged in shape.
- Every draft now has a `user_id` and every query is scoped to it.
- The AI provider swapped from Anthropic (server-paid) to Gemini
  (user-paid) — same two-step pipeline, same JSON contract, different
  vendor underneath.
- `ebay-auto-post` is still its own separate project, still on hold.
