// Scheduled publishing. Up to three things can run this concurrently (the
// setInterval in index.js, the repeatable BullMQ job, and the
// /cron/publish-scheduled endpoint), so claiming a post must be atomic.
const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp } = require("./helpers/app");
const { publishDueScheduled } = require("../services/scheduler");

let ctx, author;

test.before(async () => {
  ctx = await bootApp();
  author = await ctx.User.create({
    fullName: "Scheduler Author",
    email: "scheduler@example.com",
    password: "password123",
    isVerified: true,
  });
});

test.after(async () => { if (ctx) await ctx.stop(); });

test.beforeEach(async () => {
  await ctx.Blog.deleteMany({});
  await ctx.Notification.deleteMany({});
});

test("a post whose publishAt has passed gets published", async () => {
  const blog = await ctx.Blog.create({
    title: "Due Post",
    body: "<p>body</p>",
    createdBy: author._id,
    status: "scheduled",
    publishAt: new Date(Date.now() - 60_000),
  });

  assert.equal(await publishDueScheduled(null), 1);

  const fresh = await ctx.Blog.findById(blog._id);
  assert.equal(fresh.status, "published");
  assert.equal(fresh.publishAt, undefined, "publishAt should be cleared");
});

test("a post scheduled for the future is left alone", async () => {
  const blog = await ctx.Blog.create({
    title: "Future Post",
    body: "<p>body</p>",
    createdBy: author._id,
    status: "scheduled",
    publishAt: new Date(Date.now() + 60 * 60_000),
  });

  assert.equal(await publishDueScheduled(null), 0);
  assert.equal((await ctx.Blog.findById(blog._id)).status, "scheduled");
});

test("concurrent runs publish a due post exactly once", async () => {
  // Regression test for the read-then-write race: two runners both loaded the
  // same scheduled post and both published it, so every follower got duplicate
  // notifications.
  const follower = await ctx.User.create({
    fullName: "Follower",
    email: `follower-${Date.now()}@example.com`,
    password: "password123",
    isVerified: true,
  });
  await ctx.User.updateOne({ _id: author._id }, { $addToSet: { followers: follower._id } });

  const blog = await ctx.Blog.create({
    title: "Contested Post",
    body: "<p>body</p>",
    createdBy: author._id,
    status: "scheduled",
    publishAt: new Date(Date.now() - 60_000),
  });

  const results = await Promise.all([
    publishDueScheduled(null),
    publishDueScheduled(null),
    publishDueScheduled(null),
  ]);

  const totalPublished = results.reduce((a, b) => a + b, 0);
  assert.equal(totalPublished, 1, `exactly one runner should claim it, got ${results.join(",")}`);

  assert.equal((await ctx.Blog.findById(blog._id)).status, "published");

  const followerNotes = await ctx.Notification.countDocuments({ userId: follower._id, blogId: blog._id });
  assert.equal(followerNotes, 1, "the follower must not be notified twice");

  const authorNotes = await ctx.Notification.countDocuments({ userId: author._id, blogId: blog._id });
  assert.equal(authorNotes, 1, "the author must not be notified twice");

  await ctx.User.updateOne({ _id: author._id }, { $pull: { followers: follower._id } });
});

test("a second pass over an already-published post does nothing", async () => {
  await ctx.Blog.create({
    title: "Already Live",
    body: "<p>body</p>",
    createdBy: author._id,
    status: "scheduled",
    publishAt: new Date(Date.now() - 60_000),
  });

  assert.equal(await publishDueScheduled(null), 1);
  assert.equal(await publishDueScheduled(null), 0, "idempotent on a second run");
});
