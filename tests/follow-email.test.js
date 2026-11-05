// Follow -> email on publish: who gets mailed, what the message carries, and
// the unsubscribe link that has to work from inside an inbox years later.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, csrfFor } = require("./helpers/app");

// Must be set before index.js (and with it services/emailService) is required,
// so the Resend path is the one under test rather than SMTP.
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.BASE_URL = "https://llumina.test";

const { tokenFor, verify, linkFor } = require("../utils/unsubscribe");

let ctx;

// Every Resend call made by the code under test, captured instead of sent.
let sent = [];
const realFetch = global.fetch;

test.before(async () => {
  ctx = await bootApp();
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "test-message-id" }),
        text: async () => "",
      };
    }
    return realFetch(url, init);
  };
});

test.after(async () => {
  global.fetch = realFetch;
  if (ctx) await ctx.stop();
});

// enqueue() runs the job inline but does NOT await it, so a publish responds
// before the fan-out has finished. Poll rather than sleep a fixed amount.
async function waitFor(label, check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const makeUser = (over = {}) =>
  ctx.User.create({
    fullName: "Follower",
    email: `f${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

// --- the token ---------------------------------------------------------------

test("an unsubscribe token verifies only for its own user and kind", async () => {
  const a = await makeUser();
  const b = await makeUser();

  assert.equal(verify(a._id, "new-post", tokenFor(a._id, "new-post")), true);
  assert.equal(verify(b._id, "new-post", tokenFor(a._id, "new-post")), false);
  assert.equal(verify(a._id, "other-kind", tokenFor(a._id, "new-post")), false);
  assert.equal(verify(a._id, "new-post", "0".repeat(32)), false);
  assert.equal(verify(a._id, "new-post", "short"), false);
  assert.equal(verify(a._id, "new-post", undefined), false);
});

test("the link it builds matches the route and the one-click CSRF exemption", async () => {
  const u = await makeUser();
  const link = linkFor(u._id, "new-post", "https://llumina.test/");
  const path = link.replace("https://llumina.test", "");

  assert.match(link, /^https:\/\/llumina\.test\/user\/unsubscribe\/new-post\/[a-f\d]{24}\/[a-f\d]{32}$/);
  // index.js exempts exactly this shape from CSRF for POST. If the two drift,
  // Gmail's one-click button starts returning 403.
  assert.match(path, /^\/user\/unsubscribe\/[a-z-]+\/[a-f\d]{24}\/[a-f\d]{32}$/i);
});

// --- the message -------------------------------------------------------------

test("the new-post email carries RFC 8058 one-click headers and escapes the title", async () => {
  sent = [];
  const { sendNewPostEmail } = require("../services/emailService");

  await sendNewPostEmail("reader@mail.test", {
    authorName: "Ada <script>alert(1)</script>",
    title: 'Why "quotes" & <b>tags</b> matter',
    excerpt: "An excerpt.",
    url: "https://llumina.test/blog/why-quotes-abc123",
    unsubscribeUrl: "https://llumina.test/user/unsubscribe/new-post/x/y",
  });

  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.deepEqual(msg.to, ["reader@mail.test"]);
  assert.equal(
    msg.headers["List-Unsubscribe"],
    "<https://llumina.test/user/unsubscribe/new-post/x/y>"
  );
  assert.equal(msg.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  // Author-supplied strings land in HTML; none of it may survive as markup.
  assert.ok(!msg.html.includes("<script>"), "script tag must be escaped");
  assert.ok(!msg.html.includes("<b>tags</b>"), "title markup must be escaped");
  assert.ok(msg.html.includes("https://llumina.test/blog/why-quotes-abc123"));
});

// --- who gets it -------------------------------------------------------------

test("publishing mails the followers who are verified and have not opted out", async () => {
  sent = [];

  const optedIn = await makeUser({ fullName: "Opted In" });
  const optedOut = await makeUser({
    fullName: "Opted Out",
    notificationPreferences: { emailOnNewPost: false },
  });
  const unverified = await makeUser({ fullName: "Unverified", isVerified: false });

  const author = await ctx.User.create({
    fullName: "Grace Hopper",
    email: "grace@mail.test",
    password: "a-long-enough-password",
    isVerified: true,
    followers: [optedIn._id, optedOut._id, unverified._id],
  });

  const post = await ctx.Blog.create({
    title: "Compilers, Briefly",
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
  });

  const { runJob } = require("../services/jobs");
  await runJob("fanout", { authorId: author._id, blogId: post._id, title: post.title });

  const addressed = sent.flatMap((m) => m.to).sort();
  assert.deepEqual(addressed, [optedIn.email], "only the opted-in, verified follower");

  // The in-app notification still goes to everyone, mail or no mail.
  const notified = await ctx.Notification.find({ blogId: post._id, type: "blog_upload" }).lean();
  const ids = notified.map((n) => String(n.userId)).sort();
  assert.deepEqual(
    ids,
    [author._id, optedIn._id, optedOut._id, unverified._id].map(String).sort()
  );

  // The mail points at the canonical slug, not the raw id.
  assert.ok(sent[0].html.includes(`/blog/${post.slug}`), "links to the slug URL");
  assert.match(sent[0].headers["List-Unsubscribe"], new RegExp(String(optedIn._id)));
});

test("a mail failure does not lose the in-app notifications", async () => {
  sent = [];
  const prev = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) });

  try {
    const follower = await makeUser({ fullName: "Still Notified" });
    const author = await ctx.User.create({
      fullName: "Katherine Johnson",
      email: "katherine@mail.test",
      password: "a-long-enough-password",
      isVerified: true,
      followers: [follower._id],
    });
    const post = await ctx.Blog.create({
      title: "Orbital Mechanics",
      body: "<p>" + "word ".repeat(80) + "</p>",
      category: "Tech",
      tags: ["one"],
      status: "published",
      createdBy: author._id,
      coverImageURL: "/images/default-avatar.png",
    });

    const { runJob } = require("../services/jobs");
    // Must not reject.
    await runJob("fanout", { authorId: author._id, blogId: post._id, title: post.title });

    const n = await ctx.Notification.countDocuments({ blogId: post._id, userId: follower._id });
    assert.equal(n, 1, "follower still got the in-app notification");
  } finally {
    global.fetch = prev;
  }
});

// --- the unsubscribe routes --------------------------------------------------

test("the footer link unsubscribes, and the undo link puts it back", async () => {
  const u = await makeUser();
  const path = `/user/unsubscribe/new-post/${u._id}/${tokenFor(u._id, "new-post")}`;

  const off = await request(ctx.app).get(path);
  assert.equal(off.status, 200);
  assert.match(off.text, /unsubscribed/i);
  let fresh = await ctx.User.findById(u._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewPost, false);

  // The undo offered on that page reuses the same token.
  assert.ok(off.text.includes(`${path}?resubscribe=1`), "undo link is on the page");
  const on = await request(ctx.app).get(`${path}?resubscribe=1`);
  assert.equal(on.status, 200);
  fresh = await ctx.User.findById(u._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewPost, true);
});

test("a tampered unsubscribe link changes nothing", async () => {
  const u = await makeUser();
  const bad = await request(ctx.app).get(`/user/unsubscribe/new-post/${u._id}/${"a".repeat(32)}`);
  assert.equal(bad.status, 400);

  const fresh = await ctx.User.findById(u._id).lean();
  assert.notEqual(fresh.notificationPreferences.emailOnNewPost, false);
});

test("an unknown kind is rejected rather than defaulted", async () => {
  const u = await makeUser();
  const res = await request(ctx.app).get(
    `/user/unsubscribe/everything/${u._id}/${tokenFor(u._id, "everything")}`
  );
  assert.equal(res.status, 400);
});

test("one-click POST works with no session and no CSRF token", async () => {
  const u = await makeUser();
  const res = await request(ctx.app)
    .post(`/user/unsubscribe/new-post/${u._id}/${tokenFor(u._id, "new-post")}`)
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send("List-Unsubscribe=One-Click");

  assert.equal(res.status, 200, "a mail provider sends no cookie and no CSRF token");
  assert.match(res.headers["content-type"], /text\/plain/);

  const fresh = await ctx.User.findById(u._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewPost, false);
});

test("one-click POST with a bad token is refused", async () => {
  const u = await makeUser();
  const res = await request(ctx.app)
    .post(`/user/unsubscribe/new-post/${u._id}/${"b".repeat(32)}`)
    .send("List-Unsubscribe=One-Click");

  assert.equal(res.status, 400);
  const fresh = await ctx.User.findById(u._id).lean();
  assert.notEqual(fresh.notificationPreferences.emailOnNewPost, false);
});

// --- the settings page ------------------------------------------------------

test("the preferences page is reachable and its toggle saves", async () => {
  const { authCookie } = require("./helpers/app");
  const u = await makeUser();
  const auth = authCookie(u);

  const page = await request(ctx.app).get("/user/email-preferences").set("Cookie", auth);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="emailOnNewPost" checked/);

  const { token, cookie } = await csrfFor(request, ctx.app);
  const save = await request(ctx.app)
    .post("/user/email-preferences")
    .set("Cookie", `${cookie}; ${auth}`)
    .set("x-csrf-token", token)
    .send({ emailOnNewPost: false });

  assert.equal(save.status, 200);
  assert.equal(save.body.emailOnNewPost, false);
  const fresh = await ctx.User.findById(u._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewPost, false);

  // And it is reflected when the page is loaded again.
  const again = await request(ctx.app).get("/user/email-preferences").set("Cookie", auth);
  assert.doesNotMatch(again.text, /id="emailOnNewPost" checked/);
});

test("the preferences page requires signing in", async () => {
  const res = await request(ctx.app).get("/user/email-preferences");
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/user/signin");
});

// --- every path to "published" ------------------------------------------------
//
// There were three copies of the fan-out and only one of them sent email, so
// each way of publishing is checked separately.

test("publishing a draft from the editor mails the followers too", async () => {
  sent = [];
  const { authCookie } = require("./helpers/app");

  const follower = await makeUser({ fullName: "Draft Follower" });
  const author = await ctx.User.create({
    fullName: "Barbara Liskov",
    email: "barbara@mail.test",
    password: "a-long-enough-password",
    isVerified: true,
    followers: [follower._id],
  });

  const draft = await ctx.Blog.create({
    title: "Abstraction, Eventually",
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "draft",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
  });

  // POST /blog/edit/:id refuses a second update within two minutes, and the
  // draft was created a moment ago.
  await ctx.Blog.updateOne(
    { _id: draft._id },
    { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } },
    { timestamps: false }
  );

  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app)
    .post(`/blog/edit/${draft._id}`)
    .set("Cookie", `${cookie}; ${authCookie(author)}`)
    .set("x-csrf-token", token)
    .send({
      title: draft.title,
      body: draft.body,
      category: "Tech",
      tags: "one",
      action: "publish",
      _csrf: token,
    });

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\?published=1$/);

  const fresh = await ctx.Blog.findById(draft._id).lean();
  assert.equal(fresh.status, "published");

  await waitFor("the fan-out to run", () =>
    ctx.Notification.countDocuments({ blogId: draft._id, userId: follower._id })
  );
  await waitFor("the follower email", () => sent.length > 0);
  assert.deepEqual(sent.flatMap((m) => m.to), [follower.email], "and the email");
});

test("a scheduled post reaching its time mails the followers too", async () => {
  sent = [];

  const follower = await makeUser({ fullName: "Scheduled Follower" });
  const author = await ctx.User.create({
    fullName: "Margaret Hamilton",
    email: "margaret@mail.test",
    password: "a-long-enough-password",
    isVerified: true,
    followers: [follower._id],
  });

  const post = await ctx.Blog.create({
    title: "Priority Displays, In Flight",
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "scheduled",
    publishAt: new Date(Date.now() - 60 * 1000),
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
  });

  const { publishDueScheduled } = require("../services/scheduler");
  assert.equal(await publishDueScheduled(null), 1);

  const notified = await ctx.Notification.countDocuments({
    blogId: post._id,
    userId: follower._id,
  });
  assert.equal(notified, 1, "follower got the in-app notification");
  assert.deepEqual(sent.flatMap((m) => m.to), [follower.email], "and the email");

  // Publishing twice must not mail twice.
  sent = [];
  assert.equal(await publishDueScheduled(null), 0);
  assert.equal(sent.length, 0, "idempotent: no second email");
});

test("the self notification still reads right for each way of publishing", async () => {
  const author = await ctx.User.create({
    fullName: "Radia Perlman",
    email: "radia@mail.test",
    password: "a-long-enough-password",
    isVerified: true,
  });
  const { runFanout } = require("../services/jobs");

  const cases = [
    [{}, /successfully uploaded/],
    [{ fromDraft: true }, /published your draft/],
    [{ scheduled: true }, /scheduled post is now live/],
  ];

  for (const [flags, expected] of cases) {
    const post = await ctx.Blog.create({
      title: "Spanning Tree",
      body: "<p>" + "word ".repeat(80) + "</p>",
      category: "Tech",
      tags: ["one"],
      status: "published",
      createdBy: author._id,
      coverImageURL: "/images/default-avatar.png",
    });
    await runFanout({ authorId: author._id, blogId: post._id, title: post.title, ...flags });

    const self = await ctx.Notification.findOne({ blogId: post._id, userId: author._id }).lean();
    assert.match(self.message, expected);
  }
});
