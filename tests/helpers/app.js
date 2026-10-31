// Shared test harness: boots the real Express app against a throwaway in-memory
// MongoDB, with Redis and the queue left unconfigured so the app uses its
// in-process fallbacks.
//
// Node's test runner gives each test FILE its own process, so each file calls
// bootApp() once and gets an isolated database.
const path = require("path");
const jwt = require("jsonwebtoken");

const ROOT = path.join(__dirname, "..", "..");

// Set at module scope, not inside bootApp(): several modules validate their
// configuration at require time (services/authentication.js throws without
// JWT_SECRET), so merely requiring one of them from a test file before bootApp()
// ran would crash. Requiring this helper is enough to make the env safe.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-that-is-long-enough";
process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
// index.js calls dotenv.config() at require time, which would read the
// developer's real .env and put back everything deleted below — so the suite
// would pass in a clean checkout and fail on any machine that actually has a
// .env, with confusing symptoms (Google sign-in "configured", REDIS_URL
// pointing at the production instance). Neutralise it here, before index.js is
// ever required: the tests must see only what this harness sets.
require("dotenv").config = () => ({ parsed: {} });

// Keep the app on its single-process fallbacks (memory cache, inline jobs).
delete process.env.REDIS_URL;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

async function bootApp() {
  const { MongoMemoryServer } = require("mongodb-memory-server");
  const mongoose = require("mongoose");

  const mem = await MongoMemoryServer.create();
  const uri = mem.getUri("blogify_test");
  // Must be set before index.js is required: the session store reads it at
  // module load time.
  process.env.MONGODB_URL = uri;
  await mongoose.connect(uri);

  const app = require(path.join(ROOT, "index.js"));

  return {
    app,
    mongoose,
    User: require(path.join(ROOT, "models/user")),
    Blog: require(path.join(ROOT, "models/blog")),
    Comment: require(path.join(ROOT, "models/comment")),
    Notification: require(path.join(ROOT, "models/Notification")),
    async stop() {
      await mongoose.disconnect();
      await mem.stop();
    },
  };
}

// The app authenticates from a JWT in the `token` cookie, so tests can sign in
// without going through the captcha-protected form.
function authCookie(user) {
  const token = jwt.sign(
    { _id: user._id, email: user.email, profilePic: user.profilePic, role: user.role || "USER" },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  return `token=${token}`;
}

// CSRF protection is global, so any POST needs a token minted against a session.
// Returns { token, cookie } to send together.
async function csrfFor(request, app) {
  const res = await request(app).get("/user/signin");
  const token = (res.text.match(/name="_csrf"[^>]*value="([^"]+)"/) || [])[1];
  const cookies = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]);
  return { token, cookie: cookies.join("; ") };
}

const bodyNonce = (html) => (String(html).match(/nonce="([^"]+)"/) || [])[1] || null;
const headerNonce = (csp) => (String(csp || "").match(/'nonce-([^']+)'/) || [])[1] || null;

module.exports = { bootApp, authCookie, csrfFor, bodyNonce, headerNonce };
