// Email helpers for sign-ups where one person should count once (the Earn
// waitlist, and later the rewards program).

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

// Domains that hand out throwaway inboxes. Not exhaustive — it only has to make
// farming a little more tedious, not impossible.
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "sharklasers.com", "10minutemail.com",
  "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "throwawaymail.com",
  "yopmail.com", "yopmail.net", "getnada.com", "nada.email", "dispostable.com", "trashmail.com",
  "maildrop.cc", "mintemail.com", "mohmal.com", "fakeinbox.com", "emailondeck.com", "spamgourmet.com",
  "mailnesia.com", "tempail.com", "burnermail.io", "moakt.com", "tmail.ws", "inboxkitten.com", "mail.tm",
]);

const isValidEmail = (email) => EMAIL_RE.test(String(email || "").trim());

/**
 * One canonical form per inbox: lower case, and for Gmail the "+tag" and dots
 * removed (name+1@gmail.com and n.a.m.e@gmail.com reach the same inbox).
 */
function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

const isDisposable = (email) => {
  const domain = String(email || "").trim().toLowerCase().split("@").pop();
  return DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith("." + d));
};

module.exports = { isValidEmail, normalizeEmail, isDisposable };
