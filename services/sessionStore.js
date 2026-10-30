// 🪑 A session store that survives Redis going away.
//
// The app used to choose ONE store at boot: Redis when REDIS_URL was set, else
// Mongo. express-session captures that choice for the life of the process, so
// when the managed Redis later started refusing commands (an exhausted request
// quota) every session-bearing route broke. Worse than erroring: connect-redis
// let the rejection escape as an unhandled rejection and never invoked its
// callback, so requests hung until the client gave up on them.
//
// This wraps both stores. While Redis is usable it is the primary; on an error —
// or a timeout, which is what a disconnected client actually produces — the call
// is retried against Mongo and Redis is marked degraded so later calls skip it.
//
// Note that losing session state does NOT sign anyone out: this app authenticates
// from a JWT in the `token` cookie (see middleware/authentication.js). Sessions
// carry CSRF tokens, flash messages and the captcha, so the visible effect of a
// fallback is that an in-flight form may need resubmitting.
const session = require("express-session");
const logger = require("./logger");

// Long enough to absorb a slow round-trip, short enough that a hung client
// doesn't hold the request open.
const DEFAULT_TIMEOUT_MS = Number(process.env.SESSION_STORE_TIMEOUT_MS) || 2000;

class FallbackSessionStore extends session.Store {
  /**
   * @param {object} opts
   * @param {session.Store} opts.primary   preferred store (Redis)
   * @param {session.Store|(() => session.Store)} opts.fallback  always-available
   *   store (Mongo), or a factory so its connection is only opened if it's
   *   actually needed. Resolved once, on first use.
   * @param {() => boolean} opts.isPrimaryUsable
   * @param {(err: Error) => void} [opts.onPrimaryError]
   */
  constructor({ primary, fallback, isPrimaryUsable, onPrimaryError, timeoutMs }) {
    super();
    this.primary = primary;
    this._fallbackSource = fallback;
    this._fallback = typeof fallback === "function" ? null : fallback;
    this.isPrimaryUsable = isPrimaryUsable;
    this.onPrimaryError = onPrimaryError || (() => {});
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  }

  get fallback() {
    if (!this._fallback) this._fallback = this._fallbackSource();
    return this._fallback;
  }

  // Run `method` on the primary, falling back to the secondary on error,
  // timeout, or a synchronous throw. The callback runs exactly once.
  _delegate(method, args, callback) {
    const cb = typeof callback === "function" ? callback : () => {};
    const toFallback = (reason) => {
      if (reason) {
        logger.error(`⚠️ Session store (${method}) falling back to Mongo:`, reason.message || String(reason));
        this.onPrimaryError(reason);
      }
      if (typeof this.fallback[method] !== "function") return cb(null);
      try {
        this.fallback[method](...args, cb);
      } catch (e) {
        cb(e);
      }
    };

    if (!this.isPrimaryUsable() || typeof this.primary[method] !== "function") {
      return toFallback(null);
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      toFallback(new Error(`timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    try {
      const returned = this.primary[method](...args, (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return toFallback(err);
        cb(null, value);
      });

      // connect-redis's methods are `async`, so a failure rejects the returned
      // promise AND never reaches the callback. Unhandled, that's a stray
      // rejection and a request that hangs until the timeout above. Adopt it so
      // we fall back immediately instead.
      if (returned && typeof returned.catch === "function") {
        returned.catch((e) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          toFallback(e);
        });
      }
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      toFallback(e);
    }
  }

  get(sid, cb) { this._delegate("get", [sid], cb); }
  set(sid, sess, cb) { this._delegate("set", [sid, sess], cb); }
  destroy(sid, cb) { this._delegate("destroy", [sid], cb); }
  touch(sid, sess, cb) { this._delegate("touch", [sid, sess], cb); }
  all(cb) { this._delegate("all", [], cb); }
  length(cb) { this._delegate("length", [], cb); }
  clear(cb) { this._delegate("clear", [], cb); }
}

module.exports = { FallbackSessionStore };
