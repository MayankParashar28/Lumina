// 🧭 Topic pages: automatic topics found by clustering posts (services/ml/topics.js).
//
//   GET /topics          all topics, biggest first, rising ones marked
//   GET /topics/:slug    the posts in one topic, newest first
const express = require("express");
const moment = require("moment");
const Blog = require("../models/blog");
const Topic = require("../models/topic");
const logger = require("../services/logger");
const { getTrends } = require("../services/ml/trendService");

const router = express.Router();
const PAGE_SIZE = 12;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

router.get("/", async (req, res) => {
  try {
    const [topics, trends] = await Promise.all([
      Topic.find({}).sort({ size: -1 }).limit(60).lean(),
      getTrends(),
    ]);
    // A few recent titles per topic, so a topic is recognisable at a glance.
    const samples = await Blog.aggregate([
      { $match: { status: "published", topic: { $in: topics.map((t) => t._id) } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$topic", posts: { $push: { title: "$title", slug: "$slug", id: "$_id" } } } },
      { $project: { posts: { $slice: ["$posts", 3] } } },
    ]);
    const sampleBy = new Map(samples.map((s) => [String(s._id), s.posts]));
    const rising = new Map((trends.topics || []).map((t) => [String(t.id), t]));

    res.render("topics", {
      title: "Topics - Lumina",
      metaDescription: "Browse Lumina by topic — groups of stories about the same thing, found automatically.",
      topics: topics.map((t) => ({ ...t, samples: sampleBy.get(String(t._id)) || [], rising: rising.get(String(t._id)) || null })),
      risingTags: trends.tags || [],
      searchQuery: "",
    });
  } catch (err) {
    logger.error("❌ Topics page error:", err);
    res.status(500).render("error", { message: "Could not load topics." });
  }
});

router.get("/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").toLowerCase();
  if (!SLUG_RE.test(slug)) return next(); // the app's 404 page
  try {
    const topic = await Topic.findOne({ slug }).lean();
    if (!topic) return next();

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [blogs, total, trends] = await Promise.all([
      Blog.find({ status: "published", topic: topic._id })
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .select("title slug coverImageURL category createdBy readTime views createdAt metaDescription")
        .populate("createdBy", "fullName profilePic")
        .lean(),
      Blog.countDocuments({ status: "published", topic: topic._id }),
      getTrends(),
    ]);
    const rising = (trends.topics || []).find((t) => String(t.id) === String(topic._id)) || null;

    res.render("topic", {
      title: `${topic.label} - Lumina`,
      metaDescription: topic.description || `Stories about ${topic.label} on Lumina.`,
      topic,
      rising,
      blogs,
      page,
      hasMore: page * PAGE_SIZE < total,
      total,
      moment,
      searchQuery: "",
    });
  } catch (err) {
    logger.error("❌ Topic page error:", err);
    res.status(500).render("error", { message: "Could not load this topic." });
  }
});

module.exports = router;
