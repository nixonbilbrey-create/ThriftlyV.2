const nodemailer = require('nodemailer');

// ---------- verification email ----------
// server.js expects: sendVerificationEmail(email, verifyUrl) -> { sent: boolean, devLink?: string }
// - sent: true  => the email actually went out; no devVerifyLink is returned to the API caller.
// - sent: false => SMTP isn't configured (or the send failed), so the verification link is
//                  logged to the server console AND returned as devLink, where the signup
//                  response and the test harness UI surface it as a clickable link.
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
  if (!smtpConfigured()) {
    console.log(`[mailer] SMTP not configured — verification link for ${email}:\n  ${verifyUrl}`);
    return { sent: false, devLink: verifyUrl };
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  try {
    await buildTransport().sendMail({
      from: from ? `Thriftly <${from}>` : undefined,
      to: email,
      subject: 'Verify your Thriftly email',
      text: `Welcome to Thriftly!\n\nVerify your email address by opening this link (valid for 24 hours):\n${verifyUrl}\n\nIf you didn't create a Thriftly account, you can ignore this email.`,
      html: verificationEmailHtml(verifyUrl),
    });
    return { sent: true };
  } catch (err) {
    // Send failed but SMTP is configured — same fallback as dev mode so the user
    // isn't stuck: link is logged and returned, never lost.
    console.error(`[mailer] Failed to send verification email to ${email}:`, err.message);
    console.log(`[mailer] Verification link for ${email}:\n  ${verifyUrl}`);
    return { sent: false, devLink: verifyUrl };
  }
}

module.exports = { sendVerificationEmail };
