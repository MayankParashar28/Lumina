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
const { enabled: redisEnabled } = require("./redis");
const jobs = require("./jobs");
const logger = require("./logger");

const QUEUE_NAME = "lumina-jobs";
let Queue, Worker, IORedis;
let queuesEnabled = false;
let queue = null;

try {
  if (redisEnabled && process.env.QUEUE_DISABLED !== "true" && process.env.NODE_ENV !== "test") {
    ({ Queue, Worker } = require("bullmq"));
    IORedis = require("ioredis");
    // BullMQ needs its own connection with maxRetriesPerRequest: null.
    queue = new Queue(QUEUE_NAME, {
      connection: new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }),
    });
    queuesEnabled = true;
  }
} catch (e) {
  logger.error("⚠️ Queue init failed; running jobs inline:", e.message);
  queuesEnabled = false;
}

const DEFAULT_OPTS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

// Enqueue a job, or run it inline (fire-and-forget) when queues are off.
async function enqueue(name, data, opts = {}) {
  if (queuesEnabled) {
    try {
      await queue.add(name, data, { ...DEFAULT_OPTS, ...opts });
      return;
    } catch (e) {
      logger.error(`⚠️ Enqueue "${name}" failed; running inline:`, e.message);
    }
  }
  jobs.runJob(name, data).catch((err) => logger.error(`Inline job "${name}" error:`, err.message));
}

// Start a BullMQ worker in this process. Called by index.js (inline) and worker.js.
function startWorker() {
  if (!queuesEnabled) return null;
  const worker = new Worker(QUEUE_NAME, async (job) => jobs.runJob(job.name, job.data), {
    connection: new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null }),
    concurrency: Number(process.env.QUEUE_CONCURRENCY) || 5,
  });
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
      removeOnFail: 50,
      jobId: "publishScheduled-repeat",
    });
    logger.info("✅ Scheduled-publish repeatable job registered.");
  } catch (e) {
    logger.error("⚠️ Repeatable job setup failed:", e.message);
  }
}

module.exports = { enqueue, startWorker, scheduleRepeatables, queuesEnabled };
