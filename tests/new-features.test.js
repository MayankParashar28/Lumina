// Following feed, highlights, @mentions + inbox filter, newsletter, version
// history, the public author API and the PWA files.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

// Before index.js loads, so mail goes through the (stubbed) Resend path.
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.BASE_URL = "https://llumina.test";

let ctx;
let Highlight, Newsletter, BlogRevision;
let sent = [];
const realFetch = global.fetch;
let seq = 0;

test.before(async () => {
  ctx = await bootApp();
  Highlight = require("../models/highlight");
  Newsletter = require("../models/newsletter");
  BlogRevision = require("../models/blogRevision");
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
    fullName: `Person ${++seq}`,
    email: `p${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
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

const follow = (follower, author) =>
  Promise.all([
    ctx.User.updateOne({ _id: follower._id }, { $addToSet: { following: author._id } }),
    ctx.User.updateOne({ _id: author._id }, { $addToSet: { followers: follower._id } }),
  ]);

// A request as `user`, with a CSRF token for writes.
async function as(user, method, path, body) {
  const { token, cookie } = await csrfFor(request, ctx.app);
  let req = request(ctx.app)[method](path)
    .set("Cookie", user ? `${cookie}; ${authCookie(user)}` : cookie)
    .set("Accept", "application/json")
    .set("x-csrf-token", token);
  if (body !== undefined) req = req.send(body);
  return req;
}

const page = (user, path) =>
  request(ctx.app).get(path).set("Cookie", user ? authCookie(user) : "");

// Just the feed grid of the home page — the featured/trending rails around it
// can list any post.
const feedGrid = (html) => {
  const start = html.indexOf('id="bento-grid"');
  const end = html.indexOf('id="pagination-skeleton"');
  assert.ok(start !== -1 && end > start, "the feed grid is on the page");
  return html.slice(start, end);
};

// --- Following feed ----------------------------------------------------------

test("the following feed shows only people you follow, newest first", async () => {
  const reader = await makeUser();
  const followed = await makeUser();
  const stranger = await makeUser();
  await follow(reader, followed);
  const older = await makePost(followed, { title: "Followed Older" });
  await new Promise((r) => setTimeout(r, 10));
  const newer = await makePost(followed, { title: "Followed Newer" });
  await makePost(stranger, { title: "Stranger Post" });

  const html = await page(reader, "/?category=following");
  assert.equal(html.status, 200);
  const grid = feedGrid(html.text);
  assert.ok(grid.includes("Followed Newer"));
  assert.ok(grid.includes("Followed Older"));
  assert.ok(!grid.includes("Stranger Post"), "nobody you don't follow");
  assert.ok(grid.indexOf("Followed Newer") < grid.indexOf("Followed Older"), "newest first");
  assert.match(html.text, /data-category="following"/, "the chip is there");

  const api = await page(reader, "/blog/api/feed?page=1&category=following");
  assert.equal(api.status, 200);
  assert.deepEqual(api.body.blogs.map((b) => b.title), [newer.title, older.title]);
});

test("the following feed is never shared between readers, and needs a sign-in", async () => {
  const a = await makeUser();
  const b = await makeUser();
  const writerA = await makeUser();
  await follow(a, writerA);
  await makePost(writerA, { title: "Only For A" });

  const first = await page(a, "/blog/api/feed?page=1&category=following");
  assert.ok(first.body.blogs.some((x) => x.title === "Only For A"));
  const second = await page(b, "/blog/api/feed?page=1&category=following");
  assert.equal(second.body.blogs.length, 0, "B follows nobody — not A's cached page");

  const anon = await request(ctx.app).get("/blog/api/feed?page=1&category=following");
  assert.equal(anon.status, 401);
});

test("following nobody gets an explanation, not an empty grid", async () => {
  const loner = await makeUser();
  const res = await page(loner, "/?category=following");
  assert.match(feedGrid(res.text), /not following anyone yet/);
});

// --- Highlights --------------------------------------------------------------

test("highlights: create, list, note, delete — and only for their owner", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const other = await makeUser();
  const post = await makePost(author, { title: "Highlightable" });

  const created = await as(reader, "post", "/highlights", {
    blogId: String(post._id),
    text: "word word word",
    prefix: "word ",
    suffix: " word",
    note: "remember this",
  });
  assert.equal(created.status, 201);
  const id = created.body.highlight._id;

  const mine = await as(reader, "get", `/highlights/blog/${post._id}`);
  assert.equal(mine.body.highlights.length, 1);
  assert.equal(mine.body.highlights[0].note, "remember this");

  const theirs = await as(other, "get", `/highlights/blog/${post._id}`);
  assert.equal(theirs.body.highlights.length, 0, "private to the reader");
  assert.equal((await as(other, "patch", `/highlights/${id}`, { note: "hijack" })).status, 404);
  assert.equal((await as(other, "delete", `/highlights/${id}`)).status, 404);

  const edited = await as(reader, "patch", `/highlights/${id}`, { note: "changed" });
  assert.equal(edited.body.highlight.note, "changed");

  const listPage = await page(reader, "/highlights");
  assert.equal(listPage.status, 200);
  assert.ok(listPage.text.includes("Highlightable"));
  assert.ok(listPage.text.includes(`#hl-${id}`), "links straight to the passage");

  assert.equal((await as(reader, "delete", `/highlights/${id}`)).status, 200);
  assert.equal(await Highlight.countDocuments({ _id: id }), 0);
});

test("highlights: signed out is refused; someone else's draft can't be highlighted", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const draft = await makePost(author, { status: "draft" });

  const anon = await as(null, "post", "/highlights", { blogId: String(draft._id), text: "word" });
  assert.equal(anon.status, 401);

  const res = await as(reader, "post", "/highlights", { blogId: String(draft._id), text: "word" });
  assert.equal(res.status, 404);

  const empty = await as(reader, "post", "/highlights", { blogId: String(draft._id), text: "   " });
  assert.equal(empty.status, 400);
});

// --- @mentions and the conversations inbox -------------------------------------

test("the mention list is the post's author and commenters, minus yourself", async () => {
  const author = await makeUser({ fullName: "Mary-Jane O'Neil" });
  const commenter = await makeUser({ fullName: "Alan Turing" });
  const me = await makeUser({ fullName: "Grace Hopper" });
  const post = await makePost(author);
  await ctx.Comment.create({ content: "hi", blogId: post._id, createdBy: commenter._id });
  await ctx.Comment.create({ content: "me too", blogId: post._id, createdBy: me._id });

  const res = await as(me, "get", `/blog/api/mentions/${post._id}`);
  const handles = res.body.people.map((p) => p.handle).sort();
  assert.deepEqual(handles, ["AlanTuring", "MaryJaneONeil"]);
  assert.ok(res.body.people.find((p) => p.handle === "MaryJaneONeil").isAuthor);

  assert.equal((await request(ctx.app).get(`/blog/api/mentions/${post._id}`)).status, 401);
});

test("a punctuated name can be mentioned by its handle, and the alert links to the comment", async () => {
  const author = await makeUser({ fullName: "Mary-Jane O'Neil" });
  const commenter = await makeUser({ fullName: "Edsger Dijkstra" });
  const post = await makePost(author);

  await as(commenter, "post", `/blog/comment/${post._id}`, { content: "Great point @MaryJaneONeil, agreed." });

  const note = await waitFor("the mention notification", () =>
    ctx.Notification.findOne({ userId: author._id, type: "mention" }).lean()
  );
  assert.match(note.targetUrl, new RegExp(`^/blog/${post._id}#comment-[a-f\\d]{24}$`));
});

test("Mentions & replies shows conversation notifications only", async () => {
  const me = await makeUser();
  const them = await makeUser();
  await ctx.Notification.create([
    { userId: me._id, senderId: them._id, type: "mention", message: "MENTION-MSG" },
    { userId: me._id, senderId: them._id, type: "reply", message: "REPLY-MSG" },
    { userId: me._id, senderId: them._id, type: "like", message: "LIKE-MSG" },
    { userId: me._id, senderId: them._id, type: "follow", message: "FOLLOW-MSG" },
  ]);

  const all = await page(me, "/notifications");
  for (const m of ["MENTION-MSG", "REPLY-MSG", "LIKE-MSG", "FOLLOW-MSG"]) assert.ok(all.text.includes(m), m);

  const convo = await page(me, "/notifications?filter=conversations");
  assert.ok(convo.text.includes("MENTION-MSG"));
  assert.ok(convo.text.includes("REPLY-MSG"));
  assert.ok(!convo.text.includes("LIKE-MSG"));
  assert.ok(!convo.text.includes("FOLLOW-MSG"));
  assert.match(convo.text, /is-active"\s+aria-current="page">Mentions &amp; replies/, "the tab shows as current");
});

// --- Newsletter --------------------------------------------------------------

test("a newsletter reaches verified followers who haven't opted out, once a week at most", async () => {
  sent = [];
  const author = await makeUser({ fullName: "Octavia Butler" });
  const fan = await makeUser();
  const unverified = await makeUser({ isVerified: false });
  const optedOut = await makeUser({ notificationPreferences: { emailOnNewsletter: false } });
  for (const f of [fan, unverified, optedOut]) await follow(f, author);

  const pageRes = await page(author, "/user/newsletter");
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Send to 1 follower\b/);

  const res = await as(author, "post", "/user/newsletter", {
    subject: "What I'm writing next",
    body: "Hello readers. Here is a long enough note about the next book.\n\nSecond paragraph https://example.com/x.",
    action: "send",
  });
  assert.equal(res.status, 302);

  await waitFor("the newsletter email", () => sent.length > 0);
  await waitFor("the note to be marked sent", () =>
    Newsletter.findOne({ authorId: author._id, status: "sent" }).lean()
  );
  assert.equal(sent.length, 1, "only the verified, opted-in follower");
  assert.deepEqual(sent[0].to, [fan.email]);
  assert.match(sent[0].subject, /Octavia Butler: What I'm writing next/);
  assert.match(sent[0].html, /\/user\/unsubscribe\/newsletter\//);
  assert.equal(sent[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  const note = await Newsletter.findOne({ authorId: author._id }).lean();
  assert.equal(note.recipientCount, 1);
  assert.equal(note.sentCount, 1);

  sent = [];
  const again = await as(author, "post", "/user/newsletter", {
    subject: "Another",
    body: "Trying to send a second note in the same week, which is not allowed.",
    action: "send",
  });
  assert.equal(again.status, 429);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.length, 0);
  assert.equal(await Newsletter.countDocuments({ authorId: author._id }), 1);
});

test("a newsletter test goes only to the author and is not recorded", async () => {
  sent = [];
  const author = await makeUser();
  const fan = await makeUser();
  await follow(fan, author);

  const res = await as(author, "post", "/user/newsletter", {
    subject: "Test subject",
    body: "This is only a test of how the note will look in an inbox.",
    action: "test",
  });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, [author.email]);
  assert.equal(await Newsletter.countDocuments({ authorId: author._id }), 0);
});

test("the newsletter unsubscribe link switches off only newsletters", async () => {
  const { linkFor } = require("../utils/unsubscribe");
  const reader = await makeUser();
  const link = linkFor(reader._id, "newsletter", "");
  const res = await request(ctx.app).post(link);
  assert.equal(res.status, 200);
  const fresh = await ctx.User.findById(reader._id).lean();
  assert.equal(fresh.notificationPreferences.emailOnNewsletter, false);
  assert.notEqual(fresh.notificationPreferences.emailOnNewPost, false);

  const prefs = await page(reader, "/user/email-preferences");
  assert.match(prefs.text, /data-pref="emailOnNewsletter"/);
});

// --- Version history ---------------------------------------------------------

test("autosave records versions without touching the post", async () => {
  const author = await makeUser();
  const post = await makePost(author, { title: "Original Title" });
  const before = await ctx.Blog.findById(post._id).lean();

  const r1 = await as(author, "post", `/blog/edit/${post._id}/autosave`, { title: "Draft A", body: "<p>first try</p>" });
  assert.equal(r1.status, 200);
  const r2 = await as(author, "post", `/blog/edit/${post._id}/autosave`, { title: "Draft B", body: "<p>second try</p>" });
  assert.equal(r2.body.revision._id, r1.body.revision._id, "consecutive autosaves coalesce");

  const after = await ctx.Blog.findById(post._id).lean();
  assert.equal(after.title, "Original Title", "the live post is unchanged");
  assert.equal(String(after.updatedAt), String(before.updatedAt), "and its edit cooldown untouched");

  const list = await as(author, "get", `/blog/edit/${post._id}/revisions`);
  assert.deepEqual(list.body.revisions.map((r) => r.kind), ["autosave", "original"]);
  const original = list.body.revisions[1];
  const one = await as(author, "get", `/blog/edit/${post._id}/revisions/${original._id}`);
  assert.equal(one.body.revision.title, "Original Title");

  const xss = await as(author, "post", `/blog/edit/${post._id}/autosave`, {
    title: "x", body: "<p>ok</p><script>alert(1)</script>", kind: "restore",
  });
  const stored = await BlogRevision.findById(xss.body.revision._id).lean();
  assert.ok(!/script/i.test(stored.body), "versions are sanitised like posts");
});

test("only the author can see or write a post's versions", async () => {
  const author = await makeUser();
  const intruder = await makeUser();
  const post = await makePost(author);
  assert.equal((await as(intruder, "post", `/blog/edit/${post._id}/autosave`, { title: "x", body: "y" })).status, 403);
  assert.equal((await as(intruder, "get", `/blog/edit/${post._id}/revisions`)).status, 403);
  assert.equal((await as(null, "get", `/blog/edit/${post._id}/revisions`)).status, 401);
});

test("a real save keeps the pre-edit text as the original version", async () => {
  const author = await makeUser();
  const post = await makePost(author, { title: "Before Edit" });
  // Past the 2-minute edit cooldown.
  await ctx.Blog.collection.updateOne({ _id: post._id }, { $set: { updatedAt: new Date(Date.now() - 3600e3) } });

  const res = await as(author, "post", `/blog/edit/${post._id}`, {
    title: "After Edit",
    body: "<p>" + "fresh ".repeat(60) + "</p>",
    category: "Tech",
    action: "publish",
  });
  assert.equal(res.status, 302);

  const versions = await waitFor("the saved version", async () => {
    const v = await BlogRevision.find({ blogId: post._id }).sort({ _id: 1 }).lean();
    return v.length >= 2 ? v : null;
  });
  assert.equal(versions[0].kind, "original");
  assert.equal(versions[0].title, "Before Edit");
  assert.equal(versions[1].kind, "saved");
  assert.equal(versions[1].title, "After Edit");
});

// --- Public author API -------------------------------------------------------

test("the author API is public, cross-origin, and shows only published posts", async () => {
  const author = await makeUser({ fullName: "Ursula Le Guin", bio: "Writer." });
  await makePost(author, { title: "Published One", metaDescription: "A short summary." });
  await makePost(author, { title: "Secret Draft", status: "draft" });

  const res = await request(ctx.app)
    .get(`/api/author/${author._id}/latest.json?limit=50`)
    .set("Origin", "https://someone-elses-site.example");
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.equal(res.headers["set-cookie"], undefined, "no session for API callers");
  assert.equal(res.body.author.name, "Ursula Le Guin");
  assert.deepEqual(res.body.posts.map((p) => p.title), ["Published One"]);
  assert.equal(res.body.posts[0].excerpt, "A short summary.");
  assert.match(res.body.posts[0].url, /^https:\/\/llumina\.test\/blog\//);
  assert.equal(res.body.author.email, undefined, "nothing private");

  assert.equal((await request(ctx.app).get(`/api/author/${"f".repeat(24)}/latest.json`)).status, 404);
  assert.equal((await request(ctx.app).get("/api/author/nope/latest.json")).status, 404);
});

test("the embed script can be loaded by other sites", async () => {
  const res = await request(ctx.app).get("/embed/author.js");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin");
});

// --- PWA ---------------------------------------------------------------------

test("the app is installable: manifest, service worker, offline page", async () => {
  const manifest = await request(ctx.app).get("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers["content-type"], /application\/manifest\+json/);
  assert.equal(manifest.headers["cache-control"], "no-cache");
  const parsed = JSON.parse(manifest.text);
  assert.equal(parsed.display, "standalone");
  assert.ok(parsed.icons.some((i) => i.sizes === "512x512"));

  const sw = await request(ctx.app).get("/sw.js");
  assert.equal(sw.status, 200);
  assert.equal(sw.headers["cache-control"], "no-cache", "updates must reach installed apps");

  assert.equal((await request(ctx.app).get("/offline.html")).status, 200);

  const home = await request(ctx.app).get("/about");
  assert.match(home.text, /<link rel="manifest" href="\/manifest.webmanifest">/);
});
