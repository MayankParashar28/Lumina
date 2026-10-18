// 🧱 Phase-1 scaling layer: a shared Redis client used for sessions, caches,
// rate-limit counters and the Socket.io adapter.
//
// Everything here degrades gracefully: if REDIS_URL is not set (or ioredis isn't
// installed), `enabled` is false and callers fall back to their previous
// single-process behaviour (Mongo sessions, in-memory caches, single-node
// sockets). Flip it on by setting REDIS_URL and running the app (especially the
// real-time tier) on a persistent host.
const logger = require("./logger");

let Redis = null;
try {
  Redis = require("ioredis");
} catch (_) {
  // ioredis not installed — stay in fallback mode.
}

const REDIS_URL = process.env.REDIS_URL;
const enabled = !!(REDIS_URL && Redis);

// Keep a bad/unreachable Redis from crashing the app. Commands fail fast and the
// app keeps serving (degraded) instead of taking an unhandled exception. Always
// attach an 'error' handler — an EventEmitter with none throws on 'error'.
const CLIENT_OPTS = {
  maxRetriesPerRequest: null, // don't throw MaxRetriesPerRequestError (which crashed the app)
  retryStrategy: (times) => Math.min(times * 200, 5000), // back off, keep reconnecting
};
const attachHandlers = (c, label) => {
  c.on("error", (e) => logger.error(`❌ Redis ${label} error:`, e.message));
  c.on("connect", () => logger.info(`✅ Redis ${label} connected.`));
  return c;
};

let client = null;
if (enabled) {
  client = attachHandlers(new Redis(REDIS_URL, CLIENT_OPTS), "client");
}

// Socket.io's Redis adapter needs its own pub/sub connections, separate from
// the command client.
function makePubSub() {
  if (!enabled) return { pubClient: null, subClient: null };
  return {
    pubClient: attachHandlers(client.duplicate(), "pub"),
    subClient: attachHandlers(client.duplicate(), "sub"),
  };
}

// A tiny cache abstraction. Uses Redis when enabled, else a per-process Map with
// TTLs so local/dev behaviour is unchanged. Values are JSON-serialised.
const mem = new Map();
const cache = {
  async get(key) {
    try {
      if (enabled) {
        const v = await client.get(key);
        return v ? JSON.parse(v) : null;
      }
      const hit = mem.get(key);
      if (!hit) return null;
      if (hit.exp && Date.now() > hit.exp) {
        mem.delete(key);
        return null;
      }
      return hit.val;
    } catch (e) {
      logger.error("Cache get failed:", e.message);
      return null;
    }
  },
  async set(key, val, ttlSeconds) {
    try {
      if (enabled) {
        const s = JSON.stringify(val);
        if (ttlSeconds) await client.set(key, s, "EX", ttlSeconds);
        else await client.set(key, s);
        return;
      }
      mem.set(key, { val, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
    } catch (e) {
      logger.error("Cache set failed:", e.message);
    }
  },
  async del(key) {
    try {
      if (enabled) await client.del(key);
      else mem.delete(key);
    } catch (e) {
      logger.error("Cache del failed:", e.message);
    }
  },
};

// Returns a rate-limit-redis store (shared counters across instances) when Redis
// is enabled, else undefined so express-rate-limit uses its default memory store.
function makeRateLimitStore(prefix) {
  if (!enabled) return undefined;
  try {
    const { RedisStore } = require("rate-limit-redis");
    return new RedisStore({
      prefix,
      sendCommand: (...args) => client.call(...args),
    });
  } catch (e) {
    logger.error("rate-limit-redis unavailable, using memory store:", e.message);
    return undefined;
  }
}

module.exports = { enabled, client, makePubSub, cache, makeRateLimitStore };
