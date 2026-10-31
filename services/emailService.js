
const nodemailer = require("nodemailer");
const logger = require("./logger"); // Structured Logging

// Nodemailer's defaults are 2 min to connect, 30 s for the greeting and 10 min on
// the socket. Many hosts (Render's free tier among them) block outbound SMTP, so
// the connection never completes and the HTTP request that is awaiting it hangs
// until the platform's proxy cuts it off — the user just sees a spinner forever.
// Fail fast instead, so the caller's catch block actually runs.
const SMTP_TIMEOUTS = {
  connectionTimeout: 7000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
};

// Belt and braces: even with the options above, a wedged socket or a slow DNS
// lookup can outlive them. Nothing may block a request for longer than this.
const SEND_DEADLINE_MS = Number(process.env.EMAIL_TIMEOUT_MS) || 12000;

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Render blocks outbound SMTP, so a Gmail connection from a deployed instance
// just times out. Resend delivers over ordinary HTTPS, which is not blocked, so
// it is preferred whenever RESEND_API_KEY is present; SMTP stays as the fallback
// for local development and for hosts that do allow it.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const useResend = () => !!process.env.RESEND_API_KEY;

// Resend requires the sender to be on a domain verified in the account. Until
// llumina.online is verified, onboarding@resend.dev is the only usable sender,
// and it can only deliver to the address that owns the Resend account.
const FROM = () => process.env.EMAIL_FROM || "Lumina <onboarding@resend.dev>";

// Surface a missing mail configuration at boot rather than at the moment a
// visitor presses "Start your journey" — matches how the Google and Redis
// services announce themselves.
if (useResend()) {
  logger.info("✉️ Mail via Resend (HTTPS API), from %s", FROM());
} else if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  logger.warn(
    "⚠️ No RESEND_API_KEY and no EMAIL_USER / EMAIL_PASS — signup verification and password reset mail cannot be sent."
  );
} else {
  logger.warn(
    "⚠️ Mail via SMTP. On hosts that block outbound SMTP (Render among them) this will time out; set RESEND_API_KEY instead."
  );
}

// One delivery path for both messages below. Returns nothing useful on purpose:
// callers only care whether it threw.
async function deliver({ to, subject, html, label }) {
  if (useResend()) {
    const res = await withDeadline(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: FROM(), to: [to], subject, html }),
      }),
      SEND_DEADLINE_MS,
      `${label} send`
    );

    // A non-2xx carries Resend's own explanation (unverified domain, sandbox
    // recipient restriction, bad key). Surface it: the caller renders an error
    // and this is the only place the real reason is visible.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend rejected the ${label.toLowerCase()} (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    }

    const body = await res.json().catch(() => ({}));
    logger.info("📨 %s sent via Resend: %s", label, body.id || "(no id)");
    return;
  }

  const transporter = await createTransporter();
  const info = await withDeadline(
    transporter.sendMail({ from: FROM(), to, subject, html }),
    SEND_DEADLINE_MS,
    `${label} send`
  );
  logger.info("📨 %s sent via SMTP: %s", label, info.messageId);
  if (nodemailer.getTestMessageUrl(info)) {
    logger.info("🔎 Preview URL: %s", nodemailer.getTestMessageUrl(info));
  }
}

const createTransporter = async () => {
  // Check if we have real credentials
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    return nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      ...SMTP_TIMEOUTS,
    });
  }

  // Ethereal is a DEVELOPMENT convenience and must never be reached in
  // production: createTestAccount() is itself a network call, so with no
  // credentials configured a live server would hang here rather than report the
  // real problem — no mail credentials.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "EMAIL_USER / EMAIL_PASS are not set, so no verification or reset mail can be sent."
    );
  }

  // Fallback to Ethereal (Dev Mode)
  logger.warn("⚠️ No real email credentials found. Using Ethereal (Fake Email) for testing.");
  const testAccount = await withDeadline(
    nodemailer.createTestAccount(),
    SEND_DEADLINE_MS,
    "Ethereal test account creation"
  );

  return nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
    ...SMTP_TIMEOUTS,
  });
};

const sendVerificationEmail = async (email, token) => {
  const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000";
  const verificationLink = `${baseUrl}/user/verify/${token}`;

  await deliver({
    to: email,
    subject: "Verify your email address",
    label: "Verification email",
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .content { color: #444444; line-height: 1.6; font-size: 16px; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #000000; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .link-text { color: #666666; font-size: 14px; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="${baseUrl}" class="logo">Lumina</a>
            </div>
            <div class="content">
              <h2>Welcome to Lumina!</h2>
              <p>We're excited to have you join our community. To complete your registration and unlock full access to your account, please verify your email address.</p>
              
              <div class="button-container">
                <a href="${verificationLink}" class="button">Verify My Email</a>
              </div>
              
              <p>Or verify using this link:</p>
              <p class="link-text">${verificationLink}</p>
              
              <p>If you didn't create an account with Lumina, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });
};

const sendResetPasswordEmail = async (email, resetLink) => {
  await deliver({
    to: email,
    subject: "Reset Your Password",
    label: "Password reset email",
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .content { color: #444444; line-height: 1.6; font-size: 16px; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #d90429; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .link-text { color: #666666; font-size: 14px; word-break: break-all; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="#" class="logo">Lumina</a>
            </div>
            <div class="content">
              <h2>Password Reset Request</h2>
              <p>We received a request to reset your password. If this was you, you can change your password using the button below. This link works for 1 hour.</p>
              
              <div class="button-container">
                <a href="${resetLink}" class="button">Reset Password</a>
              </div>
              
              <p>Or copy this link:</p>
              <p class="link-text">${resetLink}</p>
              
              <p><strong>Did not request this?</strong><br>
              Please ignore this email. Your password will remain unchanged and your account is secure.</p>
            </div>
            <div class="footer">
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });
};

module.exports = { sendVerificationEmail, sendResetPasswordEmail, createTransporter };
