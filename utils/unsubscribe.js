// One-click unsubscribe links for the mail we send to followers.
//
// The token is derived, not stored: an HMAC over the user id and the kind of
// mail, keyed with the server secret. That means no new column, no backfill for
// the accounts that already exist, and nothing to leak from the database — but
// the link still cannot be forged or walked from one user to the next, because
// without the secret there is no way to produce a valid digest for an id.
//
// It is deliberately not the session or JWT: an unsubscribe link lives in an
// inbox for years and gets forwarded. It must grant exactly one ability —
// turning off one kind of mail — and nothing else.
const { createHmac, timingSafeEqual } = require("node:crypto");

const SECRET = () => process.env.JWT_SECRET || "";

function tokenFor(userId, kind) {
  if (!SECRET()) throw new Error("JWT_SECRET is required to sign unsubscribe links.");
  return createHmac("sha256", SECRET())
    .update(`unsubscribe:${kind}:${String(userId)}`)
    .digest("hex")
    .slice(0, 32);
}

// Compared with timingSafeEqual rather than ===, so the comparison cannot be
// used to recover a valid token one character at a time.
function verify(userId, kind, token) {
  if (typeof token !== "string" || token.length !== 32) return false;
  let expected;
  try {
    expected = tokenFor(userId, kind);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function linkFor(userId, kind, baseUrl) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  return `${origin}/user/unsubscribe/${kind}/${userId}/${tokenFor(userId, kind)}`;
}

// The kinds an unsubscribe link may switch off, mapped to the field it clears.
// An unknown kind is rejected rather than defaulted, so a typo in a link cannot
// silently turn off the wrong thing — or nothing at all, while telling the
// reader it worked.
const KINDS = {
  "new-post": "notificationPreferences.emailOnNewPost",
  // A reply is a comment as far as the reader is concerned, so both are
  // governed by the one preference rather than splitting hairs in settings.
  "comment": "notificationPreferences.emailOnComment",
  "follow": "notificationPreferences.emailOnFollow",
  "digest": "notificationPreferences.emailOnWeeklyDigest",
};

module.exports = { tokenFor, verify, linkFor, KINDS };
