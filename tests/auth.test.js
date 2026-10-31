// Sign-up, sign-in and password-reset behaviour, including the scrypt migration.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const request = require("supertest");
const path = require("node:path");

// Stub the mailer BEFORE the app loads: routes/user.js destructures
// sendVerificationEmail at module load, and we don't want tests reaching SMTP.
const emailService = require("../services/emailService");
const sentMail = [];
emailService.sendVerificationEmail = async (to, token) => { sentMail.push({ kind: "verify", to, token }); };
emailService.sendResetPasswordEmail = async (to, link) => { sentMail.push({ kind: "reset", to, link }); };

const { bootApp, csrfFor } = require("./helpers/app");

let ctx, PendingUser;

test.before(async () => {
  ctx = await bootApp();
  PendingUser = require(path.join(__dirname, "..", "models", "pendingUser"));
});

test.after(async () => {
  if (ctx) await ctx.stop();
});

test("a new account's password is stored as a scrypt hash", async () => {
  await ctx.User.create({
    fullName: "Grace Hopper",
    email: "grace@example.com",
    password: "password123",
    isVerified: true,
  });

  const stored = await ctx.User.findOne({ email: "grace@example.com" }).select("+password +salt");
  assert.match(stored.password, /^scrypt\$/, "must not be a bare HMAC digest");
  assert.notEqual(stored.password, "password123");
  assert.ok(stored.salt);
});

test("sign-in succeeds with the right password and fails with the wrong one", async () => {
  const token = await ctx.User.matchPasswordAndGenerateToken("grace@example.com", "password123");
  assert.equal(typeof token, "string");
  assert.ok(token.split(".").length === 3, "expected a JWT");

  await assert.rejects(
    () => ctx.User.matchPasswordAndGenerateToken("grace@example.com", "wrong-password"),
    /Incorrect password/
  );
  await assert.rejects(
    () => ctx.User.matchPasswordAndGenerateToken("nobody@example.com", "password123"),
    /User not found/
  );
});

test("a legacy HMAC account can still sign in, and is upgraded to scrypt", async () => {
  const user = await ctx.User.create({
    fullName: "Legacy User",
    email: "legacy@example.com",
    password: "placeholder-password",
    isVerified: true,
  });

  // Rewrite the record the way the old code stored it: one round of HMAC-SHA256.
  const salt = "f".repeat(32);
  const legacyHash = createHmac("sha256", salt).update("my-old-password").digest("hex");
  await ctx.User.updateOne({ _id: user._id }, { $set: { password: legacyHash, salt } });

  const before = await ctx.User.findOne({ _id: user._id }).select("+password");
  assert.equal(before.password, legacyHash, "precondition: stored as legacy");

  const token = await ctx.User.matchPasswordAndGenerateToken("legacy@example.com", "my-old-password");
  assert.ok(token, "legacy password must still authenticate");

  const after = await ctx.User.findOne({ _id: user._id }).select("+password +salt");
  assert.match(after.password, /^scrypt\$/, "hash should be upgraded on successful login");
  assert.notEqual(after.salt, salt, "upgrade should re-salt");

  // And the upgraded record still authenticates.
  assert.ok(await ctx.User.matchPasswordAndGenerateToken("legacy@example.com", "my-old-password"));
  await assert.rejects(
    () => ctx.User.matchPasswordAndGenerateToken("legacy@example.com", "wrong"),
    /Incorrect password/
  );
});

test("signup → verify → sign-in works end to end with one hash format", async () => {
  // PendingUser is hashed by the route, User by the schema hook; the verify step
  // copies the hash across with _skipHash, so the two must agree.
  const { token: csrf, cookie } = await csrfFor(request, ctx.app);
  sentMail.length = 0;

  const signup = await request(ctx.app)
    .post("/user/signup")
    .set("Cookie", cookie)
    .type("form")
    .send({ _csrf: csrf, fullName: "Katherine J", email: "katherine@example.com", password: "password123" });
  assert.equal(signup.status, 200);

  const pending = await PendingUser.findOne({ email: "katherine@example.com" });
  assert.ok(pending, "a pending user should exist");
  assert.match(pending.password, /^scrypt\$/, "pending password must use the shared hasher");

  const mail = sentMail.find((m) => m.kind === "verify");
  assert.ok(mail, "a verification email should have been sent");

  const verify = await request(ctx.app).get(`/user/verify/${mail.token}`);
  assert.equal(verify.status, 302);

  const created = await ctx.User.findOne({ email: "katherine@example.com" }).select("+password");
  assert.ok(created, "the account should now exist");
  assert.equal(created.isVerified, true);
  assert.match(created.password, /^scrypt\$/);

  assert.ok(
    await ctx.User.matchPasswordAndGenerateToken("katherine@example.com", "password123"),
    "the password chosen at signup must work after verification"
  );
});

test("forgot-password answers identically for known and unknown addresses", async () => {
  // Returning "no account found" turned this form into an account-existence oracle.
  const a = await csrfFor(request, ctx.app);
  const known = await request(ctx.app)
    .post("/user/forgot-password")
    .set("Cookie", a.cookie)
    .type("form")
    .send({ _csrf: a.token, email: "grace@example.com" });

  const b = await csrfFor(request, ctx.app);
  const unknown = await request(ctx.app)
    .post("/user/forgot-password")
    .set("Cookie", b.cookie)
    .type("form")
    .send({ _csrf: b.token, email: "definitely-not-registered@example.com" });

  assert.equal(known.status, unknown.status, "status must not differ");

  // Normalise the things that legitimately differ on every request (the CSP
  // nonce and the CSRF token) plus the address being echoed back, then require
  // the two pages to be byte-identical.
  const normalise = (html) =>
    html
      .replace(/definitely-not-registered@example\.com|grace@example\.com/g, "EMAIL")
      .replace(/nonce="[^"]*"/g, 'nonce="N"')
      // With no BASE_URL set, canonical/og tags fall back to the host the request
      // arrived on, and supertest binds a fresh ephemeral port per request — so the
      // port differs between these two calls for reasons unrelated to enumeration.
      .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, "http://HOST")
      .replace(/(name="_csrf"[^>]*value=)"[^"]*"/g, '$1"T"');

  assert.equal(normalise(known.text), normalise(unknown.text), "response body must not differ");

  for (const res of [known, unknown]) {
    assert.ok(!/no account/i.test(res.text), "must not reveal that an address is unregistered");
  }

  // The known address still actually got a reset token.
  const user = await ctx.User.findOne({ email: "grace@example.com" }).select("+resetPasswordToken");
  assert.ok(user.resetPasswordToken, "a real account should still receive a token");
  assert.ok(sentMail.some((m) => m.kind === "reset" && m.to === "grace@example.com"));
  assert.ok(!sentMail.some((m) => m.kind === "reset" && m.to.startsWith("definitely-not")));
});
