// 🧱 Phase-4 scaling: BullMQ queue layer on Redis.
//
// Enqueues background work (embeddings, notification fan-out, scheduled publishing)
// to Redis so it runs off the request path. Fallback-safe: with no Redis (or
// QUEUE_DISABLED=true) it runs each job INLINE — exactly the pre-queue behaviour —
// so dev and tests are unaffected.
//
// By default the web process also runs the worker (no extra service needed). For
// real decoupling at scale, run `node worker.js` as a separate process (e.g. a
// Render Background Worker) and set QUEUE_WORKER_INLINE=false on the web service.
const redisSvc = require("./redis");
const { enabled: redisEnabled } = redisSvc;
const jobs = require("./jobs");
const logger = require("./logger");

const QUEUE_NAME = "lumina-jobs";
let Queue, Worker, IORedis;
let queuesEnabled = false;
let queue = null;
let queueConn = null;

try {
  if (redisEnabled && process.env.QUEUE_DISABLED !== "true" && process.env.NODE_ENV !== "test") {
    ({ Queue, Worker } = require("bullmq"));
    IORedis = require("ioredis");
    // BullMQ needs its own connection with maxRetriesPerRequest: null.
    queueConn = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    queueConn.on("error", (e) => logger.error("❌ BullMQ Queue Redis error:", e.message));
    queue = new Queue(QUEUE_NAME, {
      connection: queueConn,
      // BullMQ also appends every job state change to an event stream. Keep it
      // short so it doesn't become its own pile of leftover data.
      streams: { events: { maxLen: 100 } },
    });
    // BullMQ forwards connection failures as an 'error' event on the Queue, and
    // an 'error' event with no listener throws — that is how an unreachable or
    // out-of-quota Redis took the whole web process down on boot. Jobs fall back
    // to running inline (see enqueue below), so logging here is enough.
    queue.on("error", (e) => logger.error("❌ BullMQ Queue error:", e && e.message));
    queuesEnabled = true;
  }
} catch (e) {
  logger.error("⚠️ Queue init failed; running jobs inline:", e.message);
  queuesEnabled = false;
}

// A job's `data` is the document handed to the worker: it is stored in Redis
// only until the worker is finished with it. As soon as the job completes — or
// fails for the LAST time, after its retries — BullMQ deletes the job and its
// data, so Redis empties itself once the queue is drained. Retries still work:
// a job between attempts is not "failed" yet and keeps its data.
const DEFAULT_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: true,
  removeOnFail: true,
};

// Enqueue a job, or run it inline (fire-and-forget) when queues are off.
async function enqueue(name, data, opts = {}) {
  // `queuesEnabled` is decided at startup; isUsable() also covers Redis having
  // failed since then, so we don't retry a queue we know is down.
  if (queuesEnabled && redisSvc.isUsable()) {
    try {
      await queue.add(name, data, { ...DEFAULT_OPTS, ...opts });
      return;
    } catch (e) {
      logger.error(`⚠️ Enqueue "${name}" failed; running inline:`, e.message);
    }
  }
  jobs.runJob(name, data).catch((err) => logger.error(`Inline job "${name}" error:`, err.message));
}

// Delete finished jobs still sitting in Redis — e.g. ones kept by an older
// config that retained the last 100 completed / 200 failed jobs. New jobs remove
// themselves (see DEFAULT_OPTS), so after this sweep nothing finished lingers.
async function sweepFinishedJobs() {
  if (!queuesEnabled || !redisSvc.isUsable()) return { completed: 0, failed: 0 };
  try {
    const completed = await queue.clean(0, 0, "completed");
    const failed = await queue.clean(0, 0, "failed");
    if (completed.length || failed.length) {
      logger.info(`🧹 Removed ${completed.length} completed and ${failed.length} failed jobs left in Redis.`);
    }
    return { completed: completed.length, failed: failed.length };
  } catch (e) {
    logger.error("⚠️ Queue sweep failed:", e.message);
    return { completed: 0, failed: 0 };
  }
}

let worker = null;
let workerConn = null;

// Start a BullMQ worker in this process. Called by index.js (inline) and worker.js.
function startWorker() {
  if (!queuesEnabled) return null;
  sweepFinishedJobs();
  workerConn = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  workerConn.on("error", (e) => logger.error("❌ BullMQ Worker Redis error:", e.message));
  worker = new Worker(QUEUE_NAME, async (job) => jobs.runJob(job.name, job.data), {
    connection: workerConn,
    concurrency: Number(process.env.QUEUE_CONCURRENCY) || 5,
  });
  worker.on("error", (err) => logger.error("❌ BullMQ Worker error:", err && err.message));
  worker.on("ioredis:close", () => logger.warn("⚠️ BullMQ Worker Redis connection closed."));
  worker.on("failed", (job, err) => logger.error(`❌ Job "${job && job.name}" failed:`, err && err.message));
  logger.info("✅ Background worker started (BullMQ).");
  return worker;
}

// Register the repeatable scheduled-publish job (replaces setInterval) when on.
async function scheduleRepeatables() {
  if (!queuesEnabled) return;
  try {
    await queue.add("publishScheduled", {}, {
      repeat: { every: 60 * 1000 },
      removeOnComplete: true,
      removeOnFail: true,
      jobId: "publishScheduled-repeat",
    });
    logger.info("✅ Scheduled-publish repeatable job registered.");
  } catch (e) {
    logger.error("⚠️ Repeatable job setup failed:", e.message);
  }
}

// Close the worker (letting in-flight jobs finish) and the queue connection.
async function close() {
  if (worker) await worker.close().catch(() => {});
  if (queue) await queue.close().catch(() => {});
  for (const c of [workerConn, queueConn]) {
    if (c) await c.quit().catch(() => c.disconnect());
  }
  worker = null;
  workerConn = null;
}

module.exports = { enqueue, startWorker, scheduleRepeatables, sweepFinishedJobs, close, queuesEnabled };
