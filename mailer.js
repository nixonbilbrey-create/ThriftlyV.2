const nodemailer = require('nodemailer');

// ---------- email delivery ----------
// Contract used by server.js:
// - sendVerificationEmail(email, verifyUrl) -> { sent: boolean, devLink?: string }
// - sendPasswordResetEmail(email, resetUrl) -> { sent: boolean, devLink?: string }
//   sent: true  => the email actually went out; no devLink is returned to the API caller.
//   sent: false => SMTP isn't configured (or the send failed), so the link is
//                  logged to the server console AND returned as devLink, where the
//                  signup/reset responses and the test harness UI surface it as a
//                  clickable link.
//
// Config comes entirely from env (see .env.example): SMTP_HOST / SMTP_PORT / SMTP_SECURE /
// SMTP_USER / SMTP_PASS / SMTP_FROM. Leaving SMTP_HOST blank runs the app in dev mode.

function smtpConfigured() {
  return !!process.env.SMTP_HOST;
}

function buildTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  // SMTP_SECURE=false with port 587 is the common STARTTLS setup; 465 wants implicit TLS.
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

// Shared sending core. Returns { sent, devLinkAllowed, transportError }:
// - devLinkAllowed: true only when SMTP isn't configured at all (dev mode) —
//   the caller may surface the link in the API response then, and ONLY then.
// - When SMTP is configured but the send fails, the link is logged server-side
//   and NOT returned to the API caller. Returning live verify/reset tokens to
//   whoever called the API would be an account-takeover hole (imagine an
//   attacker triggering a password reset exactly while your SMTP is failing).
async function sendAppEmail({ email, subject, text, html }) {
  if (!smtpConfigured()) {
    console.log(`[mailer] SMTP not configured — ${subject} for ${email}:`);
    return { sent: false, devLinkAllowed: true, transportError: null };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await buildTransport().sendMail({
      from: from ? `Thriftly <${from}>` : undefined,
      to: email,
      subject,
      text,
      html,
    });
    return { sent: true, devLinkAllowed: false, transportError: null };
  } catch (err) {
    console.error(`[mailer] Failed to send "${subject}" to ${email}:`, err.message);
    console.log(`[mailer] ${subject} link for ${email} (logged here, NOT returned to the API caller):`);
    return { sent: false, devLinkAllowed: false, transportError: err.message };
  }
}

// ---------- verification email ----------
function verificationEmailHtml(verifyUrl) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f2ed;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:440px;margin:40px auto;background:#ffffff;border-radius:10px;padding:32px;">
    <h1 style="font-size:18px;color:#1c1a17;margin:0 0 12px;">Verify your Thriftly email</h1>
    <p style="font-size:14px;color:#4a4438;line-height:1.5;margin:0 0 20px;">
      Click the button below to verify your email address. The link expires in 24 hours.
    </p>
    <a href="${verifyUrl}"
       style="display:inline-block;background:#1c1a17;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600;">
      Verify email
    </a>
    <p style="font-size:12px;color:#7a7268;line-height:1.5;margin:24px 0 0;">
      If you didn't create a Thriftly account, you can ignore this email.
    </p>
  </div>
</body></html>`;
}

async function sendVerificationEmail(email, verifyUrl) {
  const result = await sendAppEmail({
    email,
    subject: 'Verify your Thriftly email',
    text: `Welcome to Thriftly!\n\nVerify your email address by opening this link (valid for 24 hours):\n${verifyUrl}\n\nIf you didn't create a Thriftly account, you can ignore this email.`,
    html: verificationEmailHtml(verifyUrl),
  });
  if (!result.sent) {
    console.log(`  ${verifyUrl}`);
    // devLink only in dev mode (no SMTP configured) — see sendAppEmail.
    if (result.devLinkAllowed) return { sent: false, devLink: verifyUrl };
    return { sent: false };
  }
  return { sent: true };
}

// ---------- password reset email ----------
function passwordResetEmailHtml(resetUrl) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f2ed;font-family:system-ui,-apple-system,sans-serif;">
  <div style="max-width:440px;margin:40px auto;background:#ffffff;border-radius:10px;padding:32px;">
    <h1 style="font-size:18px;color:#1c1a17;margin:0 0 12px;">Reset your Thriftly password</h1>
    <p style="font-size:14px;color:#4a4438;line-height:1.5;margin:0 0 20px;">
      Click the button below to set a new password. The link expires in 1 hour and can only be used once.
    </p>
    <a href="${resetUrl}"
       style="display:inline-block;background:#1c1a17;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600;">
      Choose a new password
    </a>
    <p style="font-size:12px;color:#7a7268;line-height:1.5;margin:24px 0 0;">
      If you didn't request a password reset, you can ignore this email — your password stays as it was.
    </p>
  </div>
</body></html>`;
}

async function sendPasswordResetEmail(email, resetUrl) {
  const result = await sendAppEmail({
    email,
    subject: 'Reset your Thriftly password',
    text: `Someone (hopefully you) asked to reset the Thriftly password for this address.\n\nSet a new password by opening this link — it's valid for 1 hour and can only be used once:\n${resetUrl}\n\nIf you didn't request this, you can ignore this email; your current password stays as it was.`,
    html: passwordResetEmailHtml(resetUrl),
  });
  if (!result.sent) {
    console.log(`  ${resetUrl}`);
    if (result.devLinkAllowed) return { sent: false, devLink: resetUrl };
    return { sent: false };
  }
  return { sent: true };
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, smtpConfigured };
