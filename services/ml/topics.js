// 🧭 Automatic topics: cluster posts by meaning and name the clusters.
//
// 1. Take the embeddings of published posts (same embedding model only).
// 2. Cluster them with k-means, choosing k by silhouette (services/ml/kmeans.js).
// 3. Name each cluster: Gemini, given each cluster's keywords and titles, when
//    configured; otherwise its dominant tag, or its top TF-IDF keyword.
// 4. Store topics and point each post at its topic.
//
// New posts join the nearest existing topic as soon as they are embedded
// (nearestTopicId), and the whole thing is rebuilt daily (ensureFresh).
const Blog = require("../../models/blog");
const Topic = require("../../models/topic");
const logger = require("../logger");
const { autoCluster } = require("./kmeans");
const { cosine } = require("./vectors");
const { groupKeywords } = require("./text");
const { labelFromCluster } = require("./tagger");
const { slugifyTitle } = require("../../utils/slug");

const MAX_POSTS = 5000;
const MIN_POSTS = 8; // fewer than this and "topics" would be noise
const REBUILD_AFTER_MS = 24 * 60 * 60 * 1000;

async function aiNames(clusters) {
  const { generateJson, aiEnabled } = require("../ai");
  if (!aiEnabled()) return null;
  const prompt =
    "You name topics for a blogging site. For each numbered group of blog posts below, " +
    "give a short topic name (1-3 words, Title Case, no emoji, distinct from the other names) " +
    "and a one-sentence description for readers.\n\n" +
    clusters
      .map(
        (c, i) =>
          `Group ${i}: keywords: ${c.keywords.join(", ") || "(none)"}\n` +
          c.posts.slice(0, 6).map((p) => `- ${p.title}`).join("\n")
      )
      .join("\n\n") +
    '\n\nReturn JSON: {"topics":[{"group":0,"name":"...","description":"..."}]}';
  const out = await generateJson(prompt, { timeoutMs: 30000 });
  if (!out || !Array.isArray(out.topics)) return null;
  const names = new Map();
  for (const t of out.topics) {
    if (Number.isInteger(t.group) && typeof t.name === "string" && t.name.trim()) {
      names.set(t.group, {
        name: t.name.trim().slice(0, 40),
        description: typeof t.description === "string" ? t.description.trim().slice(0, 200) : "",
      });
    }
  }
  return names;
}

let building = null;

async function buildTopics({ useAi = true } = {}) {
  if (building) return building; // one build at a time per process
  building = (async () => {
    const { EMBEDDING_MODEL_ID } = require("../ai");
    const started = Date.now();
    const posts = await Blog.find({
      status: "published",
      embedding: { $exists: true, $ne: [] },
      // Posts embedded before models were tracked have no embeddingModel; they
      // are used only if nothing has been embedded with the current model yet.
    })
      .sort({ createdAt: -1 })
      .limit(MAX_POSTS)
      .select("title tags embeddingModel +embedding")
      .lean();

    const current = posts.filter((p) => p.embeddingModel === EMBEDDING_MODEL_ID);
    let usable = current.length >= MIN_POSTS ? current : posts.filter((p) => !p.embeddingModel);
    // All vectors must have the same length to be comparable.
    if (usable.length) {
      const dim = usable[0].embedding.length;
      usable = usable.filter((p) => p.embedding.length === dim);
    }
    if (usable.length < MIN_POSTS) {
      logger.info("🧭 Topics: only %d embedded posts, need %d — skipping.", usable.length, MIN_POSTS);
      return { built: false, posts: usable.length };
    }

    const { labels, centroids, k, silhouette } = autoCluster(usable.map((p) => p.embedding));
    const clusters = centroids.map((centroid, i) => ({ centroid, posts: [], keywords: [] }));
    labels.forEach((l, i) => clusters[l].posts.push(usable[i]));
    const kept = clusters.filter((c) => c.posts.length >= 2);

    const keywords = groupKeywords(kept.map((c) => c.posts.map((p) => `${p.title} ${(p.tags || []).join(" ")}`)), { top: 5 });
    kept.forEach((c, i) => { c.keywords = keywords[i]; });

    const named = useAi ? await aiNames(kept) : null;
    const used = new Set();
    const slugs = new Set();
    const docs = [];
    kept.forEach((c, i) => {
      let label = named && named.get(i) ? named.get(i).name : null;
      if (!label || used.has(label.toLowerCase())) label = labelFromCluster(c.posts, c.keywords, used);
      if (!label) label = `Topic ${i + 1}`;
      used.add(label.toLowerCase());
      let slug = slugifyTitle(label) || `topic-${i + 1}`;
      for (let n = 2; slugs.has(slug); n++) slug = `${slugifyTitle(label)}-${n}`;
      slugs.add(slug);
      docs.push({
        slug,
        label,
        description: named && named.get(i) ? named.get(i).description : "",
        keywords: c.keywords,
        centroid: c.centroid,
        size: c.posts.length,
        embeddingModel: usable[0].embeddingModel || null,
        builtAt: new Date(),
        _posts: c.posts.map((p) => p._id),
      });
    });

    // Swap in the new topics. Old topic ids disappear, so every post is
    // re-pointed in the same pass.
    await Topic.deleteMany({});
    const inserted = await Topic.insertMany(docs.map(({ _posts, ...d }) => d));
    const ops = [];
    inserted.forEach((t, i) => {
      ops.push({ updateMany: { filter: { _id: { $in: docs[i]._posts } }, update: { $set: { topic: t._id } } } });
    });
    const assigned = docs.flatMap((d) => d._posts);
    ops.push({ updateMany: { filter: { topic: { $exists: true }, _id: { $nin: assigned } }, update: { $unset: { topic: "" } } } });
    await Blog.bulkWrite(ops, { ordered: false });
    centroidCache = null;

    logger.info(
      "🧭 Topics rebuilt: %d topics from %d posts (k=%d, silhouette %s) in %dms%s",
      inserted.length, usable.length, k, silhouette.toFixed(2), Date.now() - started, named ? " (AI-named)" : ""
    );
    return { built: true, topics: inserted.length, posts: usable.length, silhouette };
  })().finally(() => { building = null; });
  return building;
}

// Centroids are read on every new post; keep them in memory for a while.
let centroidCache = null;
let centroidCacheAt = 0;
async function centroids() {
  if (centroidCache && Date.now() - centroidCacheAt < 10 * 60 * 1000) return centroidCache;
  centroidCache = await Topic.find({}).select("+centroid").lean();
  centroidCacheAt = Date.now();
  return centroidCache;
}

async function nearestTopicId(embedding, { minSimilarity = 0.3 } = {}) {
  if (!Array.isArray(embedding) || !embedding.length) return null;
  const topics = await centroids();
  let best = null;
  let bestSim = minSimilarity;
  for (const t of topics) {
    const s = cosine(embedding, t.centroid || []);
    if (s > bestSim) { bestSim = s; best = t._id; }
  }
  return best;
}

// Rebuild when topics are missing or a day old. Cheap to call often.
async function ensureFresh() {
  const latest = await Topic.findOne({}).sort({ builtAt: -1 }).select("builtAt").lean();
  if (latest && Date.now() - new Date(latest.builtAt).getTime() < REBUILD_AFTER_MS) return { built: false, fresh: true };
  return buildTopics();
}

module.exports = { buildTopics, ensureFresh, nearestTopicId, labelFromCluster };
