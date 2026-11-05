// Public page rendering: the anonymous HTML micro-cache, the browse shortcuts,
// and the health/SEO endpoints.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, bodyNonce, headerNonce } = require("./helpers/app");

let ctx, blog;

test.before(async () => {
  ctx = await bootApp();
  const author = await ctx.User.create({
    fullName: "Ada Lovelace",
    email: "ada@example.com",
    password: "password123",
    isVerified: true,
  });
  blog = await ctx.Blog.create({
    title: "On Analytical Engines",
    body: "<p>A note about engines.</p>",
    category: "tech",
    tags: ["computing"],
    createdBy: author._id,
    status: "published",
  });
});

test.after(async () => {
  if (ctx) await ctx.stop();
});

test("the landing page serves a cache HIT on the second anonymous request", async () => {
  const first = await request(ctx.app).get("/");
  const second = await request(ctx.app).get("/");

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.headers["x-cache"], "MISS");
  assert.equal(second.headers["x-cache"], "HIT");
});

test("a cached page's CSP nonce matches the nonce in its HTML", async () => {
  // Regression test. The cache stores fully-rendered HTML containing one nonce,
  // but a fresh nonce is minted per request and written into the CSP header, so
  // on a cache hit the two disagreed and the browser blocked every inline
  // <script> in the page.
  const url = `/blog/${blog.slug}`;

  const miss = await request(ctx.app).get(url);
  assert.equal(miss.headers["x-cache"], "MISS");
  assert.equal(
    bodyNonce(miss.text),
    headerNonce(miss.headers["content-security-policy"]),
    "nonce should match on a cache miss"
  );

  const hit = await request(ctx.app).get(url);
  assert.equal(hit.headers["x-cache"], "HIT");
  assert.ok(bodyNonce(hit.text), "cached HTML should still carry a nonce");
  assert.equal(
    bodyNonce(hit.text),
    headerNonce(hit.headers["content-security-policy"]),
    "nonce must match on a cache hit, or inline scripts are blocked"
  );
});

// The cache key is the path with the query stripped, so a request carrying a
// query string must not be cached under the bare path — it would be served to
// everyone who asks for the page without one. Two ways that bites: /?category=x
// renders a filtered feed, and /blog/<slug>?published=1 renders the author's
// share panel.
test("a request with a query string is never cached under the bare path", async () => {
  const slug = blog.slug;

  const filtered = await request(ctx.app).get("/?category=trending");
  assert.notEqual(filtered.headers["x-cache"], "HIT", "a filtered feed must not be a cache hit");
  const bare = await request(ctx.app).get("/");
  assert.ok(
    !bare.text.includes('id="publish-share"'),
    "the landing page must not come back carrying another request's content"
  );

  const shared = await request(ctx.app).get(`/blog/${slug}?published=1`);
  assert.ok(shared.text.includes('id="publish-share"'), "the share panel should render when asked");

  const plain = await request(ctx.app).get(`/blog/${slug}`);
  assert.ok(
    !plain.text.includes('id="publish-share"'),
    "and must not then be served to every reader of the post"
  );
});

test("the cached blog page still contains the script that renders the body", async () => {
  // The article body is injected by a nonce'd inline script, so a nonce mismatch
  // on this page means the post renders completely empty.
  const res = await request(ctx.app).get(`/blog/${blog.slug}`);
  assert.ok(res.text.includes("DOMPurify.sanitize(rawContent)"));
  assert.ok(
    res.text.includes('src="/vendor/dompurify/purify.js"'),
    "DOMPurify should be served locally, not from a CDN"
  );
});

test("DOMPurify is actually served from the app", async () => {
  const res = await request(ctx.app).get("/vendor/dompurify/purify.js");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("DOMPurify"), "expected the real library");
});

test("browse shortcuts redirect to the canonical filtered feed", async () => {
  // These four previously 500'd (category/tag) or were shadowed by /:id and
  // answered "Invalid Blog ID" with a 400 (featured/trending).
  const cases = [
    ["/blog/featured", "/?category=featured"],
    ["/blog/trending", "/?category=trending"],
    ["/blog/category/tech", "/?category=tech"],
    ["/blog/tag/computing", "/?tag=computing"],
  ];

  for (const [from, to] of cases) {
    const res = await request(ctx.app).get(from);
    assert.equal(res.status, 301, `${from} should redirect`);
    assert.equal(res.headers.location, to);
  }
});

test("browse shortcuts escape the values they pass through", async () => {
  const res = await request(ctx.app).get("/blog/tag/a%20b%26c");
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, "/?tag=a%20b%26c");
});

// Posts are addressed by slug now. An ObjectId URL is every permalink shared
// before that was true, so it has to keep resolving — as a 301 to the canonical
// slug, which also hands the accumulated search ranking to the new URL.
test("a legacy blog id permalink redirects to the canonical slug", async () => {
  const res = await request(ctx.app).get(`/blog/${blog._id}`);
  assert.equal(res.status, 301);
  assert.ok(blog.slug, "the post should have been given a slug on creation");
  assert.equal(res.headers.location, `/blog/${blog.slug}`);
});

test("a blog is served at its slug", async () => {
  const res = await request(ctx.app).get(`/blog/${blog.slug}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("On Analytical Engines"));
});

// The slug is built from the title, so it has to survive the round trip as
// something readable rather than an escaped blob.
test("the slug is derived from the title and ends in an id suffix", async () => {
  assert.match(blog.slug, /^on-analytical-engines-[a-f\d]{6}$/);
  assert.equal(blog.slug.slice(-6), blog._id.toString().slice(-6));
});

test("a nonexistent slug is rejected cleanly", async () => {
  const res = await request(ctx.app).get("/blog/not-an-object-id");
  assert.equal(res.status, 404);
});

// Editing the title must not move the post: the old URL is the one that has
// already been shared, and re-slugging would 404 every copy of it.
test("editing the title does not change the slug", async () => {
  const before = blog.slug;
  blog.title = "A Completely Different Title";
  await blog.save();
  assert.equal(blog.slug, before);
});

test("health checks report status", async () => {
  const shallow = await request(ctx.app).get("/health");
  assert.equal(shallow.status, 200);
  assert.equal(shallow.body.status, "ok");

  const deep = await request(ctx.app).get("/healthz");
  assert.equal(deep.status, 200);
  assert.equal(deep.body.mongo, "up");
  assert.equal(deep.body.redis, "disabled", "no REDIS_URL in tests");
});

test("the sitemap uses the configured origin, not a hardcoded host", async () => {
  process.env.BASE_URL = "https://lumina.test";
  try {
    const res = await request(ctx.app).get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("<loc>https://lumina.test/</loc>"));
    assert.ok(
      res.text.includes(`<loc>https://lumina.test/blog/${blog.slug}</loc>`),
      "the sitemap must list the canonical slug URL, not one that 301s"
    );
    assert.ok(
      !res.text.includes(`/blog/${blog._id}<`),
      "the ObjectId form must not appear in the sitemap"
    );
    assert.ok(!res.text.includes("lluminaa.vercel.app"), "stale hardcoded domain");
  } finally {
    delete process.env.BASE_URL;
  }
});

test("the Google button is hidden when OAuth isn't configured", async () => {
  const res = await request(ctx.app).get("/user/signin");
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes("Continue with Google"));
});

test("Google auth routes redirect instead of throwing when unconfigured", async () => {
  // Registering the strategy without a clientID used to crash the app at boot;
  // now the strategy simply isn't registered, so these must not 500.
  const res = await request(ctx.app).get("/user/auth/google");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/user/signin");
});
