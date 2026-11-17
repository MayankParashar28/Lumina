// Loads one reader's signals and the candidate posts, then ranks them with
// services/ml/forYou.js. Returns populated posts with a `reason`, or null when
// there is nothing to learn from yet (the caller shows the normal feed).
const Blog = require("../../models/blog");
const ReadEvent = require("../../models/readEvent");
const Highlight = require("../../models/highlight");
const logger = require("../logger");
const { vectorSearchBlogs } = require("../vectorSearch");
const { signalWeights, rankForYou } = require("./forYou");
const { weightedCentroid } = require("./vectors");

const WINDOW_DAYS = 120;
const CANDIDATE_DAYS = 120;
const MAX_CANDIDATES = 2000;

async function recommendForUser(user, { limit = 10 } = {}) {
  try {
    const uid = user._id;
    const since = new Date(Date.now() - WINDOW_DAYS * 864e5);
    const [reads, highlights, liked] = await Promise.all([
      ReadEvent.find({ userId: uid, createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(300)
        .select("blogId seconds depth createdAt")
        .lean(),
      Highlight.aggregate([
        { $match: { userId: uid, createdAt: { $gte: since } } },
        { $group: { _id: "$blogId", at: { $max: "$createdAt" } } },
      ]),
      Blog.find({ likedBy: String(uid), status: "published" }).sort({ createdAt: -1 }).limit(100).select("_id").lean(),
    ]);

    const signals = [
      ...reads.map((r) => ({ blogId: r.blogId, kind: "read", at: r.createdAt, seconds: r.seconds, depth: r.depth })),
      ...highlights.map((h) => ({ blogId: h._id, kind: "highlight", at: h.at })),
      ...liked.map((b) => ({ blogId: b._id, kind: "like" })),
      ...(user.bookmarks || []).map((id) => ({ blogId: id, kind: "bookmark" })),
      ...(user.readingHistory || []).map((h) => ({ blogId: h.blogId, kind: "history", at: h.viewedAt })),
    ].filter((s) => s.blogId);
    if (!signals.length) return null;

    const signalIds = [...new Set(signals.map((s) => String(s.blogId)))];
    const signalDocs = await Blog.find({ _id: { $in: signalIds } }).select("title readTime +embedding").lean();
    const readTime = new Map(signalDocs.map((d) => [String(d._id), d.readTime]));
    signals.forEach((s) => { if (s.kind === "read") s.readTime = readTime.get(String(s.blogId)); });
    const signalPosts = new Map(
      signalDocs
        .filter((d) => Array.isArray(d.embedding) && d.embedding.length)
        .map((d) => [String(d._id), { vector: d.embedding, title: d.title }])
    );
    if (!signalPosts.size) return null;

    const weights = signalWeights(signals);
    // Already read properly (or the reader's own posts) — don't recommend again.
    const exclude = new Set(
      reads.filter((r) => r.depth >= 0.6 || r.seconds >= 120).map((r) => String(r.blogId))
    );
    (user.readingHistory || []).forEach((h) => exclude.add(String(h.blogId)));

    // Candidates: nearest by taste when Atlas Vector Search is available,
    // otherwise recent published posts.
    const taste = weightedCentroid(weights.map((w) => ({ vector: (signalPosts.get(w.blogId) || {}).vector, weight: w.weight })));
    let candidateIds = null;
    if (taste) {
      const nearest = await vectorSearchBlogs(taste, { limit: 80, excludeIds: [...exclude], projection: { _id: 1 } });
      if (nearest) candidateIds = nearest.map((d) => d._id);
    }
    const candidateFilter = candidateIds
      ? { _id: { $in: candidateIds } }
      : {
          status: "published",
          createdAt: { $gte: new Date(Date.now() - CANDIDATE_DAYS * 864e5) },
          embedding: { $exists: true, $ne: [] },
        };
    const candidates = await Blog.find({ ...candidateFilter, createdBy: { $ne: uid } })
      .sort({ createdAt: -1 })
      .limit(MAX_CANDIDATES)
      .select("createdAt views createdBy +embedding")
      .populate("createdBy", "fullName")
      .lean();

    const ranked = rankForYou({
      weights,
      signalPosts,
      candidates: candidates.map((c) => ({
        _id: c._id,
        vector: c.embedding,
        createdAt: c.createdAt,
        views: c.views,
        authorId: c.createdBy && c.createdBy._id,
        authorName: c.createdBy && c.createdBy.fullName,
      })),
      following: new Set((user.following || []).map(String)),
      exclude,
      limit,
    });
    if (!ranked.length) return null;

    const docs = await Blog.find({ _id: { $in: ranked.map((r) => r._id) } })
      .select("-body")
      .populate("createdBy", "fullName profilePic")
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ranked
      .filter((r) => byId.has(String(r._id)))
      .map((r) => ({ ...byId.get(String(r._id)), score: r.score, reason: r.reason }));
  } catch (err) {
    logger.error("⚠️ For-you ranking failed: %s", err.message);
    return null;
  }
}

module.exports = { recommendForUser };
