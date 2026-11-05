
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

// Resend requires the sender to be on a domain verified in the account.
// onboarding@resend.dev always works but only delivers to the address that owns
// the Resend account, so it is a fallback rather than a default.
const FROM = () => process.env.EMAIL_FROM || "Lumina <noreply@llumina.online>";
const SANDBOX_FROM = "Lumina <onboarding@resend.dev>";

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
async function postToResend(from, { to, subject, html, label, headers }) {
  const res = await withDeadline(
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html, ...(headers ? { headers } : {}) }),
    }),
    SEND_DEADLINE_MS,
    `${label} send`
  );
  const detail = res.ok ? null : await res.text().catch(() => "");
  return { res, detail };
}

async function deliver({ to, subject, html, label, headers }) {
  if (useResend()) {
    let { res, detail } = await postToResend(FROM(), { to, subject, html, label, headers });

    // Domain verification is a wait we do not control: the DNS records are in
    // place and Resend is still checking them, which can take hours. Rather than
    // leave sending broken until then — or need a config change at the exact
    // moment it completes — fall back to the sandbox sender, which reaches the
    // Resend account owner. Once the domain clears, the first attempt succeeds
    // and this branch stops being taken, with no redeploy.
    if (res.status === 403 && /not verified/i.test(detail || "") && FROM() !== SANDBOX_FROM) {
      logger.warn(
        "⚠️ %s: %s is not verified in Resend yet, falling back to %s (reaches only the Resend account owner).",
        label,
        FROM(),
        SANDBOX_FROM
      );
      ({ res, detail } = await postToResend(SANDBOX_FROM, { to, subject, html, label, headers }));
    }

    // A non-2xx carries Resend's own explanation (unverified domain, sandbox
    // recipient restriction, bad key). Surface it: the caller renders an error
    // and this is the only place the real reason is visible.
    if (!res.ok) {
      throw new Error(
        `Resend rejected the ${label.toLowerCase()} (HTTP ${res.status}): ${(detail || "").slice(0, 300)}`
      );
    }

    const body = await res.json().catch(() => ({}));
    logger.info("📨 %s sent via Resend: %s", label, body.id || "(no id)");
    return;
  }

  const transporter = await createTransporter();
  const info = await withDeadline(
    transporter.sendMail({ from: FROM(), to, subject, html, ...(headers ? { headers } : {}) }),
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

// Sent to a follower when someone they follow publishes.
//
// This is the first mail here that is not transactional: a reader did not
// trigger it by doing something, which is exactly the category inbox providers
// are strict about. Hence the two headers below.
//
// List-Unsubscribe gives the mail client its own native "Unsubscribe" button,
// and List-Unsubscribe-Post declares RFC 8058 one-click, which Gmail and Yahoo
// require from bulk senders. Without them this mail is markedly more likely to
// be filed as spam — and a reader who cannot find an unsubscribe button presses
// "report spam" instead, which damages the sending domain for every message,
// password resets included.
const sendNewPostEmail = async (
  email,
  { authorName, title, excerpt, url, coverImageURL, unsubscribeUrl }
) => {
  const safe = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000";
  const safeTitle = safe(title);
  const safeAuthor = safe(authorName);

  await deliver({
    to: email,
    subject: `${authorName} published: ${title}`,
    label: "New post email",
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .kicker { color: #888888; font-size: 14px; margin: 0 0 8px; }
            .title { color: #1a1a1a; font-size: 24px; line-height: 1.3; margin: 0 0 14px; }
            .excerpt { color: #444444; line-height: 1.6; font-size: 16px; margin: 0 0 24px; }
            .cover { width: 100%; max-width: 520px; border-radius: 8px; display: block; margin: 0 0 24px; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #000000; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .footer a { color: #888888; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="${baseUrl}" class="logo">Lumina</a>
            </div>
            <p class="kicker">${safeAuthor} just published</p>
            <h2 class="title">${safeTitle}</h2>
            ${coverImageURL ? `<img src="${safe(coverImageURL)}" alt="" class="cover">` : ""}
            ${excerpt ? `<p class="excerpt">${safe(excerpt)}</p>` : ""}
            <div class="button-container">
              <a href="${safe(url)}" class="button">Read it</a>
            </div>
            <div class="footer">
              <p>You are getting this because you follow ${safeAuthor} on Lumina.<br>
              <a href="${safe(unsubscribeUrl)}">Unsubscribe from new post emails</a></p>
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });
};

// Shared shell for the engagement mail below (a comment, a reply, a new
// follower). These differ only in a line of text, a quote and a button, so they
// share one template rather than three near-identical copies that drift.
//
// Like the new-post mail, every one of them is something a reader did not ask
// for individually, so every one carries the RFC 8058 one-click headers and a
// visible unsubscribe link. A reader who cannot find the unsubscribe presses
// "report spam" instead, and that hurts the password-reset mail too.
const escapeHtml = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

async function sendEngagementEmail(
  email,
  { subject, label, heading, quote, buttonText, url, reason, unsubscribeUrl, unsubscribeText }
) {
  const safe = escapeHtml;
  const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000";

  await deliver({
    to: email,
    subject,
    label,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .heading { color: #1a1a1a; font-size: 20px; line-height: 1.4; margin: 0 0 20px; }
            .quote { border-left: 3px solid #e0e0e0; margin: 0 0 24px; padding: 4px 0 4px 16px; color: #444444; font-size: 16px; line-height: 1.6; white-space: pre-wrap; }
            .button-container { text-align: center; margin: 30px 0; }
            .button { background-color: #000000; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .footer a { color: #888888; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="${baseUrl}" class="logo">Lumina</a>
            </div>
            <h2 class="heading">${safe(heading)}</h2>
            ${quote ? `<p class="quote">${safe(quote)}</p>` : ""}
            <div class="button-container">
              <a href="${safe(url)}" class="button">${safe(buttonText)}</a>
            </div>
            <div class="footer">
              <p>${safe(reason)}<br>
              <a href="${safe(unsubscribeUrl)}">${safe(unsubscribeText)}</a></p>
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });
}

// A comment on your post, or a reply to your comment. One function because the
// two differ only in wording, and a reader thinks of both as "someone replied".
const sendCommentEmail = async (
  email,
  { kind, senderName, postTitle, comment, url, unsubscribeUrl }
) => {
  const isReply = kind === "reply";
  // The comment is quoted in the body; a long one would make the subject line
  // useless in a crowded inbox, so the subject carries only who and where.
  return sendEngagementEmail(email, {
    subject: isReply
      ? `${senderName} replied to your comment`
      : `${senderName} commented on "${postTitle}"`,
    label: isReply ? "Reply email" : "Comment email",
    heading: isReply
      ? `${senderName} replied to your comment on "${postTitle}"`
      : `${senderName} commented on your post "${postTitle}"`,
    quote: comment,
    buttonText: isReply ? "Read the reply" : "Read the comment",
    url,
    reason: "You are getting this because it is a response to something you wrote on Lumina.",
    unsubscribeUrl,
    unsubscribeText: "Unsubscribe from comment emails",
  });
};

const sendFollowEmail = async (email, { followerName, followerBio, url, unsubscribeUrl }) =>
  sendEngagementEmail(email, {
    subject: `${followerName} started following you`,
    label: "New follower email",
    heading: `${followerName} started following you on Lumina`,
    quote: followerBio,
    buttonText: "See their profile",
    url,
    reason: "You are getting this because someone followed you on Lumina.",
    unsubscribeUrl,
    unsubscribeText: "Unsubscribe from new follower emails",
  });

// 📊 The weekly digest: what happened to an author's posts since the last one.
//
// The point of it is that 2,500 reads had happened on this site and not one
// author had ever been told. Writers keep writing when they can see that
// someone is reading; a number nobody shows them motivates nobody.
//
// Only sent when there is something to report — see services/digest.js. An
// email that says "0 views this week" is worse than no email.
const sendWeeklyDigestEmail = async (
  email,
  { authorName, since, views, comments, followers, posts, url, unsubscribeUrl }
) => {
  const safe = escapeHtml;
  const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000";

  const stat = (n, oneLabel, manyLabel) => `
    <td class="stat">
      <span class="stat-n">${n}</span>
      <span class="stat-l">${n === 1 ? oneLabel : manyLabel}</span>
    </td>`;

  const rows = (posts || [])
    .map(
      (p) => `
        <tr>
          <td class="row-title"><a href="${safe(p.url)}">${safe(p.title)}</a></td>
          <td class="row-n">${p.views}</td>
        </tr>`
    )
    .join("");

  await deliver({
    to: email,
    subject: `Your week on Lumina: ${views} read${views === 1 ? "" : "s"}`,
    label: "Weekly digest",
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
            .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 30px; }
            .logo { font-size: 24px; font-weight: bold; color: #1a1a1a; text-decoration: none; }
            .heading { color: #1a1a1a; font-size: 20px; line-height: 1.4; margin: 0 0 6px; }
            .sub { color: #888888; font-size: 14px; margin: 0 0 26px; }
            .stats { width: 100%; border-collapse: collapse; margin: 0 0 28px; }
            .stat { text-align: center; padding: 16px 8px; background: #fafafa; border-radius: 8px; }
            .stat-n { display: block; font-size: 28px; font-weight: bold; color: #1a1a1a; line-height: 1.1; }
            .stat-l { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888888; margin-top: 4px; }
            .posts { width: 100%; border-collapse: collapse; margin: 0 0 10px; }
            .posts th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #888888; padding: 0 0 8px; border-bottom: 1px solid #eeeeee; }
            .row-title { padding: 10px 8px 10px 0; font-size: 15px; }
            .row-title a { color: #1a1a1a; text-decoration: none; font-weight: 600; }
            .row-n { padding: 10px 0; text-align: right; color: #666666; font-size: 15px; white-space: nowrap; }
            .button-container { text-align: center; margin: 30px 0 0; }
            .button { background-color: #000000; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block; }
            .footer { margin-top: 30px; text-align: center; color: #888888; font-size: 12px; border-top: 1px solid #eeeeee; padding-top: 20px; }
            .footer a { color: #888888; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <a href="${baseUrl}" class="logo">Lumina</a>
            </div>
            <h2 class="heading">People are reading you, ${safe(authorName)}</h2>
            <p class="sub">Since ${safe(since)}</p>

            <table class="stats" role="presentation">
              <tr>
                ${stat(views, "read", "reads")}
                <td style="width:12px"></td>
                ${stat(comments, "comment", "comments")}
                <td style="width:12px"></td>
                ${stat(followers, "new follower", "new followers")}
              </tr>
            </table>

            ${rows ? `<table class="posts" role="presentation">
              <tr><th>Your posts</th><th style="text-align:right">Reads</th></tr>
              ${rows}
            </table>` : ""}

            <div class="button-container">
              <a href="${safe(url)}" class="button">See your stats</a>
            </div>

            <div class="footer">
              <p>You are getting this because you write on Lumina.<br>
              <a href="${safe(unsubscribeUrl)}">Unsubscribe from the weekly digest</a></p>
              <p>&copy; ${new Date().getFullYear()} Lumina. All rights reserved.</p>
            </div>
          </div>
        </body>
        </html>
    `,
  });
};

module.exports = {
  sendVerificationEmail,
  sendWeeklyDigestEmail,
  sendResetPasswordEmail,
  sendNewPostEmail,
  sendCommentEmail,
  sendFollowEmail,
  createTransporter,
};
