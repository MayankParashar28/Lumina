// 📈 Rising topics and tags this week.
//
// Activity per topic/tag = reads (from read signals) + new posts (weighted
// higher: someone wrote about it). This week is compared with the average of
// the four weeks before it (services/ml/trends.js decides what counts as a
// real rise). Cached for an hour — trends don't change minute to minute.
const Blog = require("../../models/blog");
const ReadEvent = require("../../models/readEvent");
const Topic = require("../../models/topic");
const { cache } = require("../redis");
const logger = require("../logger");
const { risingKeys, windowCounts } = require("./trends");
const { tagKey, normalizeTag } = require("./tagger");

const CACHE_KEY = "trends:v1";
const CACHE_SECONDS = 60 * 60;
const WINDOW_DAYS = 7;
const BASELINE_WINDOWS = 4;
const POST_WEIGHT = 3;

async function computeTrends({ now = Date.now() } = {}) {
  const since = new Date(now - WINDOW_DAYS * (1 + BASELINE_WINDOWS) * 864e5);

  // Reads, bucketed per post per day (keeps the event list small).
  const readBuckets = await ReadEvent.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { blogId: "$blogId", day: { $dateTrunc: { date: "$createdAt", unit: "day" } } },
        n: { $sum: 1 },
      },
    },
  ]);
  const posts = await Blog.find({ status: "published", createdAt: { $gte: since } })
    .select("topic tags createdAt")
    .lean();
  const readBlogIds = [...new Set(readBuckets.map((b) => String(b._id.blogId)))];
  const readBlogs = await Blog.find({ _id: { $in: readBlogIds } }).select("topic tags").lean();
  const meta = new Map(readBlogs.map((b) => [String(b._id), b]));

  const topicEvents = [];
  const tagEvents = [];
  const tagSpelling = new Map();
  const addTags = (tags, at, weight) => {
    const seen = new Set();
    for (const t of tags || []) {
      const k = tagKey(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (!tagSpelling.has(k)) tagSpelling.set(k, normalizeTag(t));
      tagEvents.push({ key: k, at, weight });
    }
  };

  for (const b of readBuckets) {
    const m = meta.get(String(b._id.blogId));
    if (!m) continue;
    if (m.topic) topicEvents.push({ key: String(m.topic), at: b._id.day, weight: b.n });
    addTags(m.tags, b._id.day, b.n);
  }
  for (const p of posts) {
    if (p.topic) topicEvents.push({ key: String(p.topic), at: p.createdAt, weight: POST_WEIGHT });
    addTags(p.tags, p.createdAt, POST_WEIGHT);
  }

  const opts = { now, windowDays: WINDOW_DAYS, baselineWindows: BASELINE_WINDOWS };
  const risingTopics = risingKeys(windowCounts(topicEvents, opts), { limit: 6 });
  const risingTags = risingKeys(windowCounts(tagEvents, opts), { limit: 8 });

  const topicDocs = await Topic.find({ _id: { $in: risingTopics.map((t) => t.key) } }).select("slug label").lean();
  const byId = new Map(topicDocs.map((t) => [String(t._id), t]));

  return {
    computedAt: new Date(now).toISOString(),
    topics: risingTopics
      .filter((t) => byId.has(t.key))
      .map((t) => ({ id: t.key, slug: byId.get(t.key).slug, label: byId.get(t.key).label, growth: t.growth, current: Math.round(t.current) })),
    tags: risingTags.map((t) => ({ tag: tagSpelling.get(t.key) || t.key, growth: t.growth, current: Math.round(t.current) })),
  };
}

async function getTrends() {
  try {
    const cached = await cache.get(CACHE_KEY);
    if (cached) return cached;
    const fresh = await computeTrends();
    await cache.set(CACHE_KEY, fresh, CACHE_SECONDS);
    return fresh;
  } catch (err) {
    logger.error("⚠️ Trends failed: %s", err.message);
    return { computedAt: null, topics: [], tags: [] };
  }
}

module.exports = { getTrends, computeTrends };
