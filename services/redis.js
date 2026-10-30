// 🧱 Phase-1 scaling layer: a shared Redis client used for sessions, caches,
// rate-limit counters and the Socket.io adapter.
//
// Everything here degrades gracefully: if REDIS_URL is not set (or ioredis isn't
// installed), `enabled` is false and callers fall back to their previous
// single-process behaviour (Mongo sessions, in-memory caches, single-node
// sockets). Flip it on by setting REDIS_URL and running the app (especially the
// real-time tier) on a persistent host.
//
// It also degrades at RUNTIME. A managed Redis that starts refusing every
// command — an exhausted Upstash request quota, a rotated password — used to
// crash-loop the entire web service on boot. Now the first fatal reply trips a
// circuit breaker: Redis is marked degraded, the clients stop reconnecting (so
// they aren't burning more quota), and every caller falls back to its
// in-process equivalent instead of the process dying.
const logger = require("./logger");

let Redis = null;
try {
  Redis = require("ioredis");
} catch (_) {
  // ioredis not installed — stay in fallback mode.
}

const REDIS_URL = process.env.REDIS_URL;
const enabled = !!(REDIS_URL && Redis && process.env.REDIS_DISABLED !== "true");

// ---------------------------------------------------------------------------
// Runtime circuit breaker
// ---------------------------------------------------------------------------

const clients = [];
let degraded = false;
let transientErrors = 0;
const TRANSIENT_ERROR_LIMIT = Number(process.env.REDIS_ERROR_LIMIT) || 25;

// Conditions a retry will never fix: the plan's request allowance is spent, or
// the credentials are rejected. Reconnecting on these only wastes more requests.
const FATAL_PATTERNS = [
  /max requests limit exceeded/i,
  /max daily request limit exceeded/i,
  /exceeded the (?:max|daily)/i,
  /WRONGPASS/i,
  /NOAUTH/i,
  /invalid password/i,
];

const isFatalMessage = (message) => FATAL_PATTERNS.some((re) => re.test(message || ""));

function markDegraded(err, label = "redis") {
  if (degraded) return true;
  const message = (err && err.message) || String(err);

  if (isFatalMessage(message)) {
    degraded = true;
    logger.error(
      `🔻 Redis is unusable and will not be retried (${label}): ${message} — ` +
        "serving from in-process caches and rate limits instead. Set REDIS_DISABLED=true " +
        "to skip Redis entirely (sessions move to Mongo) until this is resolved."
    );
  } else if (++transientErrors >= TRANSIENT_ERROR_LIMIT) {
    degraded = true;
    logger.error(
      `🔻 Redis has failed ${transientErrors} times (${label}); giving up and falling back to in-process behaviour.`
    );
  } else {
    return false;
  }

  // Stop reconnect attempts against a Redis that can't serve us.
  for (const c of clients) {
    try {
      c.disconnect(false);
    } catch (_) {
      /* already gone */
    }
  }
  return true;
}

// Is Redis actually available right now?
const usable = () => enabled && !degraded;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const CLIENT_OPTS = {
  maxRetriesPerRequest: null, // don't throw MaxRetriesPerRequestError (which crashed the app)
  retryStrategy: (times) => {
    if (degraded || times > 5) return null; // stop reconnecting if broken or quota exhausted
    return Math.min(times * 200, 3000);
  },
};

// Always attach an 'error' handler: an EventEmitter that emits 'error' with no
// listener throws, which is how a Redis AUTH failure took the process down.
const attachHandlers = (c, label) => {
  c.on("error", (e) => {
    logger.error(`❌ Redis ${label} error:`, e.message);
    markDegraded(e, label);
  });
  c.on("connect", () => logger.info(`✅ Redis ${label} connected.`));
  clients.push(c);
  return c;
};

let client = null;
if (enabled) {
  client = attachHandlers(new Redis(REDIS_URL, CLIENT_OPTS), "client");
}

// Socket.io's Redis adapter needs its own pub/sub connections, separate from
// the command client.
function makePubSub() {
  if (!usable()) return { pubClient: null, subClient: null };
  return {
    pubClient: attachHandlers(client.duplicate(), "pub"),
    subClient: attachHandlers(client.duplicate(), "sub"),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// A tiny cache abstraction. Uses Redis when available, else a per-process Map
// with TTLs so local/dev behaviour is unchanged. Values are JSON-serialised.
const mem = new Map();
const MEM_MAX_ENTRIES = 500;

const memGet = (key) => {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.exp && Date.now() > hit.exp) {
    mem.delete(key);
    return null;
  }
  return hit.val;
};

const memSet = (key, val, ttlSeconds) => {
  if (mem.size >= MEM_MAX_ENTRIES && !mem.has(key)) mem.clear();
  mem.set(key, { val, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
};

const cache = {
  async get(key) {
    if (usable()) {
      try {
        const v = await client.get(key);
        return v ? JSON.parse(v) : null;
      } catch (e) {
        logger.error("Cache get failed:", e.message);
        markDegraded(e, "cache");
        // fall through to the in-process copy
      }
    }
    return memGet(key);
  },
  async set(key, val, ttlSeconds) {
    if (usable()) {
      try {
        const s = JSON.stringify(val);
        if (ttlSeconds) await client.set(key, s, "EX", ttlSeconds);
        else await client.set(key, s);
        return;
      } catch (e) {
        logger.error("Cache set failed:", e.message);
        markDegraded(e, "cache");
      }
    }
    memSet(key, val, ttlSeconds);
  },
  async del(key) {
    if (usable()) {
      try {
        await client.del(key);
      } catch (e) {
        logger.error("Cache del failed:", e.message);
        markDegraded(e, "cache");
      }
    }
    mem.delete(key);
  },
};

// ---------------------------------------------------------------------------
// Rate-limit store
// ---------------------------------------------------------------------------

// Returns a store for express-rate-limit backed by Redis (shared counters across
// instances) that falls back to per-process counting when Redis can't answer, or
// undefined so express-rate-limit uses its own default memory store.
//
// Two things here are load-bearing:
//  1. `sendCommand` must never resolve with a non-reply. rate-limit-redis throws
//     `TypeError: unexpected reply from redis client` on anything that isn't a
//     string, and it does so from an un-awaited promise in its constructor — an
//     unhandled rejection that terminates the process.
//  2. Those constructor promises are adopted below for the same reason.
function makeRateLimitStore(prefix) {
  if (!enabled) return undefined;

  const { MemoryStore } = require("express-rate-limit");
  const memoryStore = new MemoryStore();

  let redisStore;
  try {
    const { RedisStore } = require("rate-limit-redis");
    redisStore = new RedisStore({
      prefix,
      sendCommand: async (...args) => {
        if (!usable()) throw new Error("redis unavailable");
        try {
          return await client.call(...args);
        } catch (err) {
          markDegraded(err, "rate-limit");
          throw err; // propagate: never resolve with null
        }
      },
    });

    // The RedisStore constructor kicks off two SCRIPT LOAD calls and stores the
    // promises without awaiting them. Adopt them so a failure is handled here
    // rather than becoming a process-killing unhandled rejection.
    for (const pending of [redisStore.incrementScriptSha, redisStore.getScriptSha]) {
      Promise.resolve(pending).catch((e) => markDegraded(e, "rate-limit-init"));
    }
  } catch (e) {
    logger.error("rate-limit-redis unavailable, using memory store:", e.message);
    return undefined;
  }

  const viaRedis = async (method, key) => {
    if (usable()) {
      try {
        return await redisStore[method](key);
      } catch (e) {
        markDegraded(e, "rate-limit");
      }
    }
    return memoryStore[method](key);
  };

  // A hand-rolled store rather than a subclass, so both backends stay usable.
  return {
    localKeys: false,
    init(options) {
      try {
        if (typeof redisStore.init === "function") redisStore.init(options);
      } catch (e) {
        markDegraded(e, "rate-limit-init");
      }
      memoryStore.init(options);
    },
    increment: (key) => viaRedis("increment", key),
    decrement: (key) => viaRedis("decrement", key),
    resetKey: (key) => viaRedis("resetKey", key),
  };
}

module.exports = {
  enabled,
  client,
  makePubSub,
  cache,
  makeRateLimitStore,
  isUsable: usable,
  isDegraded: () => degraded,
  // Lets other layers (e.g. the session store) report a Redis failure they
  // handled themselves, so the breaker trips for everyone.
  noteFailure: markDegraded,
};
