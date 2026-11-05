// Comment, reply and follow emails: the notification preferences that existed
// in the user model for months without anything reading them.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.BASE_URL = "https://llumina.test";

const { tokenFor } = require("../utils/unsubscribe");

let ctx;
let sent = [];
const realFetch = global.fetch;

test.before(async () => {
  ctx = await bootApp();
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ id: "x" }), text: async () => "" };
    }
    return realFetch(url, init);
  };
});

test.after(async () => {
  global.fetch = realFetch;
  if (ctx) await ctx.stop();
});

let seq = 0;
const makeUser = (over = {}) =>
  ctx.User.create({
    fullName: `Person ${++seq}`,
    email: `p${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

const makePost = (author, over = {}) =>
  ctx.Blog.create({
    title: "A Post Worth Commenting On",
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

// The routes fire these without awaiting, so the response can beat the send.
async function waitFor(label, check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Nothing should have been sent — but absence needs a moment to be meaningful,
// since the send is fire-and-forget.
async function expectNoEmail(why) {
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(sent.length, 0, why);
}

async function postComment(post, commenter, content) {
  const { token, cookie } = await csrfFor(request, ctx.app);
  return request(ctx.app)
    .post(`/blog/comment/${post._id}`)
    .set("Cookie", `${cookie}; ${authCookie(commenter)}`)
    .set("x-csrf-token", token)
    .send({ content, _csrf: token });
}

// --- comments -----------------------------------------------------------------

test("commenting on someone's post emails the author", async () => {
  sent = [];
  const author = await makeUser();
  const commenter = await makeUser({ fullName: "Grace" });
  const post = await makePost(author);

  await postComment(post, commenter, "This made me think. Thank you.");

  await waitFor("the comment email", () => sent.length > 0);
  assert.deepEqual(sent[0].to, [author.email]);
  assert.match(sent[0].subject, /Grace commented on/);
  assert.ok(sent[0].html.includes("This made me think."), "quotes the comment");
  assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  // The link must be the canonical slug and point at the comment itself.
  assert.match(sent[0].html, new RegExp(`/blog/${post.slug}#comment-`));
});

test("commenting on your own post emails nobody", async () => {
  sent = [];
  const author = await makeUser();
  const post = await makePost(author);

  await postComment(post, author, "A note to myself.");
  await expectNoEmail("an author must not be mailed about their own comment");

  // The comment itself still saved.
  assert.equal(await ctx.Comment.countDocuments({ blogId: post._id }), 1);
});

test("an author who switched comment emails off still gets the notification", async () => {
  sent = [];
  const author = await makeUser({
    notificationPreferences: { emailOnComment: false },
  });
  const commenter = await makeUser();
  const post = await makePost(author);

  await postComment(post, commenter, "Hello there.");

  await waitFor("the in-app notification", () =>
    ctx.Notification.countDocuments({ userId: author._id, type: "comment" })
  );
  await expectNoEmail("opted out of comment email");
});

test("an unverified author is not emailed", async () => {
  sent = [];
  const author = await makeUser({ isVerified: false });
  const commenter = await makeUser();
  const post = await makePost(author);

  await postComment(post, commenter, "Hello again.");
  await expectNoEmail("an unverified address was never confirmed");
});

// --- replies ------------------------------------------------------------------

test("replying to a comment emails whoever wrote it", async () => {
  sent = [];
  const author = await makeUser();
  const commenter = await makeUser({ fullName: "Ada" });
  const replier = await makeUser({ fullName: "Alan" });
  const post = await makePost(author);

  await postComment(post, commenter, "The second half lost me.");
  await waitFor("the comment email", () => sent.length > 0);
  const parent = await ctx.Comment.findOne({ blogId: post._id, createdBy: commenter._id });

  sent = [];
  const { token, cookie } = await csrfFor(request, ctx.app);
  await request(ctx.app)
    .post(`/blog/comment/${parent._id}/reply`)
    .set("Cookie", `${cookie}; ${authCookie(replier)}`)
    .set("x-csrf-token", token)
    .send({ content: "Try the appendix, it helped me.", _csrf: token });

  await waitFor("the reply email", () => sent.length > 0);
  assert.deepEqual(sent[0].to, [commenter.email], "the parent comment's author");
  assert.match(sent[0].subject, /Alan replied to your comment/);
  assert.ok(sent[0].html.includes("Try the appendix"));
});

// --- follows ------------------------------------------------------------------

test("following someone emails them", async () => {
  sent = [];
  const followed = await makeUser();
  const follower = await makeUser({ fullName: "Radia", bio: "I think about loops." });

  const { token, cookie } = await csrfFor(request, ctx.app);
  await request(ctx.app)
    .post(`/user/follow/${followed._id}`)
    .set("Cookie", `${cookie}; ${authCookie(follower)}`)
    .set("x-csrf-token", token)
    .send({ _csrf: token });

  await waitFor("the follow email", () => sent.length > 0);
  assert.deepEqual(sent[0].to, [followed.email]);
  assert.match(sent[0].subject, /Radia started following you/);
  assert.ok(sent[0].html.includes("I think about loops."), "shows their bio");
  assert.match(sent[0].html, new RegExp(`/user/profile/${follower._id}`));

  const fresh = await ctx.User.findById(followed._id).lean();
  assert.equal(fresh.followers.length, 1, "and the follow actually happened");
});

test("someone who switched follow emails off is not emailed", async () => {
  sent = [];
  const followed = await makeUser({ notificationPreferences: { emailOnFollow: false } });
  const follower = await makeUser();

  const { token, cookie } = await csrfFor(request, ctx.app);
  await request(ctx.app)
    .post(`/user/follow/${followed._id}`)
    .set("Cookie", `${cookie}; ${authCookie(follower)}`)
    .set("x-csrf-token", token)
    .send({ _csrf: token });

  await waitFor("the follow to land", async () => {
    const u = await ctx.User.findById(followed._id).lean();
    return u.followers.length === 1;
  });
  await expectNoEmail("opted out of follow email");
});

// --- the settings these all read ----------------------------------------------

test("the preferences page offers all three switches", async () => {
  const u = await makeUser();
  const res = await request(ctx.app)
    .get("/user/email-preferences")
    .set("Cookie", authCookie(u));

  assert.equal(res.status, 200);
  for (const key of ["emailOnNewPost", "emailOnComment", "emailOnFollow"]) {
    assert.match(res.text, new RegExp(`data-pref="${key}"`), `${key} switch is on the page`);
  }
});

test("saving one switch does not clobber the others", async () => {
  const u = await makeUser({
    notificationPreferences: { emailOnNewPost: false, emailOnComment: true, emailOnFollow: true },
  });
  const { token, cookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post("/user/email-preferences")
    .set("Cookie", `${cookie}; ${authCookie(u)}`)
    .set("x-csrf-token", token)
    .send({ emailOnComment: false });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.prefs, {
    emailOnNewPost: false,
    emailOnComment: false,
    emailOnFollow: true,
  });

  const fresh = await ctx.User.findById(u._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewPost, false, "untouched switch kept");
  assert.equal(fresh.notificationPreferences.emailOnFollow, true, "untouched switch kept");
});

test("a body with no known preference is refused rather than silently ignored", async () => {
  const u = await makeUser();
  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app)
    .post("/user/email-preferences")
    .set("Cookie", `${cookie}; ${authCookie(u)}`)
    .set("x-csrf-token", token)
    .send({ emailOnSomethingElse: true });

  assert.equal(res.status, 400);
});

// --- unsubscribing from the new kinds ------------------------------------------

test("each kind has its own unsubscribe link, and they do not cross over", async () => {
  const u = await makeUser();

  for (const [kind, field] of [["comment", "emailOnComment"], ["follow", "emailOnFollow"]]) {
    const res = await request(ctx.app).get(
      `/user/unsubscribe/${kind}/${u._id}/${tokenFor(u._id, kind)}`
    );
    assert.equal(res.status, 200, `${kind} unsubscribe works`);

    const fresh = await ctx.User.findById(u._id).lean();
    assert.equal(fresh.notificationPreferences[field], false, `${kind} switched off`);
    assert.notEqual(
      fresh.notificationPreferences.emailOnNewPost,
      false,
      "unsubscribing from one kind must not touch another"
    );
  }
});

test("a comment token cannot unsubscribe from follow emails", async () => {
  const u = await makeUser();
  const res = await request(ctx.app).get(
    `/user/unsubscribe/follow/${u._id}/${tokenFor(u._id, "comment")}`
  );
  assert.equal(res.status, 400);

  const fresh = await ctx.User.findById(u._id).lean();
  assert.notEqual(fresh.notificationPreferences.emailOnFollow, false);
});
