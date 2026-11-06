// Feed filtering: category and tag, on both the server-rendered home page and
// the JSON feed that the filter chips and infinite scroll use.
//
// These cover three things that were broken:
//   1. `?category=` was matched with an unescaped case-insensitive regex, so
//      `?category=.*` returned the whole site.
//   2. The JSON feed ignored `?tag=` completely and served the unfiltered feed.
//   3. The server rendered 8 posts per page while the JSON feed returned 5, so
//      the first infinite-scroll request re-sent posts 6, 7 and 8.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { bootApp, authCookie } = require("./helpers/app");

let ctx, cookie;
// Only the titles inside the main feed grid. The page also renders unfiltered
// "featured" and "trending" rails with the same card markup, so a match across
// the whole document would count posts the filter is not supposed to touch.
const titlesOf = (html) => {
  const start = html.indexOf('id="bento-grid"');
  const end = html.indexOf('id="pagination-skeleton"');
  if (start === -1 || end === -1 || end < start) {
    throw new Error("could not locate the feed grid in the rendered page");
  }
  // The heading text is followed by newline + indentation before the closing
  // tag, so collapse whitespace rather than assuming the title ends the match.
  return (html.slice(start, end).match(/class="card-heading">([^<]+)</g) || [])
    .map((m) => m.replace(/^.*card-heading">/s, "").replace(/<$/, "")
                 .replace(/\s+/g, " ").trim());
};

before(async () => {
  ctx = await bootApp();
  const { User, Blog } = ctx;

  const author = await User.create({
    fullName: "Filter Author",
    email: "filter-author@example.com",
    password: "password123",
  });
  const reader = await User.create({
    fullName: "Filter Reader",
    email: "filter-reader@example.com",
    password: "password123",
  });
  cookie = authCookie(reader);

  // 12 published posts: 6 in "Design", 6 in "Science"; "react" on every third.
  const docs = [];
  for (let i = 0; i < 12; i++) {
    docs.push({
      title: `Filterable Post ${String(i).padStart(2, "0")}`,
      body: "word ".repeat(300),
      category: i % 2 === 0 ? "Design" : "Science",
      // Real tags in this app contain spaces ("Artificial Intelligence") and a
      // couple carry a leading "#", so both shapes are represented here.
      tags: i % 3 === 0 ? ["react", "Machine Learning"] : ["#poetry"],
      status: "published",
      createdBy: author._id,
      views: i,
      createdAt: new Date(Date.now() - i * 60000),
    });
  }
  await Blog.insertMany(docs);
});

after(async () => { await ctx.stop(); });

test("category filter returns only that category, matching case-insensitively", async () => {
  const res = await request(ctx.app).get("/?category=design").set("Cookie", cookie);
  assert.equal(res.status, 200);
  const titles = titlesOf(res.text);
  assert.ok(titles.length > 0, "expected some posts");
  // Design posts are the even-numbered ones.
  for (const t of titles) {
    const n = Number(t.match(/(\d+)$/)[1]);
    assert.equal(n % 2, 0, `${t} is not a Design post`);
  }
});

test("a regex in ?category= does not match everything", async () => {
  const res = await request(ctx.app).get("/?category=.*").set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.equal(titlesOf(res.text).length, 0,
    "`?category=.*` must not behave like a wildcard over every post");
});

test("a catastrophic regex in ?category= is not compiled against the data", async () => {
  const started = Date.now();
  const res = await request(ctx.app)
    .get("/?category=" + encodeURIComponent("(a+)+$"))
    .set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 5000, "request should not hang on a backtracking pattern");
});

test("tag filter works on the server-rendered page", async () => {
  const res = await request(ctx.app).get("/?tag=react").set("Cookie", cookie);
  assert.equal(res.status, 200);
  const titles = titlesOf(res.text);
  assert.ok(titles.length > 0, "expected some posts");
  for (const t of titles) {
    const n = Number(t.match(/(\d+)$/)[1]);
    assert.equal(n % 3, 0, `${t} should not carry the react tag`);
  }
});

test("the JSON feed honours ?tag=", async () => {
  const res = await request(ctx.app).get("/blog/api/feed?page=1&tag=react");
  assert.equal(res.status, 200);
  assert.ok(res.body.blogs.length > 0);
  for (const b of res.body.blogs) {
    assert.ok(b.tags.includes("react"), `${b.title} is missing the react tag`);
  }
});

test("the JSON feed honours ?category=", async () => {
  const res = await request(ctx.app).get("/blog/api/feed?page=1&category=science");
  assert.equal(res.status, 200);
  assert.ok(res.body.blogs.length > 0);
  for (const b of res.body.blogs) {
    assert.equal(b.category, "Science");
  }
});

test("infinite scroll does not repeat the posts the server already rendered", async () => {
  // This is the real duplication path: the browser gets page 1 rendered into the
  // HTML, then asks the JSON feed for page 2. If the two disagree about the page
  // size, page 2 starts before the server-rendered page ended and the reader
  // sees the same cards twice.
  const home = await request(ctx.app).get("/?category=all").set("Cookie", cookie);
  assert.equal(home.status, 200);
  const rendered = titlesOf(home.text);
  assert.ok(rendered.length > 0, "expected a server-rendered first page");

  const p2 = await request(ctx.app).get("/blog/api/feed?page=2&category=all");
  assert.equal(p2.status, 200);
  const next = p2.body.blogs.map((b) => b.title);

  const overlap = next.filter((t) => rendered.includes(t));
  assert.deepEqual(overlap, [],
    "the JSON feed page size must match the server-rendered page size");
});

test("the first feed page matches the page size the home route renders", async () => {
  const { FEED_PAGE_SIZE } = require("../services/taxonomy");
  const res = await request(ctx.app).get("/blog/api/feed?page=1");
  assert.equal(res.body.blogs.length, FEED_PAGE_SIZE);
});

test("an unknown category returns nothing rather than everything", async () => {
  const res = await request(ctx.app).get("/blog/api/feed?page=1&category=no-such-category");
  assert.equal(res.status, 200);
  assert.equal(res.body.blogs.length, 0);
});

test("a tag containing a space can be filtered", async () => {
  const res = await request(ctx.app)
    .get("/?tag=" + encodeURIComponent("Machine Learning"))
    .set("Cookie", cookie);
  assert.equal(res.status, 200);
  const titles = titlesOf(res.text);
  assert.ok(titles.length > 0, "a multi-word tag must still match");
  for (const t of titles) {
    const n = Number(t.match(/(\d+)$/)[1]);
    assert.equal(n % 3, 0, `${t} does not carry the Machine Learning tag`);
  }
});

test("a tag stored with a leading # can be filtered", async () => {
  const res = await request(ctx.app)
    .get("/blog/api/feed?page=1&tag=" + encodeURIComponent("#poetry"));
  assert.equal(res.status, 200);
  assert.ok(res.body.blogs.length > 0, "expected the #poetry posts");
  for (const b of res.body.blogs) {
    assert.ok(b.tags.includes("#poetry"), `${b.title} is missing the #poetry tag`);
  }
});

test("tag matching is case-insensitive", async () => {
  const res = await request(ctx.app)
    .get("/blog/api/feed?page=1&tag=" + encodeURIComponent("machine learning"));
  assert.equal(res.status, 200);
  assert.ok(res.body.blogs.length > 0, "lowercase input must match the stored casing");
});
