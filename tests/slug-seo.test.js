// Permalinks, the authored meta description, and the post-publish share screen.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");
const { buildSlug, slugifyTitle, isSlugParam, isObjectIdParam } = require("../utils/slug");

let ctx, author, cookie;

test.before(async () => {
  ctx = await bootApp();
  author = await ctx.User.create({
    fullName: "Ada Lovelace",
    email: "ada@slug.test",
    password: "a-long-enough-password",
    isVerified: true,
  });
  cookie = authCookie(author);
});

test.after(async () => {
  if (ctx) await ctx.stop();
});

// POST /blog/edit/:id refuses a second update within two minutes. Everything
// here creates a post and edits it immediately, so push updatedAt back first.
async function ageForEdit(post) {
  await ctx.Blog.updateOne(
    { _id: post._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
    { timestamps: false }
  );
}

const makePost = (over = {}) =>
  ctx.Blog.create({
    title: "A Perfectly Ordinary Post",
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

// ---------------------------------------------------------------- slug shape

test("the slug suffix comes from the post's own id, so two identical titles differ", async () => {
  const a = await makePost({ title: "Same Exact Title" });
  const b = await makePost({ title: "Same Exact Title" });

  assert.notEqual(a.slug, b.slug, "identical titles must not collide");
  assert.equal(a.slug.slice(-6), a._id.toString().slice(-6));
  assert.equal(b.slug.slice(-6), b._id.toString().slice(-6));
  assert.match(a.slug, /^same-exact-title-[a-f\d]{6}$/);
});

// The cache middleware in index.js decides whether a path is a cacheable post
// from its shape alone. If a slug could look like one of these route names, an
// anonymous visitor's redirect-to-login would be cached and served as a post.
test("no sibling route under /blog can be mistaken for a slug", () => {
  for (const name of ["drafts", "add-new", "search", "featured", "trending", "preview", "api"]) {
    assert.equal(isSlugParam(name), false, `${name} must not look like a slug`);
  }
});

test("a 12-character slug is not mistaken for an ObjectId", () => {
  // mongoose's own ObjectId.isValid() returns true for any 12-char string,
  // which would send "weekly-notes" down the legacy-id branch.
  assert.equal(isObjectIdParam("weekly-notes"), false);
  assert.equal(isObjectIdParam("68f2a1b3c4d5e6f708192a3b"), true);
});

test("a title that slugifies to nothing still produces a usable URL", () => {
  assert.equal(slugifyTitle("!!!"), "");
  const slug = buildSlug("!!!", "68f2a1b3c4d5e6f708192a3b");
  assert.equal(slug, "post-192a3b");
  assert.ok(isSlugParam(slug), "the fallback must still match the cacheable shape");
});

// -------------------------------------------------------------- meta description

test("an authored meta description wins over the generated one", async () => {
  const authored = "The one sentence that actually earns the click.";
  const post = await makePost({
    title: "Described By Hand",
    metaDescription: authored,
  });

  const res = await request(ctx.app).get(`/blog/${post.slug}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(`content="${authored}"`), "the authored text should be the description");
});

test("with no meta description the opening of the body is still used", async () => {
  const post = await makePost({
    title: "Described By Fallback",
    body: "<p>Opening line that should end up in the meta description.</p>" + "<p>more</p>".repeat(40),
  });

  const res = await request(ctx.app).get(`/blog/${post.slug}`);
  assert.match(res.text, /content="Opening line that should end up/);
});

test("a meta description is stripped of markup and capped at 160 characters", async () => {
  const post = await makePost({
    title: "Overlong And Marked Up",
    metaDescription: "<b>Bold</b> start, then " + "x".repeat(300),
  });

  assert.equal(post.metaDescription.length, 160);
  assert.ok(!post.metaDescription.includes("<b>"), "markup must not survive into a meta attribute");
  assert.ok(post.metaDescription.startsWith("Bold start, then"));
});

// ------------------------------------------------------------- share screen

test("the share panel renders only when the publish redirect asked for it", async () => {
  const post = await makePost({ title: "Share Me Or Not" });

  const plain = await request(ctx.app).get(`/blog/${post.slug}`);
  assert.ok(!plain.text.includes("publish-share"), "an ordinary reader must not get the panel");
  assert.ok(!plain.text.includes("share-panel.js"), "nor pay for its assets");

  const published = await request(ctx.app).get(`/blog/${post.slug}?published=1`);
  assert.ok(published.text.includes('id="publish-share"'));
  assert.ok(published.text.includes("share-panel.js"));
});

test("the share panel is given an absolute URL, not a path", async () => {
  process.env.BASE_URL = "https://lumina.test";
  try {
    const post = await makePost({ title: "Absolute Share URL" });
    const res = await request(ctx.app).get(`/blog/${post.slug}?published=1`);
    assert.ok(
      res.text.includes(`data-url="https://lumina.test/blog/${post.slug}"`),
      "a relative path is useless once pasted elsewhere"
    );
  } finally {
    delete process.env.BASE_URL;
  }
});

// Publishing a draft from the edit route is the same moment as publishing a new
// post, so it must reach the same screen.
test("taking a draft live redirects to the share screen", async () => {
  const draft = await makePost({ title: "Draft Going Live", status: "draft" });
  await ageForEdit(draft);
  const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post(`/blog/edit/${draft._id}`)
    .set("Cookie", `${cookie}; ${csrfCookie}`)
    .type("form")
    .send({
      _csrf: token,
      action: "publish",
      title: "Draft Going Live",
      body: "<p>" + "word ".repeat(80) + "</p>",
      category: "Tech",
      tags: "one",
    });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/blog/${draft.slug}?published=1`);
});

test("an ordinary edit does not re-open the share screen", async () => {
  const post = await makePost({ title: "Just An Edit" });
  await ageForEdit(post);
  const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post(`/blog/edit/${post._id}`)
    .set("Cookie", `${cookie}; ${csrfCookie}`)
    .type("form")
    .send({
      _csrf: token,
      action: "publish",
      title: "Just An Edit, Retitled",
      body: "<p>" + "word ".repeat(80) + "</p>",
      category: "Tech",
      tags: "one",
    });

  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/blog/${post.slug}`);
});

// Editing the title must not move the post: the old URL is already shared.
test("an edit that changes the title leaves the permalink alone", async () => {
  const post = await makePost({ title: "Original Title Here" });
  await ageForEdit(post);
  const original = post.slug;
  const { token, cookie: csrfCookie } = await csrfFor(request, ctx.app);

  await request(ctx.app)
    .post(`/blog/edit/${post._id}`)
    .set("Cookie", `${cookie}; ${csrfCookie}`)
    .type("form")
    .send({
      _csrf: token,
      action: "publish",
      title: "A Totally Different Title",
      body: "<p>" + "word ".repeat(80) + "</p>",
      category: "Tech",
      tags: "one",
      metaDescription: "Set during the edit.",
    });

  const after = await ctx.Blog.findById(post._id);
  assert.equal(after.slug, original, "the permalink must survive a retitle");
  assert.equal(after.title, "A Totally Different Title");
  assert.equal(after.metaDescription, "Set during the edit.", "but the description is editable");

  // And the old URL still serves the post.
  const res = await request(ctx.app).get(`/blog/${original}`);
  assert.equal(res.status, 200);
});

// --------------------------------------------------------- private posts

// The slug contains the title, so redirecting an ObjectId URL for a private
// post would disclose it in the Location header to exactly the visitors the
// access check is meant to hide it from.
test("a private post's id URL does not redirect to its slug", async () => {
  const post = await makePost({
    title: "Confidential Internal Memo",
    status: "private",
  });

  const res = await request(ctx.app).get(`/blog/${post._id}`);
  assert.notEqual(res.status, 301, "a 301 would leak the title in Location");
  assert.equal(res.status, 404, "a stranger should not learn it exists");
  assert.ok(
    !JSON.stringify(res.headers).includes("confidential"),
    "no header may carry the title"
  );
});
