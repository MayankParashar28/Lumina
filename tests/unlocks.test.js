// Feature unlocks end to end: the menu, unlocking, notifications, permanence,
// grandfathering and admin grants.
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
    fullName: `Member ${++seq}`,
    email: `u${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
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

const menuOf = async (user) => {
  const res = await request(ctx.app).get("/about").set("Cookie", authCookie(user));
  const start = res.text.indexOf('class="dropdown-menu-custom"');
  // The menu runs from its container to the Log out link at the bottom.
  const end = res.text.indexOf("</a>", res.text.indexOf("am-foot__link--out", start));
  return res.text.slice(start, end);
};

// Stats are cached for two minutes; tests change data directly, so clear it.
const bust = (user) => require("../services/unlocks").bust(user._id);

test("a new member's menu: basics, a checklist and the next locks — nothing empty", async () => {
  const fresh = await makeUser();
  const menu = await menuOf(fresh);
  for (const label of ["Write a story", "Bookmarks", "View profile", "Settings", "Log out", "Getting started", "Unlock more"]) {
    assert.ok(menu.includes(label), `shows ${label}`);
  }
  for (const label of [">My Drafts", ">Highlights", ">Recently Read", ">Your Vibe", ">Analytics", ">Email Followers"]) {
    assert.ok(!menu.includes(label), `hides ${label}`);
  }
});

test("locked pages say what unlocks them, and the server enforces it", async () => {
  const fresh = await makeUser();
  const page = await request(ctx.app).get("/user/analytics").set("Cookie", authCookie(fresh));
  assert.equal(page.status, 403);
  assert.match(page.text, /Analytics isn't unlocked yet/);
  assert.match(page.text, /Publish your first post/);

  const { token, cookie } = await csrfFor(request, ctx.app);
  const ai = await request(ctx.app)
    .post("/ai/generate-title")
    .set("Cookie", `${cookie}; ${authCookie(fresh)}`)
    .set("x-csrf-token", token)
    .set("Accept", "application/json")
    .send({ body: "some text" });
  assert.equal(ai.status, 403);
  assert.equal(ai.body.locked, true);
});

test("publishing a first post unlocks analytics, with one notification", async () => {
  const writer = await makeUser();
  await menuOf(writer); // first visit: initialised with nothing earned
  await makePost(writer);
  bust(writer);

  const menu = await menuOf(writer);
  assert.ok(menu.includes(">Analytics"));
  assert.match(menu, /<span>Analytics<\/span>\s*<span class="am-new">New<\/span>/);
  assert.equal((await request(ctx.app).get("/user/analytics").set("Cookie", authCookie(writer))).status, 200);

  bust(writer);
  await menuOf(writer); // a second look must not notify twice
  const notes = await ctx.Notification.find({ userId: writer._id, type: "unlock" }).lean();
  const analytics = notes.filter((n) => /Analytics/.test(n.message));
  assert.equal(analytics.length, 1);
  assert.equal(analytics[0].targetUrl, "/user/analytics");
});

test("existing members keep what they already use, without a notification", async () => {
  const veteran = await makeUser({ lastAiRequest: new Date(Date.now() - 864e5), isVerified: true });
  await menuOf(veteran);
  const fresh = await ctx.User.findById(veteran._id).lean();
  assert.ok(fresh.unlocks.some((u) => u.key === "ai"), "AI grandfathered in");
  assert.equal(await ctx.Notification.countDocuments({ userId: veteran._id, type: "unlock" }), 0);
});

test("unlocks are permanent", async () => {
  const author = await makeUser({ unlocks: [{ key: "newsletter", at: new Date() }], unlocksInitializedAt: new Date() });
  // No followers, no posts — but it was earned before.
  assert.notEqual((await request(ctx.app).get("/user/newsletter").set("Cookie", authCookie(author))).status, 403);
});

test("admins can unlock everything for a member, and take it back", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const member = await makeUser();
  const { token, cookie } = await csrfFor(request, ctx.app);
  const grant = await request(ctx.app)
    .post(`/admin/user/unlocks/${member._id}`)
    .set("Cookie", `${cookie}; ${authCookie(admin)}`)
    .type("form")
    .send({ _csrf: token });
  assert.equal(grant.status, 302);
  assert.ok((await ctx.User.findById(member._id).lean()).featureGrants.includes("newsletter"));
  assert.notEqual((await request(ctx.app).get("/user/newsletter").set("Cookie", authCookie(member))).status, 403);

  await request(ctx.app)
    .post(`/admin/user/unlocks/${member._id}`)
    .set("Cookie", `${cookie}; ${authCookie(admin)}`)
    .type("form")
    .send({ _csrf: token });
  assert.deepEqual((await ctx.User.findById(member._id).lean()).featureGrants, []);
});

test("the progress page lists every earned feature with what's left", async () => {
  const member = await makeUser();
  const res = await request(ctx.app).get("/user/unlocks").set("Cookie", authCookie(member));
  assert.equal(res.status, 200);
  for (const label of ["Analytics", "Email Followers", "Best time to publish", "AI writing helpers"]) {
    assert.ok(res.text.includes(label), label);
  }
  assert.match(res.text, /0 \/ 10/, "follower progress for email");
});
