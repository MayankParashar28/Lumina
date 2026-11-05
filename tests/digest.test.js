// The weekly digest: who is due one, what it counts, and when it stays quiet.
const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp } = require("./helpers/app");

process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.BASE_URL = "https://llumina.test";

let ctx;
let sent = [];
let seq = 0;
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

const { sendDueDigests } = require("../services/digest");

const makeAuthor = (over = {}) =>
  ctx.User.create({
    fullName: `Author ${++seq}`,
    email: `d${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

const makePost = (author, over = {}) =>
  ctx.Blog.create({
    title: `Post ${++seq}`,
    body: "<p>" + "word ".repeat(40) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "published",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

const lastWeek = () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const mineOnly = (author) => sent.filter((m) => m.to[0] === author.email);

test("a brand-new author is not sent last year's numbers as this week's", async () => {
  sent = [];
  const author = await makeAuthor();
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 900 } });

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 0, "the first pass only sets the watermark");

  const fresh = await ctx.User.findById(author._id).lean();
  assert.ok(fresh.lastDigestAt, "but it is now recorded");
  const p = await ctx.Blog.findById(post._id).lean();
  assert.equal(p.viewsAtLastDigest, 900, "and the post's watermark is the count so far");
});

test("a week later it reports only what happened since", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const quiet = await makePost(author, { title: "The Quiet One" });
  const busy = await makePost(author, { title: "The Busy One" });

  // 900 views already counted last week; 12 more since.
  await ctx.Blog.updateOne({ _id: busy._id }, { $set: { views: 912, viewsAtLastDigest: 900 } });
  await ctx.Blog.updateOne({ _id: quiet._id }, { $set: { views: 5, viewsAtLastDigest: 5 } });

  await sendDueDigests();

  const mine = mineOnly(author);
  assert.equal(mine.length, 1);
  assert.match(mine[0].subject, /12 reads/, "12, not 917");
  assert.ok(mine[0].html.includes("The Busy One"));
  assert.ok(!mine[0].html.includes("The Quiet One"), "a post nobody read is not listed");
  assert.equal(mine[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");

  // Watermarks move, so next week starts from here.
  const p = await ctx.Blog.findById(busy._id).lean();
  assert.equal(p.viewsAtLastDigest, 912);
});

test("comments and new followers since the last one are counted", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 3 } });

  const reader = await makeAuthor();
  await ctx.Comment.create({ content: "Recent", blogId: post._id, createdBy: reader._id });
  const old = await ctx.Comment.create({ content: "Ancient", blogId: post._id, createdBy: reader._id });
  // Through the driver, not the model: with `timestamps: true` Mongoose marks
  // createdAt immutable and silently drops a $set on it.
  await ctx.mongoose.connection.db
    .collection("comments")
    .updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - 30 * 864e5) } });

  await ctx.Notification.create({
    userId: author._id, senderId: reader._id, type: "follow",
    message: "x", read: false, createdAt: new Date(),
  });

  await sendDueDigests();
  const mine = mineOnly(author);
  assert.equal(mine.length, 1);
  // One recent comment, not two; one new follower.
  const stats = mine[0].html.slice(mine[0].html.indexOf('class="stats"'));
  const nums = [...stats.matchAll(/<span class="stat-n">(\d+)<\/span>\s*<span class="stat-l">([a-z ]+)</g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(nums.slice(0, 3), ["3 reads", "1 comment", "1 new follower"]);

});

test("a week with nothing in it sends no email", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 7, viewsAtLastDigest: 7 } });

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 0, "\"0 reads this week\" helps nobody");

  // The watermark still moved, so a quiet week is not added onto the next one.
  const fresh = await ctx.User.findById(author._id).lean();
  assert.ok(Date.now() - new Date(fresh.lastDigestAt) < 60 * 1000);
});

test("it does not send twice in the same week", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 40 } });

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 1);

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 1, "the second sweep finds nobody due");
});

test("two sweeps at once still send one email", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 40 } });

  await Promise.all([sendDueDigests(), sendDueDigests(), sendDueDigests()]);
  assert.equal(mineOnly(author).length, 1, "the watermark is claimed before anything is sent");
});

test("an author who switched the digest off is not sent one", async () => {
  sent = [];
  const author = await makeAuthor({
    lastDigestAt: lastWeek(),
    notificationPreferences: { emailOnWeeklyDigest: false },
  });
  const post = await makePost(author);
  await ctx.Blog.updateOne({ _id: post._id }, { $set: { views: 40 } });

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 0);
});

test("someone who has never published gets nothing", async () => {
  sent = [];
  const reader = await makeAuthor({ lastDigestAt: lastWeek() });
  await sendDueDigests();
  assert.equal(mineOnly(reader).length, 0, "no posts, no week to report");
});

test("a draft is not counted as published work", async () => {
  sent = [];
  const author = await makeAuthor({ lastDigestAt: lastWeek() });
  const draft = await makePost(author, { status: "draft", title: "Still Cooking" });
  await ctx.Blog.updateOne({ _id: draft._id }, { $set: { views: 999 } });

  await sendDueDigests();
  assert.equal(mineOnly(author).length, 0);
});
