// ML features against a real (in-memory) database: reading signals, hybrid
// search, topics, trends, "for you", writer tools, moderation, tag cleaning.
// Embeddings are written directly (no AI key in tests), so everything here
// exercises the non-AI paths that run when Gemini is unavailable.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

let ctx;
let ReadEvent, Topic, ModerationLog, EMBEDDING_MODEL_ID;
let seq = 0;

test.before(async () => {
  ctx = await bootApp();
  ReadEvent = require("../models/readEvent");
  Topic = require("../models/topic");
  ModerationLog = require("../models/moderationLog");
  ({ EMBEDDING_MODEL_ID } = require("../services/ai"));
});
test.after(async () => { if (ctx) await ctx.stop(); });

const DIM = 8;
const axis = (i, jitter = 0) => Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0) + (j === (i + 1) % DIM ? jitter : 0));

const makeUser = (over = {}) =>
  ctx.User.create({
    fullName: `Member ${++seq}`,
    email: `m${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

const makePost = (author, over = {}) =>
  ctx.Blog.create({
    title: `Post ${++seq}`,
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    status: "published",
    createdBy: author._id,
    ...over,
  });

async function as(user, method, path, body) {
  const { token, cookie } = await csrfFor(request, ctx.app);
  let req = request(ctx.app)[method](path)
    .set("Cookie", user ? `${cookie}; ${authCookie(user)}` : cookie)
    .set("Accept", "application/json")
    .set("x-csrf-token", token);
  if (body !== undefined) req = req.send(body);
  return req;
}

// --- reading signals -----------------------------------------------------------

test("a reading signal is recorded once per session, keeping the best values", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const post = await makePost(author);
  const send = (seconds, depth, user = reader) =>
    request(ctx.app)
      .post("/signals/read")
      .set("Cookie", user ? authCookie(user) : "")
      .set("User-Agent", "Mozilla/5.0 (Macintosh) Test")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ blogId: String(post._id), seconds, depth }));

  assert.equal((await send(40, 0.3)).status, 204);
  await send(25, 0.9); // later checkpoint: less time reported, more depth
  await new Promise((r) => setTimeout(r, 100));
  const events = await ReadEvent.find({ blogId: post._id }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].seconds, 40);
  assert.equal(events[0].depth, 0.9);
  assert.equal(String(events[0].authorId), String(author._id));

  await send(500, 1, author); // authors reading their own post don't count
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await ReadEvent.countDocuments({ blogId: post._id }), 1);

  const bot = await request(ctx.app)
    .post("/signals/read")
    .set("User-Agent", "Googlebot/2.1")
    .set("Content-Type", "text/plain")
    .send(JSON.stringify({ blogId: String(post._id), seconds: 30, depth: 1 }));
  assert.equal(bot.status, 204);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await ReadEvent.countDocuments({ blogId: post._id }), 1, "bots ignored");
});

// --- search --------------------------------------------------------------------

test("search finds posts by title while typing and by keywords, and says how", async () => {
  const author = await makeUser();
  await makePost(author, { title: "Understanding Kubernetes Operators", body: "<p>" + "controllers reconcile state ".repeat(20) + "</p>" });
  const reader = await makeUser();

  const live = await as(reader, "get", "/blog/api/search?q=" + encodeURIComponent("kubernetes oper"));
  assert.equal(live.status, 200);
  assert.ok(live.body.results.some((r) => r.title === "Understanding Kubernetes Operators"), "a half-typed title matches");

  const page = await request(ctx.app).get("/blog/search?q=" + encodeURIComponent("reconcile controllers"));
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Understanding Kubernetes Operators"));

  const short = await as(reader, "get", "/blog/api/search?q=k");
  assert.deepEqual(short.body.results, []);
});

// --- topics + trends ---------------------------------------------------------

test("topics cluster posts by meaning, get names, pages, and new posts join them", async () => {
  const author = await makeUser();
  const make = (title, vec, tags) =>
    makePost(author, { title, tags, embedding: vec, embeddingModel: EMBEDDING_MODEL_ID });
  for (let i = 0; i < 6; i++) await make(`Neural networks part ${i}`, axis(0, i * 0.02), ["Machine Learning"]);
  for (let i = 0; i < 6; i++) await make(`Sourdough baking day ${i}`, axis(4, i * 0.02), ["Baking"]);

  const { buildTopics, nearestTopicId } = require("../services/ml/topics");
  const result = await buildTopics({ useAi: false });
  assert.equal(result.built, true);
  const topics = await Topic.find().lean();
  const labels = topics.map((t) => t.label).sort();
  assert.ok(labels.includes("Machine Learning") && labels.includes("Baking"), labels.join(","));

  const ml = topics.find((t) => t.label === "Machine Learning");
  assert.equal(await ctx.Blog.countDocuments({ topic: ml._id }), 6, "every post points at its topic");
  assert.equal(String(await nearestTopicId(axis(0, 0.05))), String(ml._id));

  const index = await request(ctx.app).get("/topics");
  assert.equal(index.status, 200);
  assert.ok(index.text.includes("Machine Learning"));
  const one = await request(ctx.app).get(`/topics/${ml.slug}`);
  assert.equal(one.status, 200);
  assert.ok(one.text.includes("Neural networks part"));
  assert.equal((await request(ctx.app).get("/topics/no-such-topic")).status, 404);
});

test("trends: a topic read much more this week than before is rising", async () => {
  const author = await makeUser();
  const topic = await Topic.create({ slug: `rising-${seq}`, label: "Rising Thing", size: 1 });
  const post = await makePost(author, { topic: topic._id, tags: ["Rising Tag"] });
  const now = Date.now();
  const docs = [];
  for (let i = 0; i < 25; i++) docs.push({ blogId: post._id, authorId: author._id, viewer: `a:v${i}`, seconds: 60, depth: 1, createdAt: new Date(now - (i % 6) * 864e5) });
  for (let i = 0; i < 4; i++) docs.push({ blogId: post._id, authorId: author._id, viewer: `a:o${i}`, seconds: 60, depth: 1, createdAt: new Date(now - (10 + i * 5) * 864e5) });
  await ReadEvent.insertMany(docs);

  const { computeTrends } = require("../services/ml/trendService");
  const trends = await computeTrends({ now });
  assert.ok(trends.topics.some((t) => t.label === "Rising Thing"), JSON.stringify(trends));
  assert.ok(trends.tags.some((t) => t.tag === "Rising Tag"));
});

// --- for you -------------------------------------------------------------------

test("For you recommends what's close to what the reader engaged with, with a reason", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const seen = await makePost(author, { title: "Rust ownership, explained", embedding: axis(2), embeddingModel: EMBEDDING_MODEL_ID });
  const close = await makePost(author, { title: "Borrow checker tips", embedding: axis(2, 0.1), embeddingModel: EMBEDDING_MODEL_ID });
  await makePost(author, { title: "Gardening in spring", embedding: axis(6), embeddingModel: EMBEDDING_MODEL_ID });
  await ReadEvent.create({ blogId: seen._id, authorId: author._id, userId: reader._id, viewer: `u:${reader._id}`, seconds: 300, depth: 1 });

  const { recommendForUser } = require("../services/ml/forYouService");
  const fresh = await ctx.User.findById(reader._id);
  const recs = await recommendForUser(fresh, { limit: 5 });
  assert.ok(recs && recs.length, "has recommendations");
  assert.equal(String(recs[0]._id), String(close._id));
  assert.ok(!recs.some((r) => String(r._id) === String(seen._id)), "not what they already read");
  assert.match(recs[0].reason, /Because you read “Rust ownership, explained”/);

  const home = await request(ctx.app).get("/").set("Cookie", authCookie(reader));
  assert.ok(home.text.includes("Borrow checker tips"));
  assert.ok(home.text.includes("Because you read"));
});

// --- writer tools --------------------------------------------------------------

test("writer tools need a sign-in, are locked for new writers, and work without an AI key", async () => {
  const newbie = await makeUser();
  assert.equal((await as(null, "get", "/writer/best-time?tz=-330")).status, 401);
  const locked = await as(newbie, "get", "/writer/best-time?tz=-330");
  assert.equal(locked.status, 403);
  assert.equal(locked.body.locked, true);
  assert.equal((await as(newbie, "post", "/writer/review", { title: "x", body: "y" })).status, 403);

  const writer = await makeUser({ featureGrants: ["bestTime", "ai"] });
  const best = await as(writer, "get", "/writer/best-time?tz=-330");
  assert.equal(best.status, 200);
  assert.ok(["audience", "site", "none"].includes(best.body.source));

  const review = await as(writer, "post", "/writer/review", { title: "x", body: "<p>" + "word ".repeat(60) + "</p>" });
  assert.equal(review.status, 503, "AI review says it's unavailable rather than failing");
});

// --- moderation ----------------------------------------------------------------

test("spam comments are blocked, rude ones posted but held for review", async () => {
  const author = await makeUser();
  const post = await makePost(author);
  const spammer = await makeUser();
  const spam = await as(spammer, "post", `/blog/comment/${post._id}`, {
    content: "Cheap SEO services, increase your traffic! Click here bit.ly/abc and www.spam-site.xyz now",
  });
  assert.equal(spam.status, 400);
  assert.equal(await ctx.Comment.countDocuments({ blogId: post._id, createdBy: spammer._id }), 0);
  assert.ok(await ModerationLog.exists({ userId: spammer._id, actionTaken: "BLOCKED" }));

  const rude = await makeUser();
  await as(rude, "post", `/blog/comment/${post._id}`, { content: "You're an idiot, nobody asked for this take." });
  const held = await ModerationLog.findOne({ userId: rude._id, actionTaken: "FLAGGED" }).lean();
  assert.ok(held, "held for review");
  assert.ok(held.commentId, "points at the posted comment");
  assert.ok(await ctx.Comment.exists({ _id: held.commentId }), "still visible until a moderator decides");

  const admin = await makeUser({ role: "ADMIN" });
  const page = await request(ctx.app).get("/admin/moderation").set("Cookie", authCookie(admin));
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Needs review"));
  const del = await as(admin, "post", `/admin/moderation/${held._id}/resolve`, { action: "delete" });
  assert.equal(del.status, 302);
  assert.equal(await ctx.Comment.exists({ _id: held.commentId }), null);
});

// --- tags ----------------------------------------------------------------------

test("tag filter treats #poetry, Poetry and poetry as one tag", async () => {
  const author = await makeUser();
  await makePost(author, { title: "Hash Poem", tags: ["#poetry"] });
  await makePost(author, { title: "Cap Poem", tags: ["Poetry"] });
  const res = await request(ctx.app).get("/blog/api/feed?page=1&tag=poetry");
  const titles = res.body.blogs.map((b) => b.title);
  assert.ok(titles.includes("Hash Poem") && titles.includes("Cap Poem"), titles.join(","));
});
