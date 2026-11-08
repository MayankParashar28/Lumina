// The queue's contract with Redis: a job's data (the "document") is stored in
// Redis only until the background worker is done with it. Once the job
// completes — or fails for the last time — it is deleted, so a drained queue
// leaves no job data behind.
//
// Runs against a real redis-server on a random port; skipped if the binary
// isn't installed. Deliberately does NOT use the app harness: that harness sets
// NODE_ENV=test, which turns the queue off.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");

const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;

let server, redis, queue, jobs;
const QUEUE = "lumina-jobs";
const seen = [];
let failAttempts = 0;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const waitFor = async (predicate, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// Every key holding a job (its hash, logs, locks) — but not the queue's own
// bookkeeping such as the id counter or meta.
const jobKeys = async () =>
  (await redis.keys(`bull:${QUEUE}:*`)).filter((k) => /:\d+(:|$)/.test(k.slice(`bull:${QUEUE}:`.length)));

test.before(async () => {
  if (!hasRedis) return;
  const port = await freePort();
  server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], {
    stdio: "ignore",
  });
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.NODE_ENV = "development";
  delete process.env.QUEUE_DISABLED;
  delete process.env.REDIS_DISABLED;

  const IORedis = require("ioredis");
  redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  assert.ok(await waitFor(async () => (await redis.ping().catch(() => "")) === "PONG"));

  // Test processors, registered before the queue/worker look them up.
  jobs = require("../services/jobs");
  jobs.PROCESSORS.storeDoc = async (data) => {
    seen.push(data);
  };
  jobs.PROCESSORS.alwaysFails = async () => {
    failAttempts += 1;
    throw new Error("boom");
  };

  queue = require("../services/queue");
});

test.after(async () => {
  if (!hasRedis) return;
  await queue.close();
  await redis.quit();
  server.kill();
});

test("document is stored in Redis, handed to the worker, then deleted", { skip: !hasRedis }, async () => {
  assert.equal(queue.queuesEnabled, true, "queue should be on with a reachable Redis");

  // Leftovers from the old config (kept the last N finished jobs) get swept.
  const { Queue } = require("bullmq");
  const legacy = new Queue(QUEUE, { connection: { url: process.env.REDIS_URL } });
  const { Worker } = require("bullmq");
  const legacyWorker = new Worker(QUEUE, async () => "ok", {
    connection: { url: process.env.REDIS_URL },
  });
  await legacy.add("legacy", { old: true }, { removeOnComplete: 100 });
  assert.ok(await waitFor(async () => (await legacy.getCompletedCount()) === 1));
  await legacyWorker.close();

  // Enqueue with no worker running: the document waits in Redis.
  const doc = { blogId: "abc123", text: "A full blog body that the worker needs." };
  await queue.enqueue("storeDoc", doc);
  const waiting = await legacy.getWaiting();
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].data, doc, "the document is stored in Redis for the worker");

  // Hand over to the worker.
  queue.startWorker();
  assert.ok(await waitFor(() => seen.length === 1), "worker received the document");
  assert.deepEqual(seen[0], doc);

  // …and afterwards Redis holds nothing for it, nor for the legacy job.
  assert.ok(await waitFor(async () => (await jobKeys()).length === 0), "job data removed from Redis");
  const counts = await legacy.getJobCounts("waiting", "active", "completed", "failed", "delayed");
  assert.deepEqual(
    { ...counts, paused: undefined },
    { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: undefined }
  );
  assert.ok((await redis.xlen(`bull:${QUEUE}:events`)) <= 200, "event stream stays capped");
  await legacy.close();
});

test("a job that fails every retry is deleted too", { skip: !hasRedis }, async () => {
  await queue.enqueue("alwaysFails", { blogId: "x" }, { attempts: 2, backoff: { type: "fixed", delay: 50 } });
  assert.ok(await waitFor(() => failAttempts === 2), "job was retried before giving up");
  assert.ok(await waitFor(async () => (await jobKeys()).length === 0), "failed job removed after last attempt");
});
