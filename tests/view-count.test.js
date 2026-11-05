// What a view means: a real reader, counted once per window, cached or not.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie } = require("./helpers/app");
const { isBot } = require("../services/viewCounter");

let ctx;
let seq = 0;

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

test.before(async () => { ctx = await bootApp(); });
test.after(async () => { if (ctx) await ctx.stop(); });

const makeAuthor = () =>
  ctx.User.create({
    fullName: `Author ${++seq}`,
    email: `a${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
  });

const makePost = (author) =>
  ctx.Blog.create({
    title: `Readable Post ${++seq}`,
    body: "<p>" + "word ".repeat(40) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
  });

const viewsOf = async (post) =>
  (await ctx.Blog.findById(post._id).select("views").lean()).views || 0;

// The count is incremented without being awaited, so give it a moment.
async function settle() {
  await new Promise((r) => setTimeout(r, 250));
}

// A different address each time, so one test's reader is not another's.
let ipSeq = 0;
const freshReader = () => ({
  "User-Agent": BROWSER,
  "X-Forwarded-For": `203.0.113.${(ipSeq += 1) % 250}`,
});

test("a real reader counts once", async () => {
  const post = await makePost(await makeAuthor());
  await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  await settle();
  assert.equal(await viewsOf(post), 1);
});

test("the same reader refreshing does not count again", async () => {
  const post = await makePost(await makeAuthor());
  const reader = freshReader();

  for (let i = 0; i < 5; i += 1) {
    await request(ctx.app).get(`/blog/${post.slug}`).set(reader);
  }
  await settle();
  assert.equal(await viewsOf(post), 1, "five requests, one reader, one view");
});

test("two different readers count twice", async () => {
  const post = await makePost(await makeAuthor());
  await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  await settle();
  await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  await settle();
  assert.equal(await viewsOf(post), 2);
});

test("a signed-in reader is counted as themselves, not as their address", async () => {
  const post = await makePost(await makeAuthor());
  const reader = await makeAuthor();
  const shared = freshReader();

  // Same address and browser; different accounts must still count separately.
  await request(ctx.app).get(`/blog/${post.slug}`).set(shared).set("Cookie", authCookie(reader));
  await settle();
  const other = await makeAuthor();
  await request(ctx.app).get(`/blog/${post.slug}`).set(shared).set("Cookie", authCookie(other));
  await settle();

  assert.equal(await viewsOf(post), 2);
});

test("crawlers and link previews are not readers", async () => {
  const post = await makePost(await makeAuthor());

  const agents = [
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "facebookexternalhit/1.1",
    "WhatsApp/2.23",
    "Twitterbot/1.0",
    "curl/8.4.0",
    "python-requests/2.31.0",
    "Mozilla/5.0 (compatible; bingbot/2.0)",
    "Slackbot-LinkExpanding 1.0",
  ];

  for (const ua of agents) {
    await request(ctx.app)
      .get(`/blog/${post.slug}`)
      .set({ "User-Agent": ua, "X-Forwarded-For": `198.51.100.${agents.indexOf(ua) + 1}` });
  }
  await settle();
  assert.equal(await viewsOf(post), 0, "none of these are reading anything");
});

test("a request with no user agent is not a reader either", async () => {
  assert.equal(isBot(""), true);
  assert.equal(isBot(undefined), true);
  assert.equal(isBot(BROWSER), false);
});

test("a read served from the page cache is still counted", async () => {
  const pageCache = require("../services/pageCache");
  const post = await makePost(await makeAuthor());

  // First anonymous read fills the cache...
  await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  await settle();
  assert.ok(pageCache.get(`/blog/${post.slug}`), "the page is now cached");

  // ...the second is served from memory and never reaches the blog route.
  // This is the read the old counter missed entirely.
  await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  await settle();

  assert.equal(await viewsOf(post), 2, "the cached read counted too");
});

test("the post page still renders the count", async () => {
  const post = await makePost(await makeAuthor());
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 41 } });

  const res = await request(ctx.app).get(`/blog/${post.slug}`).set(freshReader());
  assert.equal(res.status, 200);
  assert.match(res.text, /41/);
});

test("a view of a post that does not exist is harmless", async () => {
  const res = await request(ctx.app)
    .get("/blog/nothing-here-abc123")
    .set(freshReader());
  await settle();
  assert.equal(res.status, 404);
});
