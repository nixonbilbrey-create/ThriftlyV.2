# Launch itinerary

Ordered, from "code is ready" to "real people are using it". Anything marked
**you** needs an account, a domain, or a decision this repo can't make. The
repo-side items are already done; the rest is a checklist you can work top to
bottom in one sitting plus an hour of verification.

Rough timeline: **P0 is a half day**, most of it waiting on Render and DNS.

## P0 — before the first real user

| # | Item | Owner | Done when |
|---|---|---|---|
| 1 | Push the repo to GitHub | you | `main` is on GitHub; first Actions run is green (CI badge included) |
| 2 | **Supabase:** resume the project if it says paused | you | Dashboard shows it running — a paused project fails every connection |
| 3 | **Supabase:** confirm the schema and the bucket | you | Table editor lists `users`, `sessions`, `email_verifications`, `password_resets`, `drafts`; Storage lists `photos` marked **Private** |
| 4 | **Supabase:** copy the session-pooler URI, project URL and `service_role` key; generate a fresh `ENCRYPTION_KEY` | you | Four values in hand, typed into Render only — never into chat |
| 5 | **Render:** New + → Blueprint → pick the repo → fill the prompted variables | you | Service created; no disk under Settings; first deploy green |
| 6 | Set `BASE_URL` to the service origin and let it redeploy | you | Verification and reset links point at the real host |
| 7 | SMTP relay configured and the sender domain authenticated (SPF + DKIM) | you | A real signup receives the email; Gmail and Outlook land in the inbox |
| 8 | Turnstile site + secret keys set | you | Signup on the live origin shows the challenge and rejects a missing token |
| 9 | **Prove the backend:** `/api/ready` on the live origin | you | `{"ok":true,"db":"pg","storage":"ok"}` — `db:"sqlite"` means `DATABASE_URL` never arrived |
| 10 | **Prove writes:** signup row, then a scanned photo | you | Row in Supabase `users`; object in the `photos` bucket; `/api/photos/<id>` serves it; deleting the draft removes it |
| 11 | Confirm the Supabase plan's backup/PITR window | you | Dashboard shows daily backups (and PITR if the plan includes it) |
| 12 | Independent export off Supabase (`pg_dump` + a bucket copy to R2/S3/B2) | you | One dump and one photo archive exist outside Supabase |
| 13 | Restore drill into a scratch project | you | Restored app boots, login works, drafts and a photo load |
| 14 | External uptime monitor on `/api/ready` (and `/api/health` for liveness) | you | An alert within minutes of a database **or Storage** outage |
| 15 | Custom domain + HTTPS | you | `https://yourdomain` serves the app; HTTP redirects; cert valid |
| 16 | Smoke-test production like a stranger | you | Sign up → verify → login → Gemini key → scan → drafts → export → delete all pass |
| 17 | Legal review of `/terms.html` and `/privacy.html`; real support inbox | you | A human (ideally a lawyer) read both; the address reaches someone who answers |

### What the repo already does for launch

- CI (`.github/workflows/ci.yml`): full smoke suite on every push, plus a
  Docker build that actually boots the image and polls `/api/health`.
- Hard email gate: no session token exists before the emailed link is clicked,
  so unverified accounts can't use the app.
- Privacy consent recorded per account, with re-consent when the policy version
  changes; `/api/config` reports the current version.
- Turnstile CAPTCHA (fail-closed when configured), login/signup/scan/resend
  rate limits, generic auth responses (no account enumeration), timing-equalized
  login.
- Strict CSP, `nosniff`, frame-deny, referrer policy, HSTS in production, and
  `no-store` on private API responses.
- Per-request API log lines (method, path, status, duration) that never include
  query strings (where reset/verify tokens live).
- `/api/health` reports only `ok`, version and uptime — no filesystem paths —
  and `/api/ready` adds a database ping **and a Storage check** (503 when either
  is unreachable), so liveness and readiness can be monitored separately. The
  Storage check asks Supabase for the bucket by name, so a renamed bucket or a
  revoked key fails readiness instead of the first user's scan — and a
  production process whose bucket doesn't answer refuses to boot at all.
- Backups: production data lives in Supabase (Postgres + private Storage
  bucket), so the story is Supabase's own backups plus an independent
  `pg_dump` + bucket export kept off-provider. There is no disk to snapshot and
  `render.yaml` carries no `BACKUP_*`. Runbook and drills:
  [backup-restore.md](backup-restore.md).
- Account export (JSON incl. photos) and irreversible account deletion.
- `/terms.html` alongside `/privacy.html`, both linked from signup and the
  footer.

## P1 — first two weeks after launch

- Watch the API log and Render metrics daily: 5xx rate, latency, plus
  Supabase's database and storage metrics.
- Run one independent export by hand (`pg_dump` + bucket copy), confirm it
  lands off Supabase, and check `pg_restore --list` shows all five tables.
- Re-run the restore drill once with production data (into a scratch service).
- Check email deliverability: send a reset to Gmail, Outlook, and one corporate
  address; confirm SPF/DKIM pass in the headers.
- Add a second pair of eyes on abuse: review signups, drafts, and 429 rates.
- Decide the data-retention story in writing (Supabase backups and your exports
  keep account data after deletion for their retention window; say so in the
  privacy policy if that window outlives what the page implies).
- Pin the Node version in CI/Docker if you want reproducibility beyond
  `node:22-slim` moving under you; bump dependencies deliberately, not on
  deploy day.
- Add error visibility beyond logs if the log volume grows (a hosted error
  tracker or a Render log drain); keep it out of the browser so the no-tracker
  promise stays true.

## P2 — product follow-ups (not launch blockers)

- Real marketplace posting is a separate project; today's output is drafts.
- Search/filter across drafts once users have more than a handful.
- Onboarding copy and a sample scan for the empty state.
- Accessibility pass on the two pages with real interaction (signup and the
  scan flow).

## Launch-day sequence (about 90 minutes)

**Supabase first** — the blueprint prompts for these values exactly once, at
creation, and adding a variable to `render.yaml` later does not re-prompt.

1. Resume the project if the dashboard says paused.
2. Confirm the five tables. If the editor is empty, SQL editor → paste
   [db/schema.sql](../db/schema.sql) → Run (it is `create table if not exists`).
3. Confirm a **private** bucket named `photos` (Storage → New bucket).
4. Copy the **session-pooler** URI (port 5432, not transaction mode 6543 and not
   the IPv6-only `db.<ref>` host), the project URL, and the `service_role` key.
   Generate the encryption key fresh:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   That key is permanent — rotating it makes existing stored Gemini keys
   unreadable.

**Render:**

5. **New +** → **Blueprint** → connect GitHub → pick the repo, branch `main`. It
   reads `render.yaml` and shows one Docker service, starter plan, health check
   `/api/health`, **no disk**. The starter plan needs a card on the account.
6. Fill the prompted variables in this order: `ENCRYPTION_KEY`, `DATABASE_URL`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, then the `SMTP_*` set (skip it
   and nobody can verify a mailbox), then Turnstile if you have keys. Leave
   `BASE_URL` blank — you don't know the hostname yet.
   `SUPABASE_STORAGE_BUCKET` is already `photos` in the file, no prompt.
7. Create the Blueprint and watch the first deploy's logs. You want
   `Supabase Storage bucket "photos" reachable` and then `Thriftly backend …`.
   `Storage is configured but unusable` means the bucket name or key is wrong,
   and the deploy failed on purpose rather than serving an app that can't store
   photos.
8. Set `BASE_URL` to `https://<service>.onrender.com`, save, let it redeploy.

**Prove it, in this order:**

9. `curl -s https://<host>/api/ready` → `{"ok":true,"db":"pg","storage":"ok"}`.
   Any `"db":"sqlite"` means `DATABASE_URL` didn't reach the process.
10. Sign up, then look in Supabase → Table editor → `users` for that row. That is
    the difference between "the ping answered" and "this app writes here".
11. Connect a Gemini key, scan a photo, then Supabase → Storage → `photos`:
    one object named like `a1b2…32hex.jpg` (the name is the draft's photo id).
12. `curl -I https://<host>/api/photos/<that id>` → 200 `image/jpeg`. Delete the
    draft and watch the object leave the bucket.

Then: Turnstile on, domain attached, monitor pointed at `/api/ready`, and one
independent export taken (item 12).

If an upload fails, the log names the cause: `Supabase Storage upload failed
(400)` is the bucket name or its existence, `(401)`/`(403)` is not the
service-role key.

## If something goes wrong

- **Bad deploy:** Render → Deploys → roll back to the previous deploy. Data is
  in Supabase, so a rollback changes nothing about it.
- **Data loss/corruption:** follow
  [backup-restore.md](backup-restore.md#restore-drill-do-this-before-you-need-it),
  preferably restoring into a new service before switching the domain.
- **Email broken:** users can still request a resend; if SMTP is down, fix the
  provider first — no verification means no new logins.
- **Photos fail but logins work:** `/api/ready` returns 503 with
  `storage:"unreachable"` and the log names the bucket check. Fix the bucket
  name or key in Render → Environment; the database is fine.
- **Abuse spike:** tighten the rate limits in `server.js` (single process, so
  the in-memory limiter is authoritative), enable Turnstile if it was off, and
  block at the proxy if needed.

## Definition of launched

- A stranger can sign up, verify, connect a key, scan, and delete their account
  without help.
- Email arrives reliably; the CAPTCHA is on.
- Backups exist in two places, and you have restored one.
- An outage would page you, not be discovered by a user.
