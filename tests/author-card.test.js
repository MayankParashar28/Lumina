// The author card under each post, and the Follow a signed-out reader presses.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

let ctx;
let seq = 0;

test.before(async () => { ctx = await bootApp(); });
test.after(async () => { if (ctx) await ctx.stop(); });

const makeUser = (over = {}) =>
  ctx.User.create({
    fullName: `Writer ${++seq}`,
    email: `w${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

const makePost = (author, over = {}) =>
  ctx.Blog.create({
    title: `Post ${++seq}`,
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

test("a signed-out reader sees the author card and a Follow that goes somewhere", async () => {
  const author = await makeUser({ fullName: "Toni Morrison", bio: "I write at dawn." });
  const post = await makePost(author);

  const res = await request(ctx.app).get(`/blog/${post.slug}`);
  assert.equal(res.status, 200);

  assert.match(res.text, /class="author-card"/, "the card renders");
  assert.ok(res.text.includes("Toni Morrison"), "names the author");
  assert.ok(res.text.includes("I write at dawn."), "shows the bio");
  assert.match(res.text, /0 followers/);

  // The important part: signed out, the button exists and carries the intent.
  assert.ok(
    res.text.includes(`/user/signin?follow=${author._id}&amp;next=${encodeURIComponent("/blog/" + post.slug)}`),
    "Follow carries both the author and where to come back to"
  );
});

test("the card lists the author's other posts, newest first, excluding this one", async () => {
  const author = await makeUser();
  const older = await makePost(author, { title: "The Older One" });
  const newer = await makePost(author, { title: "The Newer One" });
  const current = await makePost(author, { title: "The Current One" });

  // createdAt is set on insert; space them out so the sort is unambiguous.
  await ctx.Blog.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } });
  await ctx.Blog.updateOne({ _id: newer._id }, { $set: { createdAt: new Date(Date.now() - 1 * 864e5) } });

  const res = await request(ctx.app).get(`/blog/${current.slug}`);
  const card = res.text.slice(res.text.indexOf('class="author-card"'));

  assert.ok(card.includes("The Newer One"), "lists another post");
  assert.ok(card.includes("The Older One"), "lists another post");
  assert.ok(!card.includes("The Current One"), "but not the post being read");
  assert.ok(
    card.indexOf("The Newer One") < card.indexOf("The Older One"),
    "newest first"
  );
});

test("a draft by the author is not advertised on the card", async () => {
  const author = await makeUser();
  await makePost(author, { title: "A Secret Draft", status: "draft" });
  const current = await makePost(author);

  const res = await request(ctx.app).get(`/blog/${current.slug}`);
  assert.ok(!res.text.includes("A Secret Draft"), "drafts stay private");
});

test("the author sees their own profile link, not a Follow button", async () => {
  const author = await makeUser();
  const post = await makePost(author);

  const res = await request(ctx.app)
    .get(`/blog/${post.slug}`)
    .set("Cookie", authCookie(author));

  const card = res.text.slice(res.text.indexOf('class="author-card"'));
  assert.ok(card.includes("Your profile"), "no inviting yourself to follow yourself");
  assert.ok(!card.includes(`/user/follow/${author._id}`));
});

test("a signed-in reader who already follows sees Following", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const post = await makePost(author);

  await ctx.User.updateOne({ _id: author._id }, { $addToSet: { followers: reader._id } });
  await ctx.User.updateOne({ _id: reader._id }, { $addToSet: { following: author._id } });

  const res = await request(ctx.app).get(`/blog/${post.slug}`).set("Cookie", authCookie(reader));
  const card = res.text.slice(res.text.indexOf('class="author-card"'));
  assert.match(card, /Following/);
  assert.match(res.text, /1 follower[^s]/, "singular for one");
});

// --- the intent -----------------------------------------------------------------

// The password sign-in form is CAPTCHA-protected and the answer lives in the
// session, so these drive the intent through the sign-up verification link —
// which is the path a signed-out reader actually takes: press Follow, make an
// account, click the link in the email.
async function pendingReader(email) {
  const { hashPassword } = require("../services/password");
  const { salt, hash } = await hashPassword("a-long-enough-password");
  const token = `tok${++seq}${Math.random().toString(36).slice(2)}`;
  await ctx.mongoose.model("pendingUser").create({
    fullName: "New Reader",
    email,
    password: hash,
    salt,
    verificationToken: token,
    verificationTokenExpires: new Date(Date.now() + 864e5),
    profilePic: "/images/default-avatar.png",
  });
  return token;
}

test("the follow a signed-out reader pressed completes when they sign up", async () => {
  const author = await makeUser();
  const post = await makePost(author);
  const agent = request.agent(ctx.app);

  // 1. They press Follow under the post and land on sign-up, which remembers why.
  const page = await agent.get(
    `/user/signup?follow=${author._id}&next=${encodeURIComponent("/blog/" + post.slug)}`
  );
  assert.equal(page.status, 200);
  assert.ok(
    (page.headers["set-cookie"] || []).some((c) => c.startsWith("follow_intent=")),
    "the intent is remembered"
  );

  // 2. They make an account and click the link in the email.
  const token = await pendingReader(`new-${seq}@mail.test`);
  const verified = await agent.get(`/user/verify/${token}`);

  // 3. The follow happened, and they land back on the post they were reading.
  assert.equal(verified.status, 302);
  assert.equal(verified.headers.location, `/blog/${post.slug}`, "returned to where they were");

  const fresh = await ctx.User.findById(author._id).lean();
  assert.equal(fresh.followers.length, 1, "the follow they asked for actually happened");
});

test("the intent cannot be used to redirect off the site", async () => {
  const author = await makeUser();
  const agent = request.agent(ctx.app);

  // "//evil.example" is protocol-relative: a browser treats it as absolute.
  await agent.get(
    `/user/signup?follow=${author._id}&next=${encodeURIComponent("//evil.example/phish")}`
  );
  const token = await pendingReader(`evil-${seq}@mail.test`);
  const verified = await agent.get(`/user/verify/${token}`);

  assert.equal(verified.headers.location, "/", "falls back to the home page");

  // The follow still went through; only the destination was refused.
  const fresh = await ctx.User.findById(author._id).lean();
  assert.equal(fresh.followers.length, 1);
});

test("a junk follow intent is ignored rather than breaking the sign-up", async () => {
  const agent = request.agent(ctx.app);

  const page = await agent.get("/user/signup?follow=not-an-id&next=/");
  assert.ok(
    !(page.headers["set-cookie"] || []).some((c) => c.startsWith("follow_intent=")),
    "nothing is remembered for a malformed id"
  );

  const token = await pendingReader(`junk-${seq}@mail.test`);
  const verified = await agent.get(`/user/verify/${token}`);
  assert.equal(verified.status, 302, "they still get their account");
  assert.equal(verified.headers.location, "/");
});

test("following is idempotent — a replayed intent does not double-count", async () => {
  const author = await makeUser();
  const reader = await makeUser();

  const { token, cookie } = await csrfFor(request, ctx.app);
  for (let i = 0; i < 2; i += 1) {
    await request(ctx.app)
      .post(`/user/follow/${author._id}`)
      .set("Cookie", `${cookie}; ${authCookie(reader)}`)
      .set("x-csrf-token", token)
      .send({ _csrf: token });
  }

  // Two presses is a follow then an unfollow, so the count is what matters:
  // it must never be two of the same person.
  const fresh = await ctx.User.findById(author._id).lean();
  const mine = fresh.followers.filter((f) => String(f) === String(reader._id));
  assert.ok(mine.length <= 1, "never counted twice");
});
