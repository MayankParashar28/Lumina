// Follow, like and bookmark are clicked from buttons that update instantly and
// call these routes with fetch, so each must answer JSON (no page reload) and
// toggle with a single atomic update.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

let ctx;
let seq = 0;

test.before(async () => { ctx = await bootApp(); });
test.after(async () => { if (ctx) await ctx.stop(); });

const makeUser = () =>
  ctx.User.create({
    fullName: `Clicker ${++seq}`,
    email: `c${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
  });

const makePost = (author) =>
  ctx.Blog.create({
    title: `Post ${++seq}`,
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    status: "published",
    createdBy: author._id,
  });

const post = async (path, user) => {
  const { token, cookie } = await csrfFor(request, ctx.app);
  return request(ctx.app)
    .post(path)
    .set("Cookie", `${cookie}; ${authCookie(user)}`)
    .set("Accept", "application/json")
    .set("x-csrf-token", token)
    .send({ _csrf: token });
};

test("follow answers JSON and toggles both sides", async () => {
  const author = await makeUser();
  const reader = await makeUser();

  const on = await post(`/user/follow/${author._id}`, reader);
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { success: true, following: true, followerCount: 1 });
  let [a, r] = await Promise.all([
    ctx.User.findById(author._id).lean(),
    ctx.User.findById(reader._id).lean(),
  ]);
  assert.deepEqual(a.followers.map(String), [String(reader._id)]);
  assert.deepEqual(r.following.map(String), [String(author._id)]);
  assert.equal(await ctx.Notification.countDocuments({ userId: author._id, type: "follow" }), 1);

  const off = await post(`/user/follow/${author._id}`, reader);
  assert.deepEqual(off.body, { success: true, following: false, followerCount: 0 });
  [a, r] = await Promise.all([
    ctx.User.findById(author._id).lean(),
    ctx.User.findById(reader._id).lean(),
  ]);
  assert.equal(a.followers.length, 0);
  assert.equal(r.following.length, 0);
  assert.equal(await ctx.Notification.countDocuments({ userId: author._id, type: "follow" }), 0);
});

test("follow without JavaScript still redirects back", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app)
    .post(`/user/follow/${author._id}`)
    .set("Cookie", `${cookie}; ${authCookie(reader)}`)
    .set("Referer", `/user/profile/${author._id}`)
    .type("form")
    .send({ _csrf: token });
  assert.equal(res.status, 302);
});

test("following yourself or nobody is refused", async () => {
  const reader = await makeUser();
  assert.equal((await post(`/user/follow/${reader._id}`, reader)).status, 400);
  assert.equal((await post(`/user/follow/${"f".repeat(24)}`, reader)).status, 404);
  assert.equal((await post(`/user/follow/not-an-id`, reader)).status, 404);
});

test("like toggles atomically and keeps the count in step", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const blog = await makePost(author);

  const on = await post(`/blog/like/${blog._id}`, reader);
  assert.deepEqual(on.body, { success: true, liked: true, likes: 1 });

  const off = await post(`/blog/like/${blog._id}`, reader);
  assert.deepEqual(off.body, { success: true, liked: false, likes: 0 });

  // Two rapid likes from two people must both land.
  const other = await makeUser();
  await Promise.all([post(`/blog/like/${blog._id}`, reader), post(`/blog/like/${blog._id}`, other)]);
  const fresh = await ctx.Blog.findById(blog._id).lean();
  assert.equal(fresh.likes, 2);
  assert.equal(fresh.likedBy.length, 2);

  assert.equal((await post(`/blog/like/${"f".repeat(24)}`, reader)).status, 404);
});

test("bookmark toggles", async () => {
  const author = await makeUser();
  const reader = await makeUser();
  const blog = await makePost(author);

  assert.deepEqual((await post(`/blog/bookmark/${blog._id}`, reader)).body, { success: true, bookmarked: true });
  assert.deepEqual((await post(`/blog/bookmark/${blog._id}`, reader)).body, { success: true, bookmarked: false });
  const r = await ctx.User.findById(reader._id).lean();
  assert.equal(r.bookmarks.length, 0);
});
