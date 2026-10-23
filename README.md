# Thriftly Backend — multi-user, bring-your-own-key, Gemini-powered

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
| POST | `/api/auth/signup` | `{email, password}` → creates the account, returns `{token, user}` |
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
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
  Completing a reset also marks the account's email verified: setting the
  password required reading that mailbox, which is what verification proves.
- **Sessions are simple bearer tokens** stored in SQLite, 30-day expiry, no
  refresh flow. Logging out deletes the row; that's the whole revocation
  story. An hourly cleanup pass purges expired sessions and verification
  tokens from the database.
- **Must run behind HTTPS** in anything beyond local testing — tokens,
  passwords, and API keys all travel in plain headers otherwise.
- **Photos are stored as files on disk** (under `data/photos/`, configurable
  via `PHOTOS_DIR`), referenced from each draft by a same-origin URL — no more
  multi-megabyte base64 blobs in the database. Uploads get one resize pass
  first (`photos.js` → `shrink()`): longest edge capped at 1400 px, re-encoded
  as JPEG q82, EXIF orientation auto-applied — and that single normalized
  image is both what Gemini sees and what's stored; the original never hits
  disk. They're served without auth over unguessable 128-bit random ids,
  since `<img>` tags can't send Bearer headers; swap in signed URLs if draft
  images ever become sensitive. The storage seam is isolated in `photos.js`,
  so an S3/R2 backend can replace the filesystem without touching anything
  else.

## What changed from the single-user version

- `analysis`/`listings` on a draft are unchanged in shape.
- Every draft now has a `user_id` and every query is scoped to it.
- The AI provider swapped from Anthropic (server-paid) to Gemini
  (user-paid) — same two-step pipeline, same JSON contract, different
  vendor underneath.
- `ebay-auto-post` is still its own separate project, still on hold.
