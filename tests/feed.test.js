// The RSS feed.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp } = require("./helpers/app");

process.env.BASE_URL = "https://llumina.test";

let ctx;
let seq = 0;

test.before(async () => { ctx = await bootApp(); });
test.after(async () => { if (ctx) await ctx.stop(); });

const makeAuthor = () =>
  ctx.User.create({
    fullName: `Feed Author ${++seq}`,
    email: `fa${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
  });

const makePost = (author, over = {}) =>
  ctx.Blog.create({
    title: `Feed Post ${++seq}`,
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

test("the feed is served as RSS and declares itself", async () => {
  const author = await makeAuthor();
  await makePost(author, { title: "Something To Read" });

  const res = await request(ctx.app).get("/rss.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/rss\+xml/);
  assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(res.text, /<rss version="2\.0"/);
  // An RSS reader uses atom:link to know the feed's own address.
  assert.ok(res.text.includes('href="https://llumina.test/rss.xml" rel="self"'));
  assert.ok(res.text.includes("Something To Read"));
});

test("items link to the canonical slug, not the ObjectId", async () => {
  const author = await makeAuthor();
  const post = await makePost(author);

  const res = await request(ctx.app).get("/rss.xml");
  assert.ok(res.text.includes(`https://llumina.test/blog/${post.slug}`));
  assert.ok(!res.text.includes(`/blog/${post._id}<`), "no permalink that would 301");
});

test("drafts, scheduled and private posts are not in the feed", async () => {
  const author = await makeAuthor();
  await makePost(author, { title: "A Draft Here", status: "draft" });
  await makePost(author, { title: "Scheduled Here", status: "scheduled", publishAt: new Date(Date.now() + 864e5) });
  await makePost(author, { title: "Published Here" });

  const res = await request(ctx.app).get("/rss.xml");
  assert.ok(res.text.includes("Published Here"));
  assert.ok(!res.text.includes("A Draft Here"));
  assert.ok(!res.text.includes("Scheduled Here"));
});

test("a title with XML characters does not break the feed", async () => {
  const author = await makeAuthor();
  await makePost(author, { title: `Tom & Jerry <script> "quotes" 'and'` });

  const res = await request(ctx.app).get("/rss.xml");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("Tom &amp; Jerry &lt;script&gt;"), "escaped, not raw");
  assert.ok(!res.text.includes("<script>"), "never raw markup inside an item");

  // And it is still well-formed: every item that opened also closed.
  const opened = (res.text.match(/<item>/g) || []).length;
  const closed = (res.text.match(/<\/item>/g) || []).length;
  assert.equal(opened, closed);
  assert.ok(opened > 0);
});

test("the description is the author's own when they wrote one", async () => {
  const author = await makeAuthor();
  await makePost(author, {
    title: "With A Summary",
    metaDescription: "A hand-written summary of the piece.",
  });

  const res = await request(ctx.app).get("/rss.xml");
  assert.ok(res.text.includes("A hand-written summary of the piece."));
});

test("newest first, and capped", async () => {
  const author = await makeAuthor();
  const old = await makePost(author, { title: "The Elder Post" });
  await ctx.Blog.updateOne({ _id: old._id }, { $set: { createdAt: new Date("2020-01-01") } });
  const fresh = await makePost(author, { title: "The Fresher Post" });

  const res = await request(ctx.app).get("/rss.xml");
  assert.ok(
    res.text.indexOf("The Fresher Post") < res.text.indexOf("The Elder Post"),
    "newest first"
  );
  assert.ok((res.text.match(/<item>/g) || []).length <= 20, "at most 20 items");
  assert.ok(res.text.includes(String(fresh.slug)));
});

test("every page points a feed reader at it", async () => {
  const res = await request(ctx.app).get("/");
  assert.match(
    res.text,
    /<link rel="alternate" type="application\/rss\+xml"[^>]*href="\/rss\.xml">/
  );
});
