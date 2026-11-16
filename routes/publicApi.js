// 🌐 Public, read-only API for embedding an author's latest posts elsewhere.
//
//   GET /api/author/:id/latest.json?limit=5
//
// Anyone may call it from any site (CORS *), so it returns only what the
// author's public profile already shows: name, avatar, bio, and published
// posts. No cookies are read or set — it is mounted before the session layer.
const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../models/user");
const Blog = require("../models/blog");
const logger = require("../services/logger");
const { makeRateLimitStore } = require("../services/redis");
const { stripTags } = require("../utils/sanitize");

const router = express.Router();

const MAX_LIMIT = 10;
const OBJECT_ID = /^[a-f\d]{24}$/i;

const origin = (req) =>
  (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

// Absolute URLs only: the consumer is another site.
const absolute = (base, url) => (!url ? null : /^https?:\/\//i.test(url) ? url : base + (url.startsWith("/") ? url : "/" + url));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateLimitStore("rl:public-api:"),
  handler: (req, res) => res.status(429).json({ error: "Too many requests. Try again in a minute." }),
});

router.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

router.get("/author/:id/latest.json", apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!OBJECT_ID.test(id)) return res.status(404).json({ error: "Author not found." });
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 5));

  try {
    const [author, posts] = await Promise.all([
      User.findById(id).select("fullName profilePic bio").lean(),
      Blog.find({ createdBy: id, status: "published" })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("title slug body metaDescription coverImageURL createdAt readTime category")
        .lean(),
    ]);
    if (!author) return res.status(404).json({ error: "Author not found." });

    const base = origin(req);
    const excerptOf = (p) => {
      const text = (p.metaDescription || stripTags(p.body || "")).replace(/\s+/g, " ").trim();
      return text.length > 160 ? text.slice(0, 157).trimEnd() + "…" : text;
    };

    res.set("Cache-Control", "public, max-age=300, s-maxage=300");
    return res.json({
      author: {
        id: String(author._id),
        name: author.fullName,
        bio: author.bio || "",
        avatar: absolute(base, author.profilePic) || `${base}/images/default-user.png`,
        url: `${base}/user/profile/${author._id}`,
      },
      posts: posts.map((p) => ({
        title: p.title,
        url: `${base}/blog/${p.slug || p._id}`,
        excerpt: excerptOf(p),
        coverImage: absolute(base, p.coverImageURL),
        category: p.category || null,
        readTime: p.readTime || null,
        publishedAt: p.createdAt,
      })),
      site: { name: "Lumina", url: base },
    });
  } catch (err) {
    logger.error("❌ Public author API error:", err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

router.use((req, res) => res.status(404).json({ error: "Not found." }));

module.exports = router;
