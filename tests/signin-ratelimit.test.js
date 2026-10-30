// The login rate limiter must throttle sign-in ATTEMPTS without throttling the
// sign-in PAGE. Kept in its own file because the limiter's counter is per
// process and per IP, so it would otherwise bleed into unrelated tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { bootApp, csrfFor } = require("./helpers/app");

let ctx;

test.before(async () => { ctx = await bootApp(); });
test.after(async () => { if (ctx) await ctx.stop(); });

test("viewing the sign-in page is never rate limited", async () => {
  // The limiter allows 10 per 15 minutes and used to be attached to the GET as
  // well, so ~10 page views (or reloads) locked a visitor out of the form.
  for (let i = 1; i <= 25; i++) {
    const res = await request(ctx.app).get("/user/signin");
    assert.equal(res.status, 200, `GET #${i} should still render the form`);
  }
});

test("sign-in attempts are still rate limited", async () => {
  const { token, cookie } = await csrfFor(request, ctx.app);
  const attempt = () =>
    request(ctx.app)
      .post("/user/signin")
      .set("Cookie", cookie)
      .type("form")
      .send({ _csrf: token, email: "nobody@example.com", password: "wrong-password" });

  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);

  assert.ok(statuses.includes(429), `expected a 429 among attempts, got ${statuses.join(",")}`);
  assert.ok(statuses[0] !== 429, "the first attempt must be allowed through");

  // And the page itself is still reachable while attempts are blocked.
  const page = await request(ctx.app).get("/user/signin");
  assert.equal(page.status, 200, "being throttled must not hide the form");
});
