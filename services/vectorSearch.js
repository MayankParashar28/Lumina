// 🔎 Phase-2 scaling: native k-NN via MongoDB Atlas Vector Search.
//
// Replaces the O(N) "load every embedding into Node and loop cosineSimilarity"
// pattern used by semantic search, recommendations and the vibe page. Atlas does
// the nearest-neighbour search in the database using an ANN index, so cost no
// longer grows with the number of posts.
//
// Fully fallback-safe: if the vector index doesn't exist yet (or the deployment
// isn't Atlas), `vectorSearchBlogs` returns null and callers keep using their
// existing in-memory cosine path. Create the index (see docs/SCALING.md) to turn
// the accelerated path on — no code change needed.
const mongoose = require("mongoose");
const logger = require("./logger");

// Name of the Atlas Vector Search index defined on blogs.embedding.
const VECTOR_INDEX = process.env.VECTOR_INDEX_NAME || "blog_vector_index";

/**
 * Nearest-neighbour search over published blog embeddings.
 * @param {number[]} queryVector
 * @param {object} opts
 * @param {number} opts.limit         how many results to return (default 12)
 * @param {number} opts.numCandidates ANN candidates to consider (default 150)
 * @param {string[]} opts.excludeIds  blog ids to drop from the results
 * @param {object} opts.projection    fields to return (embedding is always dropped)
 * @returns {Promise<Array|null>} lean docs with a raw-cosine `score`, or null to fall back
 */
async function vectorSearchBlogs(queryVector, {
  limit = 12,
  numCandidates = 150,
  excludeIds = [],
  projection = { title: 1, coverImageURL: 1, category: 1, createdBy: 1, readTime: 1, views: 1, createdAt: 1 },
} = {}) {
  if (!Array.isArray(queryVector) || queryVector.length === 0) return null;

  const Blog = mongoose.model("blog");
  const overFetch = limit + (excludeIds.length || 0) + 5; // room to drop excluded ids

  try {
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: "embedding",
          queryVector,
          numCandidates: Math.max(numCandidates, overFetch * 10),
          limit: overFetch,
          // `status` must be configured as a filter field in the index.
          filter: { status: { $eq: "published" } },
        },
      },
      // Atlas normalises cosine to (1 + cos)/2 ∈ [0,1]; convert back to raw cosine
      // so existing thresholds (> 0.3) and the match-% display stay consistent.
      { $addFields: { score: { $subtract: [{ $multiply: [{ $meta: "vectorSearchScore" }, 2] }, 1] } } },
      { $project: { ...projection, score: 1 } },
    ];

    let docs = await Blog.aggregate(pipeline);
    // A working vector index over a non-empty collection always returns nearest
    // neighbours, so an empty result means the index isn't available yet (some
    // Atlas setups return [] instead of erroring). Signal the caller to fall back.
    if (!Array.isArray(docs) || docs.length === 0) return null;

    if (excludeIds.length) {
      const ex = new Set(excludeIds.map(String));
      docs = docs.filter((d) => !ex.has(String(d._id)));
    }
    docs = docs.slice(0, limit);

    await Blog.populate(docs, { path: "createdBy", select: "fullName profilePic" });
    return docs;
  } catch (e) {
    // Index missing, not Atlas, or an older server → let the caller fall back.
    logger.warn("⚠️ Vector search unavailable, using in-memory cosine fallback:", e.message);
    return null;
  }
}

module.exports = { vectorSearchBlogs, VECTOR_INDEX };
