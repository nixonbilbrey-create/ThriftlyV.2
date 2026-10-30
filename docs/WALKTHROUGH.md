# Thriftly walkthrough — with a demo account

A guided tour of everything the app does, using a pre-seeded account so you can
click through it without a Gemini key. The demo data is fabricated (see
[How the demo was made](#how-the-demo-was-made)); a real scan calls *your* Gemini
key and fills the same shapes.

## The demo account

| | |
|---|---|
| Email | `demo@thriftly.local` |
| Password | `demo-pass-1234` |
| State | email verified, privacy policy `2026-10-30` accepted |
| Drafts | 2 — one with listings on all four platforms, one not yet drafted |

- **Reset it** any time with `npm run seed:demo` (replaces the account and its drafts).
- **Remove it** by logging in → *Delete account…* (or re-run the seed to replace it).
- New scans still need a Gemini key: the demo only pre-fills the *results* of a
  scan, it doesn't fake the API.

## Tour

### 1. Log in

Open the running app (`localhost:3000` locally, or the preview panel).

You get the iOS-flavoured auth card with a segmented **Log in / Sign up** control,
email + password fields, and — in signup mode — a required privacy-policy
checkbox (a CAPTCHA widget appears too if Turnstile keys are configured).

Sign in with the demo credentials. The app validates the session via
`/api/auth/me` and loads the drafts sidebar.

### 2. What happens on a real signup (not needed for the demo)

1. Submit email, password (min 8 chars), tick the policy box.
2. The account is created **unverified**. You cannot log in yet: `POST /api/auth/login`
   returns `403` with `needsVerification: true`.
3. A verification email goes out. Without SMTP configured, the link is printed to
   the server console and returned in the API response (`devVerifyLink`) — the UI
   shows it in a "No email service configured" box.
4. Clicking the link marks the email verified; only then does login issue a token.
   The *Resend verification email* link is rate-limited to one per minute per
   address (the UI counts the cooldown down).

### 3. The app shell

After login you get three regions:

- **Gemini API key card** — status line and the *Connect key* form. The key is
  validated live against Google (a cheap models-list call), encrypted with
  AES-256-GCM, and never leaves the server.
- **Main column** — photo picker → *Scan photo* → analysis card → *Generate
  listings* → editable listing cards for Vinted, Depop, Poshmark and eBay.
- **Sidebar** — *Your drafts* (thumbnail, item type, listing progress), *Clear
  all*, *Download my data* and *Delete account…*.

### 4. Tour the seeded drafts

Click the **camel overcoat** in the sidebar:

- The analysis card shows item, brand, condition, estimated value range and
  confidence — exactly the fields a live scan returns.
- Below it, four listing cards are pre-filled with platform-specific copy and
  prices. Vinted's card is marked *Posted ✓*; the others are editable, and each
  has a Save button and a *posted* checkbox that persist via
  `PUT /api/drafts/:id`.

Click the **sneakers**: analysis is there but no listings — this is the state
right after a scan, before *Generate listings*. (That button would call Gemini
with your key; the demo account has none, so it returns the "Connect your Gemini
API key" error — that's expected.)

Toggle a listing to *posted*, edit a title, hit Save, then reload the page: the
sidebar status updates ("1 of 4 posted" → "2 of 4 posted").

### 5. Export your data

*Download my data* in the sidebar downloads `thriftly-export-<date>.json`:

- `account` — profile (no password hash or key material)
- `drafts` — every draft with analysis and listings
- `photos` — each photo's bytes as base64, keyed by filename

The file is self-contained: it still makes sense after the account is deleted.
Export is what the policy's deletion promise is paired with.

### 6. Delete the account

*Delete account…* asks for confirmation, then `DELETE /api/account` removes
drafts, photo files, sessions, verification/reset tokens and the user row in one
go. The button confirms and returns you to the login screen. Re-run
`npm run seed:demo` to get the demo back.

### 7. The policy

The footer links to `/privacy.html` — versioned (`2026-10-30`), plain language,
listing what's stored, what isn't, the three third parties (Google Gemini via
*your* key, the SMTP provider, Cloudflare Turnstile when enabled, plus hosting),
retention, rights (delete / export / disconnect key), and security. Each signup
records the version it accepted; `/api/auth/me` reports it back.

## How the demo was made

`scripts/seed-demo.mjs` writes directly to the same SQLite database the server
uses:

1. Deletes any existing `demo@thriftly.local` (and its photo files).
2. Creates the account with a bcrypt hash and marks it verified — no email round
   trip, because the point is to tour the UI.
3. Generates two placeholder product illustrations with `sharp` (SVG → JPEG,
   same resize/storage path as real photos), saves them via `photos.js`, and
   creates two drafts with hand-written analysis/listings data.

No Gemini request is made and no real user data is touched. The fabricated
values mirror the JSON contract in `gemini.js` — `item_type`, `brand`,
`condition`, `estimated_price_low/high`, `confidence`, and per-platform
`{title, description, price}` objects.

## Quick reference

| Action | Where |
|---|---|
| Log in / sign up | `/` (auth card) |
| Privacy policy | `/privacy.html` |
| Password reset | *Forgot password?* on the auth card |
| Set new password | `/set-password.html?token=…` |
| Account export | sidebar → *Download my data* → `GET /api/account/export` |
| Account deletion | sidebar → *Delete account…* → `DELETE /api/account` |
| Demo reset | `npm run seed:demo` |
| Backups / restore drill | `docs/backup-restore.md` |
| Tests | `npm test` (9 flows, no keys needed) |
| CI | `.github/workflows/ci.yml` (tests + image build) |
