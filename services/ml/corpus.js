// Embeddings of published posts, cached in memory for a few minutes.
//
// Used when Atlas Vector Search isn't configured: search, tag suggestions and
// the originality check all need "posts nearest to this vector", and loading
// every embedding per request would be slow. Capped to the newest posts.
const Blog = require("../../models/blog");
const { cosine } = require("./vectors");

const TTL_MS = 5 * 60 * 1000;
const MAX_POSTS = 5000;
let corpus = null;
let corpusAt = 0;
let loading = null;

async function getCorpus() {
  if (corpus && Date.now() - corpusAt < TTL_MS) return corpus;
  if (!loading) {
    loading = Blog.find({ status: "published", embedding: { $exists: true, $ne: [] } })
      .sort({ createdAt: -1 })
      .limit(MAX_POSTS)
      .select("_id tags category createdBy +embedding")
      .lean()
      .then((docs) => {
        corpus = docs;
        corpusAt = Date.now();
        return docs;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

/** Nearest published posts to `vector`: [{ _id, score, tags, category, createdBy }]. */
async function nearest(vector, { limit = 10, minScore = 0, excludeIds = [] } = {}) {
  if (!Array.isArray(vector) || !vector.length) return [];
  const ex = new Set(excludeIds.map(String));
  const docs = await getCorpus();
  return docs
    .filter((d) => d.embedding.length === vector.length && !ex.has(String(d._id)))
    .map((d) => ({ _id: d._id, score: cosine(vector, d.embedding), tags: d.tags, category: d.category, createdBy: d.createdBy }))
    .filter((d) => d.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { getCorpus, nearest };

/** Same as nearest(), but via Atlas Vector Search when it's available. */
async function nearestPosts(vector, { limit = 10, minScore = 0, excludeIds = [] } = {}) {
  const { vectorSearchBlogs } = require("../vectorSearch");
  const viaIndex = await vectorSearchBlogs(vector, {
    limit,
    excludeIds: excludeIds.map(String),
    projection: { tags: 1, category: 1, createdBy: 1 },
  });
  if (viaIndex) {
    return viaIndex
      .filter((d) => d.score >= minScore)
      .map((d) => ({
        _id: d._id,
        score: d.score,
        tags: d.tags,
        category: d.category,
        createdBy: d.createdBy && d.createdBy._id ? d.createdBy._id : d.createdBy,
      }));
  }
  return nearest(vector, { limit, minScore, excludeIds });
}

module.exports.nearestPosts = nearestPosts;
