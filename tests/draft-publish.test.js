// Taking a draft live, and the preview that has to work before you do.
//
// Both of these were reported as broken by hand: the drafts list offered no way
// to publish (only "Click to Edit", and the editor's own button said "Update"),
// and Preview failed on anything longer than a short post.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

process.env.RESEND_API_KEY = "re_test_not_a_real_key";
process.env.BASE_URL = "https://llumina.test";

let ctx;
let seq = 0;
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

// enqueue() runs the job inline but without awaiting it, so the redirect beats
// the fan-out. Poll rather than sleep.
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
    fullName: `Writer ${++seq}`,
    email: `d${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

const makeDraft = (author, over = {}) =>
  ctx.Blog.create({
    title: `Draft ${++seq}`,
    body: "<p>" + "word ".repeat(80) + "</p>",
    category: "Tech",
    tags: ["one"],
    status: "draft",
    createdBy: author._id,
    coverImageURL: "/images/default-avatar.png",
    ...over,
  });

const post = async (path, user, fields = {}) => {
  const { token, cookie } = await csrfFor(request, ctx.app);
  return request(ctx.app)
    .post(path)
    .set("Cookie", `${cookie}; ${authCookie(user)}`)
    .type("form")
    .send({ _csrf: token, ...fields });
};

// --- the drafts list ---------------------------------------------------------

test("the drafts list offers a Publish button, not just a link to the editor", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);

  const res = await request(ctx.app)
    .get("/blog/drafts")
    .set("Cookie", authCookie(author));

  assert.equal(res.status, 200);
  assert.ok(
    res.text.includes(`action="/blog/publish/${draft._id}" method="POST"`),
    "a real form posting to the publish route"
  );
  assert.match(res.text, /name="_csrf"/, "with a CSRF token, or it would 403");
  // The form must not be nested inside the card's link, or the click navigates
  // to the editor instead of submitting.
  const cardLink = res.text.indexOf(`href="/blog/edit/${draft._id}" class="blog-card-link"`);
  const closeAnchor = res.text.indexOf("</a>", cardLink);
  const form = res.text.indexOf(`action="/blog/publish/${draft._id}"`);
  assert.ok(cardLink > -1 && form > closeAnchor, "the form sits after the card link closes");
});

test("a scheduled post is offered as 'Publish now'", async () => {
  const author = await makeUser();
  await makeDraft(author, { status: "scheduled", publishAt: new Date(Date.now() + 864e5) });

  const res = await request(ctx.app)
    .get("/blog/drafts")
    .set("Cookie", authCookie(author));
  assert.match(res.text, /Publish now/);
});

// --- publishing --------------------------------------------------------------

test("publishing a draft takes it live and bumps it to the top of the feed", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);
  const wasCreated = new Date(draft.createdAt);
  await ctx.Blog.updateOne({ _id: draft._id }, { $set: { createdAt: new Date(Date.now() - 30 * 864e5) } });

  const res = await post(`/blog/publish/${draft._id}`, author);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, `/blog/${draft.slug}?published=1`, "lands on the share screen");

  const live = await ctx.Blog.findById(draft._id).lean();
  assert.equal(live.status, "published");
  assert.ok(new Date(live.createdAt) > wasCreated, "dated now, not when the draft was started");

  // And it is actually readable by a stranger.
  const page = await request(ctx.app).get(`/blog/${draft.slug}`);
  assert.equal(page.status, 200);
});

test("publishing a scheduled post clears the pending schedule", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author, {
    status: "scheduled",
    publishAt: new Date(Date.now() + 864e5),
  });

  await post(`/blog/publish/${draft._id}`, author);

  const live = await ctx.Blog.findById(draft._id).lean();
  assert.equal(live.status, "published");
  assert.ok(!live.publishAt, "the scheduler has nothing left to do with it");
});

test("followers are notified and emailed, exactly as they are for a normal publish", async () => {
  sent = [];
  const author = await makeUser();
  const follower = await makeUser();
  await ctx.User.updateOne({ _id: author._id }, { $push: { followers: follower._id } });
  await ctx.User.updateOne({ _id: follower._id }, { $push: { following: author._id } });

  const draft = await makeDraft(author, { title: "Out Of The Drawer" });
  await post(`/blog/publish/${draft._id}`, author);

  const notif = await waitFor("the follower's notification", () =>
    ctx.Notification.findOne({ userId: follower._id, blogId: draft._id }).lean()
  );
  assert.match(notif.message, /published/, "worded as a publish, not an upload");

  const mail = await waitFor("the follower's email", () =>
    sent.find((m) => m.to[0] === follower.email)
  );
  assert.ok(mail.html.includes("Out Of The Drawer"));
  assert.ok(mail.headers["List-Unsubscribe"], "bulk mail needs the one-click header");
});

test("the author is told it worked, once", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);
  await post(`/blog/publish/${draft._id}`, author);

  const mine = await waitFor("the author's own notification", async () => {
    const all = await ctx.Notification.find({ userId: author._id, blogId: draft._id }).lean();
    return all.length ? all : null;
  });
  assert.equal(mine.length, 1, "one confirmation, not one per code path");
  assert.match(mine[0].message, /published your draft/i);
});

test("a second press does not publish, or notify, twice", async () => {
  sent = [];
  const author = await makeUser();
  const follower = await makeUser();
  await ctx.User.updateOne({ _id: author._id }, { $push: { followers: follower._id } });
  const draft = await makeDraft(author);

  await post(`/blog/publish/${draft._id}`, author);
  await waitFor("the first fan-out", () =>
    ctx.Notification.findOne({ userId: follower._id, blogId: draft._id }).lean()
  );

  const again = await post(`/blog/publish/${draft._id}`, author);
  assert.equal(again.status, 302);
  assert.equal(again.headers.location, `/blog/${draft.slug}`, "no second share screen");

  // Give a (wrongly) queued second fan-out time to land before counting.
  await new Promise((r) => setTimeout(r, 300));
  const notifs = await ctx.Notification.find({ userId: follower._id, blogId: draft._id }).lean();
  assert.equal(notifs.length, 1);
  assert.equal(sent.filter((m) => m.to[0] === follower.email).length, 1);
});

test("someone else cannot publish your draft", async () => {
  const author = await makeUser();
  const stranger = await makeUser();
  const draft = await makeDraft(author);

  const res = await post(`/blog/publish/${draft._id}`, stranger);
  assert.equal(res.status, 302, "redirected back with a flash, not a stack trace");

  const still = await ctx.Blog.findById(draft._id).lean();
  assert.equal(still.status, "draft", "and it is still a draft");
});

test("signed out, publishing is refused", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);

  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app)
    .post(`/blog/publish/${draft._id}`)
    .set("Cookie", cookie)
    .type("form")
    .send({ _csrf: token });
  assert.equal(res.status, 302);

  const still = await ctx.Blog.findById(draft._id).lean();
  assert.equal(still.status, "draft");
});

test("a junk id is a miss, not a crash", async () => {
  const author = await makeUser();
  for (const id of ["not-an-id", "0".repeat(24), "abcdefghijkl"]) {
    const res = await post(`/blog/publish/${id}`, author);
    assert.ok(res.status === 302 || res.status === 404, `${id} -> ${res.status}`);
  }
});

// --- the editor's own button -------------------------------------------------

test("the editor says Publish for a draft and Update for a live post", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);
  const live = await makeDraft(author, { status: "published" });

  const onDraft = await request(ctx.app)
    .get(`/blog/edit/${draft._id}`)
    .set("Cookie", authCookie(author));
  assert.equal(onDraft.status, 200);
  assert.match(onDraft.text, /value="publish"[\s\S]{0,200}?Publish\s*</, "the submit button says Publish");
  assert.match(onDraft.text, /id="btn-confirm-publish"[\s\S]{0,200}?Publish now/, "and so does the sheet");

  const onLive = await request(ctx.app)
    .get(`/blog/edit/${live._id}`)
    .set("Cookie", authCookie(author));
  assert.match(onLive.text, /value="publish"[\s\S]{0,200}?Update\s*</);
  assert.match(onLive.text, /id="btn-confirm-publish"[\s\S]{0,200}?Update now/);
});

// --- the editor after the fields moved into the publish sheet ----------------

// Both editors are behind cooldowns keyed off the author's last post (30 minutes
// to start a new one, 2 minutes between edits). Mongoose manages createdAt and
// updatedAt under `timestamps: true` and silently drops a $set on either, so the
// raw driver is the only way to move them.
const backdate = (id, ms) =>
  ctx.mongoose.connection.db.collection("blogs").updateOne(
    { _id: id },
    { $set: { createdAt: new Date(Date.now() - ms), updatedAt: new Date(Date.now() - ms) } }
  );

const between = (html, startNeedle, endNeedle) => {
  const a = html.indexOf(startNeedle);
  const b = html.indexOf(endNeedle, a);
  assert.ok(a > -1 && b > a, `could not find ${startNeedle} ... ${endNeedle}`);
  return html.slice(a, b);
};

test("every field the route reads is still inside the form", async () => {
  // Category, tags and the search fields now live in a modal. A modal rendered
  // outside <form> looks identical and silently posts none of them, so this is
  // the invariant that has to hold -- on both editors.
  const author = await makeUser();
  const draft = await makeDraft(author);
  await backdate(draft._id, 2 * 3600e3);

  const pages = [
    ["new story", await request(ctx.app).get("/blog/add-new").set("Cookie", authCookie(author))],
    ["edit", await request(ctx.app).get(`/blog/edit/${draft._id}`).set("Cookie", authCookie(author))],
  ];

  for (const [label, res] of pages) {
    assert.equal(res.status, 200, label);
    const form = between(res.text, 'id="publishForm"', "</form>");
    for (const field of ['name="title"', 'name="body"', 'name="category"', 'name="tags"',
                         'name="metaDescription"', 'name="coverImage"']) {
      assert.ok(form.includes(field), `${label}: ${field} is outside the form`);
    }
  }
});

test("the writing page itself asks for nothing but a cover, a title and a story", async () => {
  const author = await makeUser();
  const res = await request(ctx.app).get("/blog/add-new").set("Cookie", authCookie(author));

  const page = between(res.text, 'id="publishForm"', 'id="checklist-modal"');
  assert.ok(!page.includes('name="category"'), "category is asked when you publish, not while writing");
  assert.ok(!page.includes('name="tags"'), "so are tags");
  assert.ok(!page.includes('name="metaDescription"'), "and the search fields");
  assert.ok(!/class="section-label"/.test(page), "no heading over every field");

  const sheet = between(res.text, 'id="checklist-modal"', "</form>");
  assert.ok(sheet.includes('name="category"') && sheet.includes('name="tags"'), "they are in the sheet");
});

test("publishing a draft from the editor needs action=publish, and sends it", async () => {
  const author = await makeUser();
  const draft = await makeDraft(author);
  await backdate(draft._id, 864e5);

  const body = "<p>" + "word ".repeat(80) + "</p>";
  const fields = { title: draft.title, body, category: "Technology", tags: "one, two" };

  // Without it the route takes neither branch and the draft stays a draft. This
  // is what the editor's Publish button did for months: form.submit() does not
  // carry the clicked button's name/value.
  const silent = await post(`/blog/edit/${draft._id}`, author, fields);
  assert.equal(silent.status, 302);
  assert.equal((await ctx.Blog.findById(draft._id).lean()).status, "draft");

  await backdate(draft._id, 864e5);
  const explicit = await post(`/blog/edit/${draft._id}`, author, { ...fields, action: "publish" });
  assert.equal(explicit.status, 302);
  assert.match(explicit.headers.location, /\?published=1$/);
  assert.equal((await ctx.Blog.findById(draft._id).lean()).status, "published");

  // And the editor does send it.
  const fresh = await makeUser();
  const page = await request(ctx.app).get("/blog/add-new").set("Cookie", authCookie(fresh));
  assert.match(page.text, /setAction\(form, 'publish'\)/, "submitFinal sets the action");
});

// --- preview -----------------------------------------------------------------

test("preview accepts a full-length story, which used to 500", async () => {
  const author = await makeUser();
  // ~120KB of body: comfortably over express's old 100kb default, which made
  // the preview POST fail with a 500 for any real article.
  const body = "<p>" + "word ".repeat(24000) + "</p>";
  assert.ok(Buffer.byteLength(body) > 100 * 1024, "the payload is the point of this test");

  const res = await post("/blog/preview", author, {
    title: "A Long One",
    body,
    from: "new",
  });
  assert.equal(res.status, 303, "a redirect to the preview page, not an error");
  assert.equal(res.headers.location, "/blog/preview");
});

test("preview survives a body with a base64 cover attached", async () => {
  const author = await makeUser();
  const cover = "data:image/png;base64," + "A".repeat(900 * 1024);

  const res = await post("/blog/preview", author, {
    title: "With A Cover",
    body: "<p>" + "word ".repeat(2000) + "</p>",
    coverImage: cover,
    from: "new",
  });
  assert.equal(res.status, 303);
});

test("something far too large is turned away cleanly, not as a 500", async () => {
  const author = await makeUser();
  const body = "<p>" + "word ".repeat(1_200_000) + "</p>"; // ~6MB, over the 3mb limit

  const res = await post("/blog/preview", author, { title: "Too Much", body, from: "new" });
  assert.equal(res.status, 413, "the author is told it is too big");
});

test("the preview the author then reads back is the story they typed", async () => {
  const author = await makeUser();
  const { token, cookie } = await csrfFor(request, ctx.app);
  const agentCookie = `${cookie}; ${authCookie(author)}`;

  const body = "<p>" + "unmistakable ".repeat(60) + "</p>";
  const saved = await request(ctx.app)
    .post("/blog/preview")
    .set("Cookie", agentCookie)
    .type("form")
    .send({ _csrf: token, title: "Read Me Back", body, from: "new" });
  assert.equal(saved.status, 303);

  // The session cookie set on the POST carries the stashed preview.
  const jar = (saved.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const page = await request(ctx.app)
    .get("/blog/preview")
    .set("Cookie", `${jar || cookie}; ${authCookie(author)}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Read Me Back"));
  assert.ok(page.text.includes("unmistakable"));
});
