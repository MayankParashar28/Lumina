// /earn — the Creator Rewards waitlist.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, authCookie, csrfFor } = require("./helpers/app");

let ctx;
let EarnWaitlist, EarnVisit;
let seq = 0;

test.before(async () => {
  ctx = await bootApp();
  ({ EarnWaitlist, EarnVisit } = require("../models/earnWaitlist"));
});
test.after(async () => { if (ctx) await ctx.stop(); });

const makeUser = (over = {}) =>
  ctx.User.create({
    fullName: `Earner ${++seq}`,
    email: `e${seq}-${Math.random().toString(36).slice(2)}@mail.test`,
    password: "a-long-enough-password",
    isVerified: true,
    ...over,
  });

// A browser-like agent so the earn_token / earn_ref cookies carry over.
async function agentWithCsrf() {
  const agent = request.agent(ctx.app);
  const page = await agent.get("/earn");
  const token = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  return { agent, token, page };
}

test("the page explains the program without promising money", async () => {
  const res = await request(ctx.app).get("/earn");
  assert.equal(res.status, 200);
  assert.match(res.text, /Write\. Share\. Get rewarded\./);
  assert.match(res.text, /may include credits/);
  assert.ok(!/₹\s?\d/.test(res.text), "no rupee amounts promised");
});

test("a visitor joins by email, gets a spot and an invite link, and can answer the survey", async () => {
  const { agent, token } = await agentWithCsrf();
  const join = await agent.post("/earn/join").type("form").send({ _csrf: token, email: "Visitor.One+x@gmail.com", src: "home" });
  assert.equal(join.status, 302);
  const entry = await EarnWaitlist.findOne({ email: "visitorone@gmail.com" }).lean();
  assert.ok(entry, "stored with the normalised email");
  assert.equal(entry.source, "home");

  const page = await agent.get("/earn");
  assert.match(page.text, /You're #\d+ in line/);
  assert.ok(page.text.includes(`/earn?ref=${entry.refCode}`));

  const survey = await agent.post("/earn/survey").type("form").send({ _csrf: token, motivation: "readers", frequency: "weekly", invites: "bogus" });
  assert.equal(survey.status, 302);
  const after = await EarnWaitlist.findById(entry._id).lean();
  assert.equal(after.survey.motivation, "readers");
  assert.equal(after.survey.frequency, "weekly");
  assert.equal(after.survey.invites, null, "unknown answers are ignored");

  const again = await agent.post("/earn/join").type("form").send({ _csrf: token, email: "visitorone@gmail.com" });
  assert.equal(again.status, 302);
  assert.equal(await EarnWaitlist.countDocuments({ email: "visitorone@gmail.com" }), 1, "one spot per inbox");
});

test("throwaway and invalid emails can't join", async () => {
  const { agent, token } = await agentWithCsrf();
  await agent.post("/earn/join").type("form").send({ _csrf: token, email: "x@mailinator.com" });
  await agent.post("/earn/join").type("form").send({ _csrf: token, email: "not-an-email" });
  assert.equal(await EarnWaitlist.countDocuments({ email: { $in: ["x@mailinator.com", "not-an-email"] } }), 0);
});

test("a signed-in member joins in one click; writers are marked", async () => {
  const writer = await makeUser();
  await ctx.Blog.create({ title: "A post", body: "<p>" + "word ".repeat(80) + "</p>", category: "Tech", status: "published", createdBy: writer._id });
  const { token, cookie } = await csrfFor(request, ctx.app);
  const res = await request(ctx.app).post("/earn/join").set("Cookie", `${cookie}; ${authCookie(writer)}`).type("form").send({ _csrf: token, src: "nav" });
  assert.equal(res.status, 302);
  const entry = await EarnWaitlist.findOne({ userId: writer._id }).lean();
  assert.ok(entry);
  assert.equal(entry.wasWriter, true);
  assert.equal(entry.source, "nav");
});

test("invites count once, never for yourself, and move the inviter up", async () => {
  const { agent: a, token: ta } = await agentWithCsrf();
  await a.post("/earn/join").type("form").send({ _csrf: ta, email: "inviter@example.com" });
  const inviter = await EarnWaitlist.findOne({ email: "inviter@example.com" }).lean();

  // A friend arrives through the link and joins.
  const friend = request.agent(ctx.app);
  const landing = await friend.get(`/earn?ref=${inviter.refCode}`);
  const tf = (landing.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  await friend.post("/earn/join").type("form").send({ _csrf: tf, email: "friend@example.com" });
  const f = await EarnWaitlist.findOne({ email: "friend@example.com" }).lean();
  assert.equal(f.referredBy, inviter.refCode);
  assert.equal(f.source, "ref");
  assert.equal((await EarnWaitlist.findById(inviter._id).lean()).referralCount, 1);

  // Using your own link does nothing.
  await a.get(`/earn?ref=${inviter.refCode}`);
  await a.post("/earn/join").type("form").send({ _csrf: ta, email: "inviter@example.com" });
  assert.equal((await EarnWaitlist.findById(inviter._id).lean()).referralCount, 1);
});

test("visits are counted once per visitor per day, by source", async () => {
  const before = await EarnVisit.aggregate([{ $match: { source: "publish" } }, { $group: { _id: null, n: { $sum: "$visitors" } } }]);
  const agent = request.agent(ctx.app);
  await agent.get("/earn?src=publish").set("User-Agent", "Mozilla/5.0 Test");
  await agent.get("/earn?src=publish").set("User-Agent", "Mozilla/5.0 Test");
  await new Promise((r) => setTimeout(r, 100));
  const after = await EarnVisit.aggregate([{ $match: { source: "publish" } }, { $group: { _id: null, n: { $sum: "$visitors" } } }]);
  assert.equal((after[0] ? after[0].n : 0) - (before[0] ? before[0].n : 0), 1);
});

test("admins see the results and can export them; others can't", async () => {
  const admin = await makeUser({ role: "ADMIN" });
  const member = await makeUser();
  const page = await request(ctx.app).get("/admin/earn").set("Cookie", authCookie(admin));
  assert.equal(page.status, 200);
  assert.match(page.text, /Earn waitlist/);
  const csv = await request(ctx.app).get("/admin/earn.csv").set("Cookie", authCookie(admin));
  assert.equal(csv.status, 200);
  assert.match(csv.headers["content-type"], /text\/csv/);
  assert.match(csv.text, /^join_number,email/);
  const denied = await request(ctx.app).get("/admin/earn").set("Cookie", authCookie(member));
  assert.notEqual(denied.status, 200);
});
