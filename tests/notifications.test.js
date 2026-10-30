// Notification endpoints: the removed open-write route, and ownership checks.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

let ctx, alice, bob, aliceNote;

test.before(async () => {
  ctx = await bootApp();
  alice = await ctx.User.create({ fullName: "Alice A", email: "alice@example.com", password: "password123", isVerified: true });
  bob = await ctx.User.create({ fullName: "Bob B", email: "bob@example.com", password: "password123", isVerified: true });
  aliceNote = await ctx.Notification.create({
    userId: alice._id,
    senderId: bob._id,
    type: "follow",
    message: "Bob B started following you.",
    read: false,
  });
});

test.after(async () => {
  if (ctx) await ctx.stop();
});

test("the unauthenticated notification-create endpoint no longer exists", async () => {
  // It accepted a userId and message straight from the body with no auth check,
  // which would have let anyone write arbitrary notifications into any feed.
  const { token, cookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post("/notifications/create")
    .set("Cookie", cookie)
    .type("form")
    .send({ _csrf: token, userId: alice._id.toString(), message: "Your account is suspended, verify at evil.example" });

  assert.equal(res.status, 404, "route should be gone");
  assert.equal(
    await ctx.Notification.countDocuments({ userId: alice._id }),
    1,
    "nothing should have been injected into the feed"
  );
});

test("notification routes require authentication", async () => {
  const feed = await request(ctx.app).get("/notifications");
  assert.equal(feed.status, 401);

  const count = await request(ctx.app).get("/notifications/unread-count");
  assert.equal(count.body.count, 0);

  const { token, cookie } = await csrfFor(request, ctx.app);
  const markAll = await request(ctx.app)
    .post("/notifications/mark-all-read")
    .set("Cookie", cookie)
    .type("form")
    .send({ _csrf: token });
  assert.equal(markAll.status, 401);
});

test("a user cannot mark someone else's notification as read", async () => {
  const { token, cookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post(`/notifications/mark-read/${aliceNote._id}`)
    .set("Cookie", [cookie, authCookie(bob)].join("; "))
    .type("form")
    .send({ _csrf: token });

  assert.equal(res.status, 404, "Bob must not touch Alice's notification");

  const fresh = await ctx.Notification.findById(aliceNote._id);
  assert.equal(fresh.read, false, "it should still be unread");
});

test("a user can mark their own notification as read", async () => {
  const { token, cookie } = await csrfFor(request, ctx.app);

  const res = await request(ctx.app)
    .post(`/notifications/mark-read/${aliceNote._id}`)
    .set("Cookie", [cookie, authCookie(alice)].join("; "))
    .type("form")
    .send({ _csrf: token });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.count, 0, "no unread left");

  const fresh = await ctx.Notification.findById(aliceNote._id);
  assert.equal(fresh.read, true);
});

test("a malformed notification id is rejected", async () => {
  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app)
    .post("/notifications/mark-read/not-an-id")
    .set("Cookie", [cookie, authCookie(alice)].join("; "))
    .type("form")
    .send({ _csrf: token });
  assert.equal(res.status, 400);
});
