# Launch itinerary

Ordered, from "code is ready" to "real people are using it". Anything marked
**you** needs an account, a domain, or a decision this repo can't make. The
repo-side items are already done; the rest is a checklist you can work top to
bottom in one sitting plus an hour of verification.

Rough timeline: **P0 is a half day**, most of it waiting on Render and DNS.

## P0 — before the first real user

| # | Item | Owner | Done when |
|---|---|---|---|
| 1 | Push the repo to GitHub | you | `main` is on GitHub; first Actions run is green |
| 2 | Replace the README badge `OWNER` placeholder | you | Badge renders "passing" |
| 3 | Create the Render service from `render.yaml` | you | Service is live with a 1 GB disk at `/app/data` |
| 4 | Generate a fresh `ENCRYPTION_KEY` for production | you | Render env var is set; server booted with it (never reuse the dev key) |
| 5 | Set `BASE_URL` to the public origin and redeploy | you | Verification/reset emails link to the real host |
| 6 | SMTP provider configured (Brevo relay recommended) | you | A real signup receives the verification email; reset arrives too |
| 7 | Sender domain authenticated (SPF + DKIM at the provider) | you | Mail lands in the inbox, not spam, for Gmail and Outlook |
| 8 | Turnstile site + secret keys set | you | Signup on the live origin shows the challenge and rejects a missing token |
| 9 | `BACKUP_INTERVAL_HOURS=24` and `BACKUP_DIR=/app/data/backups` | repo (done in `render.yaml`) | Archive appears in the disk after a day (or force one via Shell) |
| 10 | Off-provider backup copy (`BACKUP_UPLOAD_CMD` to R2/S3/B2) | you | One archive + checksum exist outside Render |
| 11 | Restore drill on a scratch copy | you | Restored app boots, login works, drafts and a photo load |
| 12 | External uptime monitor on `/api/health` | you | You get an email/phone alert within minutes of an outage |
| 13 | Custom domain + HTTPS | you | `https://yourdomain` serves the app; HTTP redirects; cert valid |
| 14 | Smoke-test production like a stranger | you | Sign up → verify → login → Gemini key → scan → drafts → export → delete all pass |
| 15 | Legal review of `/terms.html` and `/privacy.html` | you | A human (ideally a lawyer) has read both; contact address is real |
| 16 | Support inbox exists and is monitored | you | Address in the docs/pages reaches a human |

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
- `/api/health` reports only `ok`, version and uptime — no filesystem paths.
- Backups: checksummed online SQLite snapshot + photos (`npm run backup`),
  verified restore (`npm run restore`), and an in-process nightly scheduler
  (`BACKUP_INTERVAL_HOURS`) because Render has no cron that can read a service's
  disk. Runbook and drills: [backup-restore.md](backup-restore.md).
- Account export (JSON incl. photos) and irreversible account deletion.
- `/terms.html` alongside `/privacy.html`, both linked from signup and the
  footer.

## P1 — first two weeks after launch

- Watch the API log and Render metrics daily: 5xx rate, latency, disk usage.
- Make one backup download by hand and verify its checksum; confirm the
  off-provider copy is actually landing.
- Re-run the restore drill once with production data (into a scratch service).
- Check email deliverability: send a reset to Gmail, Outlook, and one corporate
  address; confirm SPF/DKIM pass in the headers.
- Add a second pair of eyes on abuse: review signups, drafts, and 429 rates.
- Decide the data-retention story in writing (backups keep account data after
  deletion for up to `BACKUP_RETENTION_DAYS`; say so in the privacy policy if
  you keep them longer).
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

1. Push, wait for CI green, fix anything red before touching Render.
2. Create the Render service; set `ENCRYPTION_KEY`; deploy.
3. Set `BASE_URL` to the `onrender.com` URL; redeploy; confirm `/api/health`.
4. Configure SMTP + sender authentication; run a real signup and reset.
5. Enable Turnstile; sign up in a private window; confirm the challenge runs.
6. Attach the domain; wait for the cert; repeat signup on the real domain.
7. Turn on the uptime monitor against `https://yourdomain/api/health`.
8. Force one backup via Render Shell (`npm run backup`), download it, check the
   checksum, and upload it off-provider.
9. Run the production smoke-test list (item 14) from a clean browser profile.
10. Invite the first handful of users; watch logs for the first hour.

## If something goes wrong

- **Bad deploy:** Render → Deploys → roll back to the previous deploy. The disk
  (data) is untouched by a rollback.
- **Data loss/corruption:** follow
  [backup-restore.md](backup-restore.md#restore-drill-do-this-before-you-need-it),
  preferably restoring into a new service before switching the domain.
- **Email broken:** users can still request a resend; if SMTP is down, fix the
  provider first — no verification means no new logins.
- **Abuse spike:** tighten the rate limits in `server.js` (single process, so
  the in-memory limiter is authoritative), enable Turnstile if it was off, and
  block at the proxy if needed.

## Definition of launched

- A stranger can sign up, verify, connect a key, scan, and delete their account
  without help.
- Email arrives reliably; the CAPTCHA is on.
- Backups exist in two places, and you have restored one.
- An outage would page you, not be discovered by a user.
