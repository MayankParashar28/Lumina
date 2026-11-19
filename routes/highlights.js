// 🖍️ Reader highlights and notes.
//
// Everything here is private to the signed-in reader: every query is scoped by
// userId, so one reader can never see, change or delete another's highlights.
const express = require("express");
const Highlight = require("../models/highlight");
const Blog = require("../models/blog");
const logger = require("../services/logger");
const { wantsJson } = require("../utils/http");

const router = express.Router();

const MAX_PER_POST = 200; // a generous cap so one post can't grow unbounded
const isId = (v) => /^[a-f\d]{24}$/i.test(String(v || ""));
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);

const toJson = (h) => ({
  _id: String(h._id),
  text: h.text,
  prefix: h.prefix || "",
  suffix: h.suffix || "",
  note: h.note || "",
  createdAt: h.createdAt,
});

// Everything below needs a signed-in reader.
router.use((req, res, next) => {
  if (req.user) return next();
  if (req.method === "GET" && !wantsJson(req)) return res.redirect("/user/signin");
  return res.status(401).json({ success: false, message: "Sign in to highlight." });
});

// 📄 My highlights: every highlight, grouped by post, newest post activity first.
router.get("/", async (req, res) => {
  try {
    const highlights = await Highlight.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    const blogIds = [...new Set(highlights.map((h) => String(h.blogId)))];
    const blogs = await Blog.find({ _id: { $in: blogIds } })
      .select("title slug coverImageURL createdBy status")
      .populate("createdBy", "fullName")
      .lean();
    const byId = new Map(blogs.map((b) => [String(b._id), b]));

    // Group in first-seen order, which is newest highlight first.
    const groups = [];
    const index = new Map();
    for (const h of highlights) {
      const key = String(h.blogId);
      const blog = byId.get(key);
      if (!blog) continue; // the post was deleted
      if (!index.has(key)) {
        index.set(key, groups.length);
        groups.push({ blog, highlights: [] });
      }
      groups[index.get(key)].highlights.push(h);
    }

    res.render("highlights", {
      title: "My Highlights - Lumina",
      groups,
      total: highlights.length,
      searchQuery: "",
    });
  } catch (err) {
    logger.error("❌ Highlights page error:", err);
    res.status(500).render("error", { message: "Could not load your highlights." });
  }
});

// The reader's highlights on one post (the post page restores them on load).
router.get("/blog/:blogId", async (req, res) => {
  if (!isId(req.params.blogId)) return res.status(400).json({ success: false, highlights: [] });
  try {
    const list = await Highlight.find({ userId: req.user._id, blogId: req.params.blogId })
      .sort({ createdAt: 1 })
      .limit(MAX_PER_POST)
      .lean();
    res.json({ success: true, highlights: list.map(toJson) });
  } catch (err) {
    logger.error("❌ Load highlights error:", err);
    res.status(500).json({ success: false, highlights: [] });
  }
});

// Create.
router.post("/", async (req, res) => {
  const { blogId } = req.body || {};
  const text = str(req.body && req.body.text, 1000).trim();
  if (!isId(blogId)) return res.status(400).json({ success: false, message: "Invalid post." });
  if (!text) return res.status(400).json({ success: false, message: "Select some text to highlight." });

  try {
    // Only posts the reader can actually read: published, or their own.
    const blog = await Blog.findOne({
      _id: blogId,
      $or: [{ status: "published" }, { createdBy: req.user._id }],
    }).select("_id").lean();
    if (!blog) return res.status(404).json({ success: false, message: "Post not found." });

    const count = await Highlight.countDocuments({ userId: req.user._id, blogId });
    if (count >= MAX_PER_POST) {
      return res.status(400).json({ success: false, message: "That's a lot of highlights — remove some to add more." });
    }

    const h = await Highlight.create({
      userId: req.user._id,
      blogId,
      text,
      prefix: str(req.body.prefix, 64),
      suffix: str(req.body.suffix, 64),
      note: str(req.body.note, 2000).trim(),
    });
    require("../services/unlocks").bust(req.user._id); // "Highlights" can appear in the menu now
    res.status(201).json({ success: true, highlight: toJson(h) });
  } catch (err) {
    logger.error("❌ Create highlight error:", err);
    res.status(500).json({ success: false, message: "Could not save the highlight." });
  }
});

// Edit the note.
router.patch("/:id", async (req, res) => {
  if (!isId(req.params.id)) return res.status(404).json({ success: false });
  try {
    const h = await Highlight.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { note: str(req.body && req.body.note, 2000).trim() } },
      { new: true }
    ).lean();
    if (!h) return res.status(404).json({ success: false, message: "Highlight not found." });
    res.json({ success: true, highlight: toJson(h) });
  } catch (err) {
    logger.error("❌ Update highlight error:", err);
    res.status(500).json({ success: false, message: "Could not save the note." });
  }
});

// Delete. POST /:id/delete exists for the no-JS form on the Highlights page.
async function remove(req, res) {
  const json = wantsJson(req);
  if (!isId(req.params.id)) return json ? res.status(404).json({ success: false }) : res.redirect("/highlights");
  try {
    const out = await Highlight.deleteOne({ _id: req.params.id, userId: req.user._id });
    if (json) {
      return out.deletedCount
        ? res.json({ success: true })
        : res.status(404).json({ success: false, message: "Highlight not found." });
    }
    return res.redirect("/highlights");
  } catch (err) {
    logger.error("❌ Delete highlight error:", err);
    return json ? res.status(500).json({ success: false }) : res.redirect("/highlights");
  }
}
router.delete("/:id", remove);
router.post("/:id/delete", remove);

module.exports = router;
