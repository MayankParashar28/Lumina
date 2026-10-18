# Scaling — Phase 1 (shared Redis layer)

This app now has a **Redis-backed shared layer** for the things that don't work
with more than one server process: sessions, caches, rate-limit counters, and
real-time (Socket.io) fan-out.

It is **off by default and degrades gracefully**. With no `REDIS_URL` set, the app
behaves exactly as before — Mongo-backed sessions, in-process caches, single-node
sockets — so local dev and the current deploy are unaffected.

## What Phase 1 added

| Concern | Without Redis (fallback) | With `REDIS_URL` |
|---|---|---|
| Sessions | `connect-mongo` (load on Atlas) | `connect-redis` (fast, shared) |
| Taxonomy cache (categories/tags/trending) | in-process Map, per instance | shared in Redis |
| AI results (counterpoint / rewrite) | in-process Map, per instance | shared in Redis |
| Rate limits (auth, blog, comment, email, verify) | memory, **resets per process** | shared counters in Redis |
| Socket.io events | reach one process only | fan out to all instances via Redis adapter |

All of this lives in [`services/redis.js`](../services/redis.js).

## How to turn it on

1. **Provision Redis** (e.g. Upstash, AWS ElastiCache, Redis Cloud) and get its URL.
2. Set the env var:
   ```
   REDIS_URL=rediss://default:<password>@<host>:<port>
   ```
3. Deploy. On boot you'll see:
   ```
   ✅ Redis connected.
   ✅ Sessions stored in Redis.
   ✅ Socket.io using Redis adapter (multi-instance fan-out ready).
   ```

That's it — no code changes. Every instance now shares session/cache/limit state
and can broadcast socket events to clients connected to any other instance.

## ⚠️ Real-time needs a persistent host

Socket.io holds long-lived WebSocket connections, which **Vercel's serverless
functions cannot do at all**. The Redis adapter makes multi-instance sockets
*correct*, but you still need the app (at least the real-time part) running on a
persistent host — Render, Railway, Fly.io, a container on ECS/Fly, etc.

Recommended shape:
- **App/SSR + API**: Vercel is fine (stateless, autoscales), or containerize it too.
- **Real-time tier**: a persistent Node service running this same app, behind the
  Redis adapter, with sticky sessions at the load balancer.

Until real-time moves off Vercel, live comments / co-reading / notifications will
not work in that environment regardless of Redis.

## Env vars

| Var | Purpose |
|---|---|
| `REDIS_URL` | Enables the whole shared layer. Unset = fallback mode. |
| `VECTOR_INDEX_NAME` | (Phase 2) Atlas vector index name. Defaults to `blog_vector_index`. |

---

# Scaling — Phase 2 (Atlas Vector Search)

The vibe page, semantic search and "related posts" used to load **every** blog's
embedding into Node and loop `cosineSimilarity` — O(N) memory + CPU per request.
They now call native **Atlas Vector Search** (`$vectorSearch`, ANN k-NN in the
database) via [`services/vectorSearch.js`](../services/vectorSearch.js).

**Fallback-safe:** until the vector index exists, `vectorSearchBlogs()` returns
an empty result → the code falls back to the old in-memory cosine path, so all
three features keep working unchanged. Create the index to turn on the fast path —
no code change, no restart logic needed.

## Create the index (one-time, in Atlas)

1. Atlas → your cluster → **Atlas Search** → **Create Search Index** →
   **Vector Search** (JSON editor).
2. Database: your app DB · Collection: **`blogs`** · Index name: **`blog_vector_index`**
   (or set `VECTOR_INDEX_NAME` to match).
3. Definition:
   ```json
   {
     "fields": [
       { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
       { "type": "filter", "path": "status" }
     ]
   }
   ```
   - `numDimensions: 768` matches `text-embedding-004`.
   - `similarity: cosine` must match — the code converts Atlas's normalised score
     back to raw cosine so thresholds and match-% stay identical.
   - The `status` filter field lets the query restrict to published posts inside
     the index (fast). Without it, the query errors and the code falls back.
4. Wait for the index to finish building. Done — searches now use it automatically.

## Verify it's active

With the index built, a search/recommendation returns results from
`$vectorSearch` instead of the fallback. You can confirm there's no
`⚠️ Vector search unavailable…` warning in the logs under load, or test directly:
```js
// node -r dotenv/config
const { vectorSearchBlogs } = require("./services/vectorSearch");
// returns results (not null) once the index exists
```

## Also done in Phase 2

- **Vector search everywhere** — the authed home feed's personalization (reading-
  history centroid) now uses `$vectorSearch` too, not just search/recs/vibe.
- **Mongo connection pool** — bounded, reused across requests/invocations
  (`maxPoolSize`, `maxIdleTimeMS`; tune with `MONGO_POOL_SIZE`).
- **Read replicas for anonymous reads** — the logged-out landing page reads with
  `readPreference: secondaryPreferred`, spreading read load onto Atlas secondaries
  (no new connection string needed — your cluster is already a replica set).
- **Bounded / paginated lists** — the landing page is capped (client loads more via
  `/blog/api/feed`), and notifications are cursor-paginated (`?before=<ISO date>`,
  20 per page, with a "Load older" link) instead of loading every row.

---

## What's next (later phases)

- **Phase 3** — cookie-less, CDN-cacheable renders of public blog/home pages for
  anonymous visitors (takes the bulk of read traffic off the app tier).
- **Phase 4** — move AI calls, notification fan-out, scheduled publishing and email
  to a BullMQ worker on Redis (off the request path; respects Gemini quotas).
- **Phase 5** — per-user/IP rate limiting, APM/metrics, and load testing (k6).
