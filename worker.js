// 🧱 Phase-4: standalone background worker.
//
// Run this as a separate process (e.g. a Render "Background Worker" service) to
// decouple background jobs from the web tier at scale:
//   node worker.js
// Then set QUEUE_WORKER_INLINE=false on the web service so it only enqueues.
//
// It connects to Mongo and, via the Redis adapter, emits real-time notifications
// that reach clients connected to the web instances.
require("dotenv").config();
const mongoose = require("mongoose");
const logger = require("./services/logger");
const jobs = require("./services/jobs");
const queue = require("./services/queue");
const redisSvc = require("./services/redis");

(async () => {
  await mongoose.connect(process.env.MONGODB_URL, {
    maxPoolSize: Number(process.env.MONGO_POOL_SIZE) || 10,
  });
  logger.info("✅ Worker: MongoDB connected.");

  // Emit-only Socket.io through the Redis adapter, so notifications created here
  // reach clients connected to the web instances.
  if (redisSvc.enabled) {
    try {
      const { Server } = require("socket.io");
      const { createAdapter } = require("@socket.io/redis-adapter");
      const io = new Server();
      const { pubClient, subClient } = redisSvc.makePubSub();
      io.adapter(createAdapter(pubClient, subClient));
      jobs.setIo(io);
      logger.info("✅ Worker: Socket.io emitter ready (via Redis adapter).");
    } catch (e) {
      logger.error("⚠️ Worker io setup failed (notifications will be DB-only):", e.message);
    }
  }

  if (!queue.queuesEnabled) {
    logger.error("❌ Worker started but queues are disabled (no REDIS_URL). Nothing to do.");
    process.exit(1);
  }

  queue.startWorker();
  queue.scheduleRepeatables();
  logger.info("✅ Worker ready — processing background jobs.");
})().catch((e) => {
  logger.error("❌ Worker startup failed:", e.message);
  process.exit(1);
});
