// What happens when the managed Redis starts refusing every command — an
// exhausted Upstash request quota, say.
//
// This used to crash-loop the service on boot, two different ways:
//   * ioredis surfaced the AUTH failure as an 'error' event on a BullMQ Queue
//     that had no 'error' listener, and an unhandled 'error' event throws.
//   * the rate-limit store's sendCommand swallowed the failure and resolved with
//     null, so rate-limit-redis threw "unexpected reply from redis client" from
//     an un-awaited promise in its constructor — an unhandled rejection, which
//     terminates the process.
//
// The app must now degrade to its in-process fallbacks and keep serving.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const request = require("supertest");

// Requiring the harness first clears REDIS_URL; we set our own below.
const { bootApp } = require("./helpers/app");

const QUOTA_ERROR =
  "-ERR max requests limit exceeded. Limit: 500000, Usage: 500005. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details\r\n";

let hostileRedis, ctx, redisSvc;

// A server that speaks just enough RESP to reject everything, the way a
// quota-exhausted Upstash endpoint does.
function startHostileRedis() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("data", () => {
        try { socket.write(QUOTA_ERROR); } catch (_) {}
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const waitFor = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test.before(async () => {
  hostileRedis = await startHostileRedis();
  const { port } = hostileRedis.address();
  // Set after requiring the harness, before the app loads.
  process.env.REDIS_URL = `redis://default:sometoken@127.0.0.1:${port}`;

  ctx = await bootApp();
  redisSvc = require("../services/redis");

  const author = await ctx.User.create({
    fullName: "Quota Tester",
    email: "quota@example.com",
    password: "password123",
    isVerified: true,
  });
  await ctx.Blog.create({
    title: "Still Serving",
    body: "<p>up</p>",
    createdBy: author._id,
    status: "published",
  });
});

test.after(async () => {
  delete process.env.REDIS_URL;
  if (ctx) await ctx.stop();
  if (hostileRedis) await new Promise((r) => hostileRedis.close(r));
});

test("Redis was configured, so the app really did try to use it", () => {
  assert.equal(redisSvc.enabled, true, "precondition: REDIS_URL was picked up");
});

test("a quota-exhausted Redis trips the circuit breaker instead of crashing", async () => {
  const tripped = await waitFor(() => redisSvc.isDegraded());
  assert.equal(tripped, true, "the fatal reply should mark Redis degraded");
  assert.equal(redisSvc.isUsable(), false);
});

test("the app still serves pages with Redis dead", async () => {
  const health = await request(ctx.app).get("/health");
  assert.equal(health.status, 200);

  const landing = await request(ctx.app).get("/");
  assert.equal(landing.status, 200, "the landing page must still render");
  assert.ok(landing.text.includes("Still Serving"), "and still show real content");
});

test("rate-limited routes fall back to in-process counting, not 500s", async () => {
  // The limiters are Redis-backed. With Redis down they must keep working off
  // the memory store rather than erroring on every request.
  for (let i = 1; i <= 12; i++) {
    const res = await request(ctx.app).get("/user/signin");
    assert.equal(res.status, 200, `request #${i} should still be served`);
  }
});

test("the cache transparently falls back to the in-process map", async () => {
  await redisSvc.cache.set("degradation-probe", { ok: true }, 60);
  assert.deepEqual(await redisSvc.cache.get("degradation-probe"), { ok: true });
  await redisSvc.cache.del("degradation-probe");
  assert.equal(await redisSvc.cache.get("degradation-probe"), null);
});

test("/healthz reports Redis as degraded but the service as ok", async () => {
  const res = await request(ctx.app).get("/healthz");
  assert.equal(res.status, 200, "a degraded cache is not a service outage");
  assert.equal(res.body.mongo, "up");
  assert.equal(res.body.redis, "degraded");
});

test("every Redis client has an error listener", () => {
  // An EventEmitter that emits 'error' with no listener throws, which is how the
  // AUTH failure escalated into an uncaught exception.
  if (redisSvc.client) {
    assert.ok(
      redisSvc.client.listenerCount("error") > 0,
      "the shared client must have an error listener"
    );
  }
});
