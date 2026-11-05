// ⚡ In-process micro-cache for anonymous public pages (origin-side, ~CDN speed).
//
// Phase-3 made anonymous GET / and GET /blog/<id> identical cookie-less responses,
// so the fully-rendered HTML can be cached in memory and served to subsequent
// anonymous hits in well under a millisecond — no DB query, no EJS render. This is
// the biggest speed win available without a CDN. (Per-process; each instance keeps
// its own cache. Busted on publish/edit/delete; also self-expires after the TTL.)
const TTL = (Number(process.env.PAGE_CACHE_TTL_SECONDS) || 60) * 1000;
const MAX_ENTRIES = 300;
const store = new Map(); // path -> { body, type, nonce, exp }

const enabled = () => process.env.PAGE_CACHE_DISABLED !== "true";

function get(path) {
  const hit = store.get(path);
  if (hit && hit.exp > Date.now()) return hit;
  if (hit) store.delete(path);
  return null;
}

// `nonce` is the per-request CSP nonce that was baked into this HTML. It has to
// be stored with the body: the cached markup carries that one nonce forever, so
// whoever serves a cache hit must re-point the CSP header at it, or every inline
// <script> in the page gets blocked. See the cache-hit branch in index.js.
function set(path, body, type, nonce) {
  if (store.size >= MAX_ENTRIES) store.clear(); // simple bound; TTL does the real work
  store.set(path, { body, type, nonce, exp: Date.now() + TTL });
}

function bust(path) { store.delete(path); }

// A blog changed → drop its page and the landing (its list/feed changed too).
//
// Variadic because a post has two cacheable paths: its slug (the canonical URL
// readers and the cache actually see) and its ObjectId (every permalink shared
// before slugs existed, which 301s but can itself have been cached). Busting
// only one leaves the other serving the stale copy for up to a full TTL, so
// callers pass both.
function bustBlog(...keys) {
  for (const key of keys) {
    if (key) store.delete(`/blog/${key}`);
  }
  store.delete("/");
}

function clear() { store.clear(); }

module.exports = { enabled, get, set, bust, bustBlog, clear };
