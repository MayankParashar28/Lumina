/**
 * Route / auth / CSRF integration tests.
 *
 * Uses Node's built-in test runner (`node --test`) + supertest against the real
 * Express app, backed by an in-memory MongoDB (mongodb-memory-server).
 * index.js is import-safe under NODE_ENV=test: it does not connect to the real
 * database or bind a port, so the suite controls both.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod;
let app;
let request;
let Blog;

// Pull the hidden _csrf token out of a rendered HTML form.
const extractCsrf = (html) => {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
};

before(async () => {
  process.env.NODE_ENV = "test";
  mongod = await MongoMemoryServer.create();
  // Set BEFORE requiring the app (dotenv won't override an already-set var).
  process.env.MONGODB_URL = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret";
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test_session_secret";
  // Disable external AI (Gemini) and Redis so tests never make external network calls
  process.env.GOOGLE_GEMINI_API_KEY = "";
  process.env.GOOGLE_EMBEDDING_API_KEY = "";
  process.env.GOOGLE_GEMINI_KEY_LIGHT = "";
  process.env.REDIS_URL = "";

  await mongoose.connect(process.env.MONGODB_URL);

  request = require("supertest");
  app = require("../index");
  Blog = require("../models/blog");
  await Blog.init(); // ensure the text index is built for keyword search
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ---- Public routes ----
test("GET /health returns 200 and ok status", async () => {
  const res = await request(app).get("/health");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, "ok");
});

test("GET / renders (200)", async () => {
  const res = await request(app).get("/");
  assert.strictEqual(res.status, 200);
});

test("GET /about renders (200)", async () => {
  const res = await request(app).get("/about");
  assert.strictEqual(res.status, 200);
});

test("GET /user/signin renders a form with a CSRF token", async () => {
  const res = await request(app).get("/user/signin");
  assert.strictEqual(res.status, 200);
  assert.ok(extractCsrf(res.text), "expected a _csrf token in the sign-in form");
});

test("GET /blog/api/feed returns JSON blogs array (200)", async () => {
  const res = await request(app).get("/blog/api/feed?page=1&category=all");
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(res.body.blogs));
});

test("unknown route returns 404", async () => {
  const res = await request(app).get("/this-page-does-not-exist");
  assert.strictEqual(res.status, 404);
});

test("removed payment route /subscribe is gone (404)", async () => {
  const res = await request(app).get("/subscribe");
  assert.strictEqual(res.status, 404);
});

// ---- Auth gates (unauthenticated) ----
test("GET /user/profile redirects to sign-in", async () => {
  const res = await request(app).get("/user/profile");
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, "/user/signin");
});

test("GET /admin redirects to sign-in", async () => {
  const res = await request(app).get("/admin");
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, "/user/signin");
});

test("GET /blog/drafts redirects to sign-in", async () => {
  const res = await request(app).get("/blog/drafts");
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, "/user/signin");
});

test("invalid password-reset token redirects to forgot-password", async () => {
  const res = await request(app).get("/user/reset-password/NOT_A_REAL_TOKEN");
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, "/user/forgot-password");
});

// ---- CSRF protection ----
test("POST /user/signin without a token is rejected (403)", async () => {
  const res = await request(app)
    .post("/user/signin")
    .type("form")
    .send({ email: "a@b.com", password: "whatever12" });
  assert.strictEqual(res.status, 403);
});

test("POST /user/signin with a valid token passes CSRF (reaches captcha -> 400, not 403)", async () => {
  const agent = request.agent(app);
  const page = await agent.get("/user/signin");
  const token = extractCsrf(page.text);
  assert.ok(token);

  const res = await agent
    .post("/user/signin")
    .type("form")
    .send({ _csrf: token, email: "a@b.com", password: "whatever12", captcha: "zzz" });

  assert.notStrictEqual(res.status, 403); // CSRF accepted
  assert.strictEqual(res.status, 400); // failed at the captcha check instead
});

// ---- Comment auth guard (#21) ----
test("posting a comment while logged out returns 401 (valid CSRF, no crash)", async () => {
  const agent = request.agent(app);
  const page = await agent.get("/user/signin");
  const token = extractCsrf(page.text);

  const res = await agent
    .post("/blog/comment/5f9f1b9b9b9b9b9b9b9b9b9b")
    .set("Accept", "application/json")
    .type("form")
    .send({ _csrf: token, content: "hello from a logged-out user" });

  assert.strictEqual(res.status, 401);
});

// ---- Semantic search (/blog/search) ----
test("GET /blog/search renders the search page (200)", async () => {
  const res = await request(app).get("/blog/search");
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes('action="/blog/search"'), "expected the search form");
});

test("GET /blog/search?q=... is NOT mis-routed as a blog id", async () => {
  const res = await request(app).get("/blog/search?q=hello");
  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes("Invalid Blog ID"), "/blog/search must not hit the /:id handler");
});

test("search finds a published post by keyword (fallback path)", async () => {
  await Blog.create({
    title: "Quantum Computing Basics",
    body: "An introduction to quantum computing, qubits and superposition for beginners.",
    category: "Science",
    status: "published",
    createdBy: new mongoose.Types.ObjectId(),
  });

  const res = await request(app).get("/blog/search?q=quantum");
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes("Quantum Computing Basics"), "expected the seeded post in results");
});
