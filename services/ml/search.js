// 🔎 Hybrid search: meaning + keywords + title, fused into one ranking.
//
// Search used to try meaning first and fall back to keywords only when meaning
// found nothing — so a post whose title literally matched the query could be
// missing whenever some loosely related post scored above the threshold. Now
// three retrievers run side by side and their rankings are fused with
// Reciprocal Rank Fusion (services/ml/rank.js):
//
//   meaning   the query's embedding vs. post embeddings (finds "beating
//             burnout" for "how to stay motivated")
//   keywords  MongoDB full-text search (exact words, stemmed)
//   title     prefix / substring match on titles (works while still typing)
//
// Query embeddings are cached for a day, so a repeated search costs no API call.
const crypto = require("crypto");
const Blog = require("../../models/blog");
const { cache } = require("../redis");
const logger = require("../logger");
const { generateEmbedding, EMBEDDING_MODEL_ID } = require("../ai");
const { vectorSearchBlogs } = require("../vectorSearch");
const { nearest } = require("./corpus");
const { reciprocalRankFusion } = require("./rank");

const FIELDS = "title slug coverImageURL category createdBy readTime views createdAt metaDescription";
const MIN_MEANING_SCORE = 0.3;
const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function queryEmbedding(q) {
  const key = `qemb:${EMBEDDING_MODEL_ID}:${crypto.createHash("sha1").update(q.toLowerCase()).digest("hex")}`;
  const hit = await cache.get(key);
  if (hit) return hit;
  const vec = await generateEmbedding(q, { taskType: "RETRIEVAL_QUERY" });
  if (vec.length) await cache.set(key, vec, 24 * 60 * 60);
  return vec;
}

async function byMeaning(vec, limit) {
  if (!vec.length) return [];
  const viaVector = await vectorSearchBlogs(vec, { limit, projection: { _id: 1 } });
  if (viaVector) return viaVector.filter((d) => d.score > MIN_MEANING_SCORE).map((d) => ({ id: d._id, score: d.score }));
  // No vector index: the shared in-memory corpus (services/ml/corpus.js).
  const near = await nearest(vec, { limit, minScore: MIN_MEANING_SCORE });
  return near.map((d) => ({ id: d._id, score: d.score }));
}

async function byKeywords(q, limit) {
  try {
    const docs = await Blog.find({ $text: { $search: q }, status: "published" }, { score: { $meta: "textScore" } })
      .select("_id")
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .lean();
    return docs.map((d) => ({ id: d._id }));
  } catch (err) {
    logger.warn("⚠️ Keyword search failed: %s", err.message);
    return [];
  }
}

async function byTitle(q, limit) {
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  if (!words.length) return [];
  // Every word must appear in the title; the last one may be half-typed.
  const filter = { status: "published", $and: words.map((w) => ({ title: { $regex: escapeRe(w), $options: "i" } })) };
  const docs = await Blog.find(filter).select("_id").sort({ views: -1 }).limit(limit).maxTimeMS(500).lean().catch(() => []);
  return docs.map((d) => ({ id: d._id }));
}

/**
 * @returns {Promise<{results:object[], mode:string}>} results carry
 *   `matchedBy` (["meaning","keywords","title"]) and `meaningScore` when found by meaning.
 */
async function hybridSearch(rawQuery, { limit = 12, useMeaning = true } = {}) {
  const q = String(rawQuery || "").trim().slice(0, 200);
  if (!q) return { results: [], mode: null };
  const pool = Math.max(limit * 3, 20);

  const vec = useMeaning ? await queryEmbedding(q).catch(() => []) : [];
  const [meaning, keywords, title] = await Promise.all([
    byMeaning(vec, pool).catch((err) => { logger.warn("⚠️ Meaning search failed: %s", err.message); return []; }),
    byKeywords(q, pool),
    byTitle(q, Math.min(pool, 20)),
  ]);

  const fused = reciprocalRankFusion([
    { name: "meaning", items: meaning, weight: 1 },
    { name: "keywords", items: keywords, weight: 1 },
    { name: "title", items: title, weight: 0.8 },
  ]).slice(0, limit);

  const meaningScore = new Map(meaning.map((m) => [String(m.id), m.score]));
  const docs = await Blog.find({ _id: { $in: fused.map((f) => f.id) } })
    .select(FIELDS)
    .populate("createdBy", "fullName profilePic")
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const results = fused
    .filter((f) => byId.has(f.id))
    .map((f) => ({
      ...byId.get(f.id),
      matchedBy: f.sources,
      meaningScore: meaningScore.get(f.id) ?? null,
    }));

  const mode = meaning.length && (keywords.length || title.length) ? "hybrid" : meaning.length ? "semantic" : "text";
  return { results, mode };
}

module.exports = { hybridSearch };
