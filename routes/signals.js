// 📈 Reading signals: how long a post was read and how far.
//
//   POST /signals/read   { blogId, seconds, depth }
//
// Sent by public/javascript/read-tracker.js with navigator.sendBeacon when the
// reader leaves the page, so it can't carry a CSRF header. That is acceptable
// here: it only records reading statistics, the auth cookie is SameSite=Lax
// (so another site can't send it for a signed-in reader), the Origin is
// checked when present, values are clamped, and it is rate limited. It is
// mounted above the session layer so anonymous readers don't get a session.
const express = require("express");
const rateLimit = require("express-rate-limit");
const Blog = require("../models/blog");
const ReadEvent = require("../models/readEvent");
const logger = require("../services/logger");
const { isBot, viewerKey } = require("../services/viewCounter");
const { makeRateLimitStore } = require("../services/redis");

const router = express.Router();
const SESSION_MS = 30 * 60 * 1000; // one reading session per post per half hour
const OBJECT_ID = /^[a-f\d]{24}$/i;

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateLimitStore("rl:signals:"),
  handler: (req, res) => res.status(429).end(),
});

// sendBeacon posts a string as text/plain; fetch posts JSON. Accept both.
const parse = [express.json({ limit: "2kb" }), express.text({ limit: "2kb", type: "text/plain" })];

router.post("/read", limiter, parse, async (req, res) => {
  // Always 204: the page is gone by now and nothing reads the answer.
  res.status(204).end();
  try {
    if (isBot(req.get("user-agent"))) return;
    const origin = req.get("origin");
    if (origin && origin !== `${req.protocol}://${req.get("host")}`) return;

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (_) { return; }
    }
    if (!body || !OBJECT_ID.test(String(body.blogId))) return;
    const seconds = Math.max(0, Math.min(3600, Math.round(Number(body.seconds) || 0)));
    const depth = Math.max(0, Math.min(1, Number(body.depth) || 0));
    if (seconds < 2 && depth < 0.05) return; // a bounce before anything rendered

    const blog = await Blog.findOne({ _id: body.blogId, status: "published" }).select("createdBy").lean();
    if (!blog) return;
    const userId = req.user ? req.user._id : null;
    if (userId && String(userId) === String(blog.createdBy)) return; // authors reading their own post

    const viewer = viewerKey(req);
    const since = new Date(Date.now() - SESSION_MS);
    // Same session (refresh, coming back to the tab): keep the best values.
    const updated = await ReadEvent.findOneAndUpdate(
      { viewer, blogId: blog._id, createdAt: { $gte: since } },
      { $max: { seconds, depth }, $set: { updatedAt: new Date() } }
    ).select("_id").lean();
    if (updated) return;

    await ReadEvent.create({
      blogId: blog._id,
      authorId: blog.createdBy,
      userId,
      viewer,
      seconds,
      depth,
    });
  } catch (err) {
    logger.error("⚠️ Read signal failed: %s", err.message);
  }
});

module.exports = router;
