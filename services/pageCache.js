// ⚡ In-process micro-cache for anonymous public pages (origin-side, ~CDN speed).
//
// Phase-3 made anonymous GET / and GET /blog/<id> identical cookie-less responses,
// so the fully-rendered HTML can be cached in memory and served to subsequent
// anonymous hits in well under a millisecond — no DB query, no EJS render. This is
// the biggest speed win available without a CDN. (Per-process; each instance keeps
// its own cache. Busted on publish/edit/delete; also self-expires after the TTL.)
const TTL = (Number(process.env.PAGE_CACHE_TTL_SECONDS) || 60) * 1000;
const MAX_ENTRIES = 300;
const store = new Map(); // path -> { body, type, exp }

const enabled = () => process.env.PAGE_CACHE_DISABLED !== "true";

function get(path) {
  const hit = store.get(path);
  if (hit && hit.exp > Date.now()) return hit;
  if (hit) store.delete(path);
  return null;
}

function set(path, body, type) {
  if (store.size >= MAX_ENTRIES) store.clear(); // simple bound; TTL does the real work
  store.set(path, { body, type, exp: Date.now() + TTL });
}

function bust(path) { store.delete(path); }

// A blog changed → drop its page and the landing (its list/feed changed too).
function bustBlog(id) {
  if (id) store.delete(`/blog/${id}`);
  store.delete("/");
}

function clear() { store.clear(); }

module.exports = { enabled, get, set, bust, bustBlog, clear };
