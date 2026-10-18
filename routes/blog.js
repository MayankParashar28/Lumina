const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const moment = require("moment"); // Ensure moment is imported
const User = require("../models/user");
const Comment = require("../models/comment");
const Blog = require("../models/blog");
const marked = require("marked");
const { error } = require("console");
const Notification = require("../models/Notification");
const moderateContent = require("../utils/moderator"); // Hybrid Moderation
const { response } = require("express");

const dotenv = require("dotenv");
dotenv.config();

const axios = require("axios"); // Import Axios for GIPHY Proxy

const { generateEmbedding, cosineSimilarity } = require("../services/ai"); // Import AI Service
const { vectorSearchBlogs } = require("../services/vectorSearch"); // Phase-2: Atlas kNN (falls back to cosine)
const { enqueue } = require("../services/queue"); // Phase-4: background jobs (falls back to inline)
const pageCache = require("../services/pageCache"); // micro-cache for anon public pages
const logger = require("../services/logger"); // Structured Logging
const rateLimit = require("express-rate-limit");

const router = Router();

// 💬 @mentions: notify people mentioned in a comment. Matches @name against the
// thread's participants (blog author + commenters) by first name or full name,
// so it works without a dedicated username field.
async function notifyMentions(content, blog, author, req) {
  try {
    const handles = [...new Set((String(content).match(/@([a-zA-Z0-9_]+)/g) || [])
      .map(m => m.slice(1).toLowerCase()))];
    if (handles.length === 0) return;

    const commenterIds = await Comment.distinct("createdBy", { blogId: blog._id });
    const ids = [...new Set([blog.createdBy.toString(), ...commenterIds.map(String)])];
    const participants = await User.find({ _id: { $in: ids } }).select("fullName").lean();

    const io = req.app.get("io");
    for (const p of participants) {
      if (p._id.toString() === author._id.toString()) continue; // don't notify yourself
      const full = (p.fullName || "").toLowerCase().replace(/\s+/g, "");
      const first = (p.fullName || "").toLowerCase().split(/\s+/)[0];
      if (!handles.some(h => h === full || h === first)) continue;

      await Notification.create({
        userId: p._id,
        senderId: author._id,
        type: "mention",
        message: `${author.fullName} mentioned you in a comment.`,
        blogId: blog._id,
        targetUrl: `/blog/${blog._id}`,
        read: false,
        createdAt: new Date(),
      });
      if (io) io.to(`user:${p._id}`).emit("new_notification", { message: `${author.fullName} mentioned you in a comment.` });
    }
  } catch (err) {
    logger.error("⚠️ Mention notification error:", err.message);
  }
}

// Rate Limiters
// Rate-limit counters live in Redis when enabled, so limits hold across all app
// instances (memory stores reset per-process and let bursts through at scale).
const { makeRateLimitStore } = require("../services/redis");

const blogLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 blogs per hour
  message: "Too many blogs created from this IP, please try again after an hour",
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateLimitStore("rl:blog:"),
});

const commentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 comments
  message: "Too many comments from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateLimitStore("rl:comment:"),
});

const { storage, cloudinary, upload } = require("../config/cloudConfig");
// upload is pre-configured with 5MB limit and MIME type validation

// 👁️ Preview Blog
// Draft data is submitted via POST, stashed in the session, then rendered via a
// GET redirect. This way the preview works whether it opens in a new tab or
// navigates in place, and a stray GET /blog/preview no longer collides with the
// /blog/:id route (which would throw "Invalid Blog ID").
function renderPreview(req, res, data) {
  const mockBlog = {
    _id: "preview-id",
    title: data.title || "[Untitled Story]",
    body: data.body || "<p>Start writing your story...</p>",
    coverImageURL: data.aiCoverURL || data.coverImage || "",
    createdBy: req.user,
    createdAt: new Date(),
    views: 0,
    tags: [],
    category: "Preview",
    readTime: 1,
    likes: 0,
    likedBy: [],
    comments: []
  };

  return res.render("blog", {
    title: mockBlog.title,
    metaDescription: "Preview Mode",
    ogImage: mockBlog.coverImageURL,
    user: req.user || null,
    blog: mockBlog,
    comments: [],
    isAuthenticated: !!req.user,
    searchQuery: "",
    moment: require("moment"),
    createdByName: req.user ? req.user.fullName : "Author",
    createdByProfilePic: req.user ? req.user.profilePic : "https://api.dicebear.com/7.x/initials/svg?seed=Author",
    formattedDate: "Just now",
    isBookmarked: false,
    relatedBlogs: [],
    isPreview: true,
    previewReturnTo: (data.from === "edit" && data.editId) ? `/blog/edit/${data.editId}` : "/blog/add-new"
  });
}

router.post("/preview", (req, res) => {
  try {
    const { title, body, aiCoverURL, coverImage, from, editId } = req.body;
    req.session.previewData = { title, body, aiCoverURL, coverImage, from, editId };
    // Persist the session BEFORE redirecting — the store is async, and the
    // browser follows the 303 immediately, so without this the GET can arrive
    // before the write lands and see no preview data.
    req.session.save((err) => {
      if (err) {
        logger.error("Preview session save error:", err);
        req.flash("error", "Generating preview failed. Please try again.");
        return res.redirect("back");
      }
      return res.redirect(303, "/blog/preview");
    });
  } catch (err) {
    logger.error("Preview Error:", err);
    req.flash("error", "Generating preview failed. Please try again.");
    return res.redirect("back");
  }
});

router.get("/preview", (req, res) => {
  try {
    const data = req.session.previewData;
    if (!data) {
      req.flash("error", "No preview to show — write your story, then hit Preview.");
      return res.redirect("/blog/add-new");
    }
    return renderPreview(req, res, data);
  } catch (err) {
    logger.error("Preview Error:", err);
    return res.redirect("/blog/add-new");
  }
});

// 📝 Create a Blog (GET Form)
router.get("/add-new", async (req, res) => {
  try {
    if (!req.user) return res.redirect("/user/signin");

    // Check cooldown for adding blogs
    const BLOG_COOLDOWN = 30 * 60 * 1000; // 30 minutes
    const lastBlog = await Blog.findOne({ createdBy: req.user._id })
      .sort({ createdAt: -1 })
      .select("createdAt");

    if (lastBlog && req.user.role !== "ADMIN") {
      const timeSinceLastBlog = new Date() - new Date(lastBlog.createdAt);
      if (timeSinceLastBlog < BLOG_COOLDOWN) {
        const remainingMinutes = Math.ceil((BLOG_COOLDOWN - timeSinceLastBlog) / 60000);
        req.flash("error", `Please wait ${remainingMinutes} minutes before posting another blog.`);
        return res.redirect("/");
      }
    }

    return res.render("addBlog", {
      user: req.user || null,
      searchQuery: req.query.search || "",
    });
  } catch (err) {
    logger.error("Error rendering addBlog:", err);
    res.redirect("/");
  }
});

// 📄 View Drafts
router.get("/drafts", async (req, res) => {
  if (!req.user) return res.redirect("/user/signin");

  try {
    const drafts = await Blog.find({
      createdBy: req.user._id,
      status: { $in: ["draft", "scheduled"] }
    }).select("-body").sort({ createdAt: -1 }).lean();

    res.render("drafts", {
      user: req.user,
      blogs: drafts,
      path: "/blog/drafts"
    });
  } catch (err) {
    logger.error("Error fetching drafts:", err);
    res.redirect("/");
  }
});

// 🔍 Semantic search — ranks posts by meaning (query embedding × post embeddings),
// with a text-search fallback. Must be defined BEFORE the "/:id" route.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  try {
    if (!q) {
      return res.render("search", { user: req.user, query: "", results: [], mode: null, moment });
    }

    let results = [];
    let mode = "semantic";

    // 1) Semantic ranking via embeddings
    const queryEmbedding = await generateEmbedding(q);
    if (queryEmbedding && queryEmbedding.length > 0) {
      // Preferred: native Atlas Vector Search (scales with content size).
      const viaVector = await vectorSearchBlogs(queryEmbedding, { limit: 12 });
      if (viaVector) {
        results = viaVector.filter(r => r.score > 0.3);
      } else {
        // Fallback: in-memory cosine over all embeddings (fine at small scale).
        const candidates = await Blog.find({
          status: "published",
          embedding: { $exists: true, $ne: [] }
        })
          .select("title coverImageURL category createdBy readTime views createdAt +embedding")
          .populate("createdBy", "fullName profilePic")
          .lean();

        results = candidates
          .map(b => {
            const score = cosineSimilarity(queryEmbedding, b.embedding);
            const { embedding, ...clean } = b;
            return { ...clean, score };
          })
          .filter(r => r.score > 0.3)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
      }
    }

    // 2) Fallback to MongoDB text search if semantic found nothing
    if (results.length === 0) {
      mode = "text";
      results = await Blog.find(
        { $text: { $search: q }, status: "published" },
        { score: { $meta: "textScore" } }
      )
        .select("title coverImageURL category createdBy readTime views createdAt")
        .populate("createdBy", "fullName profilePic")
        .sort({ score: { $meta: "textScore" } })
        .limit(12)
        .lean();
    }

    return res.render("search", { user: req.user, query: q, results, mode, moment });
  } catch (err) {
    logger.error("❌ Search error:", err);
    return res.render("search", { user: req.user, query: q, results: [], mode: null, moment });
  }
});

//  show blog
router.get("/:id", async (req, res) => {
  const mongoose = require("mongoose");
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).render("error", { message: "Invalid Blog ID." });
  }
  try {
    // 🔥 Atomic Update: Increment view count without locking document
    // We use findByIdAndUpdate to get the document AND update it in one go.
    // { new: true } return the updated doc, { upsert: false } ensures we don't create one.
    const blog = await Blog.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    ).populate("createdBy", "fullName profilePic");

    if (!blog) {
      return res.status(404).render("error", { message: "Blog not found." });
    }

    // 🔒 Private Blog Access Control
    if (blog.status === "private") {
      let isAllowed = false;
      if (req.user) {
        if (req.user.role === "ADMIN") isAllowed = true;
        if (blog.createdBy && blog.createdBy._id.toString() === req.user._id.toString()) isAllowed = true;
      }

      if (!isAllowed) {
        return res.status(404).render("404"); // Hide existence from others
      }
    }

    // Legacy code removal:
    // blog.views += 1;
    // await blog.save();

    // Fetch comments (All comments for this blog)
    const allComments = await Comment.find({ blogId: req.params.id })
      .populate("createdBy", "fullName profilePic")
      .lean();

    // 🧵 Build Thread Tree
    const commentMap = {};
    const comments = []; // Top-level roots

    // Initialize Map
    allComments.forEach(c => {
      c.children = [];
      commentMap[c._id.toString()] = c;
    });

    // Link Children to Parents
    allComments.forEach(c => {
      if (c.parentId) {
        const parent = commentMap[c.parentId.toString()];
        if (parent) {
          parent.children.push(c);
        }
      } else {
        comments.push(c); // Is Root
      }
    });

    // ⚡ Sort: Author > Pinned > Newest
    const authorId = blog.createdBy ? blog.createdBy._id.toString() : null;

    // Recursive Sort Function
    const sortComments = (list) => {
      list.sort((a, b) => {
        // 1. Author (Always First)
        if (authorId) {
          const aIsAuthor = a.createdBy && a.createdBy._id.toString() === authorId;
          const bIsAuthor = b.createdBy && b.createdBy._id.toString() === authorId;

          if (aIsAuthor && !bIsAuthor) return -1;
          if (!aIsAuthor && bIsAuthor) return 1;
        }

        // 2. Pinned
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;

        // 3. Newest First
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      // Recursively sort children
      list.forEach(c => {
        if (c.children.length > 0) sortComments(c.children);
      });
    };

    sortComments(comments);

    // Check if bookmarked & Track History
    let isBookmarked = false;
    if (req.user) {
      const user = await User.findById(req.user._id);
      if (user) {
        const bookmarkIds = user.bookmarks.map(id => id.toString());
        if (bookmarkIds.includes(req.params.id)) {
          isBookmarked = true;
        }

        // 🕵️‍♂️ Track Reading History
        try {
          // Remove existing entry for this blog to avoid duplicates
          user.readingHistory = user.readingHistory.filter(h => h.blogId.toString() !== req.params.id);
          // Add new entry at end
          user.readingHistory.push({
            blogId: req.params.id,
            viewedAt: new Date()
          });
          // Limit history size
          if (user.readingHistory.length > 20) {
            user.readingHistory.shift();
          }
          await user.save();
        } catch (histError) {
          logger.error("⚠️ Failed to track history:", histError);
        }
      }
    }

    // SEO: Generate Meta Description
    const plainText = blog.body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const metaDescription = plainText.length > 150 ? plainText.substring(0, 150) + "..." : plainText;

    return res.render("blog", {
      title: blog.title,
      metaDescription: metaDescription,
      ogImage: blog.coverImageURL,
      user: req.user || null,
      blog,
      comments,
      isAuthenticated: !!req.user,
      searchQuery: "",
      moment,
      createdByName: blog.createdBy ? blog.createdBy.fullName : "Unknown User",
      createdByProfilePic: blog.createdBy ? blog.createdBy.profilePic : "https://api.dicebear.com/7.x/initials/svg?seed=Unknown",
      formattedDate: moment(blog.createdAt).fromNow(),
      isBookmarked,
      relatedBlogs: [],
    });

  } catch (err) {
    logger.error("❌ Error fetching blog:", { error: err.message, stack: err.stack });
    return res.status(500).render("error", { message: "An error occurred while fetching the blog." });
  }
});

// 🤖 AI Recommendations API
router.get("/recommendations/:id", async (req, res) => {
  try {
    // 🛡️ Handle Preview Mode (No DB ID)
    if (req.params.id === "preview-id") {
      return res.json({ blogs: [] });
    }

    const currentBlog = await Blog.findById(req.params.id).select("+embedding");

    // Fallback if no embedding
    if (!currentBlog || !currentBlog.embedding || currentBlog.embedding.length === 0) {
      const fallback = await Blog.find({ _id: { $ne: req.params.id }, status: "published" })
        .select("title coverImageURL category createdBy readTime views createdAt")
        .populate("createdBy", "fullName profilePic")
        .limit(3)
        .lean();
      return res.json({ blogs: fallback });
    }

    // Preferred: native Atlas Vector Search (scales with content size).
    const viaVector = await vectorSearchBlogs(currentBlog.embedding, {
      limit: 3,
      excludeIds: [req.params.id],
    });
    if (viaVector) {
      return res.json({ blogs: viaVector });
    }

    // Fallback: in-memory cosine over all embeddings.
    const allBlogs = await Blog.find({
      _id: { $ne: req.params.id },
      status: "published",
      embedding: { $exists: true, $ne: [] }
    })
      .select("title coverImageURL category createdBy readTime +embedding createdAt")
      .populate("createdBy", "fullName profilePic")
      .lean();

    // Calculate similarities & strip out heavy vector array before sending JSON response
    const scoredBlogs = allBlogs.map(blog => {
      const score = cosineSimilarity(currentBlog.embedding, blog.embedding);
      const { embedding, ...cleanBlog } = blog;
      return { ...cleanBlog, score };
    });

    // Sort by score desc and take top 3
    scoredBlogs.sort((a, b) => b.score - a.score);
    const recommended = scoredBlogs.slice(0, 3);

    res.json({ blogs: recommended });

  } catch (error) {
    logger.error("❌ Recommendation Error:", error);
    res.status(500).json({ error: "Failed to fetch recommendations" });
  }
});

//bookmark a blog
router.post("/bookmark/:blogId", async (req, res) => {
  const mongoose = require("mongoose");
  if (!mongoose.Types.ObjectId.isValid(req.params.blogId)) {
    return res.status(400).json({ success: false, message: "Invalid Blog ID." });
  }
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const user = await User.findById(req.user._id);
    const blogId = req.params.blogId;

    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (user.bookmarks.includes(blogId)) {
      user.bookmarks = user.bookmarks.filter(id => id.toString() !== blogId);
      await user.save();
      return res.json({ success: true, bookmarked: false });
    } else {
      user.bookmarks.push(blogId);
      await user.save();
      return res.json({ success: true, bookmarked: true });
    }
  } catch (error) {
    logger.error("❌ Bookmarking Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Like or Dislike a Blog Post
router.post("/like/:blogId", async (req, res) => {
  const mongoose = require("mongoose");
  if (!mongoose.Types.ObjectId.isValid(req.params.blogId)) {
    return res.status(400).json({ success: false, message: "Invalid Blog ID." });
  }
  if (!req.user) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.redirect("/login");
    }
    return res.status(401).json({ success: false, message: "Please log in to like a blog." });
  }

  try {
    const blog = await Blog.findById(req.params.blogId).populate("createdBy", "fullName profilePic");
    if (!blog) return res.status(404).json({ success: false, message: "Blog not found" });

    const userId = req.user._id.toString();
    const likedIndex = blog.likedBy.indexOf(userId);
    const isNewLike = likedIndex === -1;

    // Toggle like
    isNewLike ? blog.likedBy.push(userId) : blog.likedBy.splice(likedIndex, 1);
    blog.likes = blog.likedBy.length;
    await blog.save();

    // Send notification if another user liked/unliked
    if (isNewLike && blog.createdBy && blog.createdBy._id.toString() !== userId) {
      await Notification.create({
        userId: blog.createdBy._id.toString(),
        senderId: userId,
        message: `${req.user.fullName} ${isNewLike ? "liked" : "unliked"} your blog.`,
        type: "like",
        blogId: blog._id, // Deep Link Support
        targetUrl: `/blog/${blog._id}`, // 🎯 Deep Link
        read: false,
        createdAt: new Date(),
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${blog.createdBy._id}`).emit("new_notification", {
          message: `${req.user.fullName} ${isNewLike ? "liked" : "unliked"} your blog.`
        });
      }
    }

    res.json({ success: true, liked: isNewLike, likes: blog.likes });

  } catch (error) {
    logger.error("❌ Error in liking blog:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Comment on a Blog
router.post("/comment/:blogId", commentLimiter, async (req, res) => {
  const COMMENT_COOLDOWN = 5 * 60 * 1000; // 5 minutes in milliseconds
  try {
    // 🔒 Require authentication before touching req.user
    if (!req.user) {
      if (req.xhr || (req.headers.accept && req.headers.accept.includes("json"))) {
        return res.status(401).json({ error: "Please sign in to comment." });
      }
      req.flash("error", "Please sign in to comment.");
      return res.redirect("/user/signin");
    }

    // 🛡️ Moderation Check
    const moderation = await moderateContent(req.body.content, { userId: req.user._id, ip: req.ip });
    if (!moderation.safe) {
      if (req.xhr || req.headers.accept.includes('json')) {
        return res.status(400).json({ error: `Comment Rejected: ${moderation.reason}` });
      }
      // Standard Form Fallback
      req.flash("error", `Comment Rejected: ${moderation.reason}`);
      return res.redirect("back");
    }

    const blog = await Blog.findById(req.params.blogId);
    if (!blog) {
      req.flash("error", "Blog not found.");
      return res.redirect("back");
    }

    const userId = req.user._id;

    // ✅ Check last comment time of this user
    const lastComment = await Comment.findOne({ createdBy: userId })
      .sort({ createdAt: -1 }) // Get the latest comment
      .select("createdAt");

    if (lastComment && req.user.role !== "ADMIN") {
      const timeSinceLastComment = new Date() - new Date(lastComment.createdAt);
      if (timeSinceLastComment < COMMENT_COOLDOWN) {
        req.flash("error", `Please wait ${Math.ceil((COMMENT_COOLDOWN - timeSinceLastComment) / 60000)}m before commenting again.`);
        return res.redirect(`/blog/${req.params.blogId}`);
      }
    }

    // ✅ Create the comment
    const comment = await Comment.create({
      content: req.body.content,
      blogId: req.params.blogId,
      createdBy: userId,
      createdAt: new Date(),
    });

    // 💬 Notify anyone @mentioned in the comment
    notifyMentions(req.body.content, blog, req.user, req);

    // ✅ Send Notification (if not the owner commenting)
    // ✅ Send Notification (Async/Non-blocking)
    if (blog.createdBy.toString() !== userId.toString()) {
      // We don't await this so the user response isn't delayed
      Notification.create({
        userId: blog.createdBy,
        senderId: userId,
        message: `${req.user.fullName} commented ${comment.content ? `: "${comment.content}"` : ""} on your blog.`,
        type: "comment",
        blogId: blog._id, // Deep Link Support
        targetUrl: `/blog/${blog._id}#comment-${comment._id}`, // 🎯 Deep Link
        read: false,
        createdAt: new Date(),
      }).then(() => {
        const io = req.app.get("io");
        if (io) {
          io.to(`user:${blog.createdBy}`).emit("new_notification", {
            message: `${req.user.fullName} commented on your blog.`
          });
        }
        }).catch(err => logger.error("⚠️ Notification Error:", err));
    }

    // 🔴 Real-time Update: Emit new root comment
    const io = req.app.get("io");
    if (io) {
      const populatedComment = await Comment.findById(comment._id).populate("createdBy", "fullName profilePic");

      // A new comment changes the blog page — drop its cached copy.
      pageCache.bustBlog(req.params.blogId);

      // Render the partial to a string
      res.render("partials/comment-thread", {
        comment: populatedComment,
        user: req.user,
        blog: blog,
        moment: require("moment")
      }, (err, html) => {
        if (!err) {
          io.to(`blog:${req.params.blogId}`).emit("new_comment", {
            html: html,
            parentId: null,
            commentId: comment._id
          });
        } else {
          logger.error("❌ EJS Render Error:", err);
        }
      });
    }

    req.flash("success", "Comment added successfully!");
    return res.redirect(`/blog/${req.params.blogId}`);
  } catch (error) {
    logger.error("❌ Error adding comment:", { error: error.message, stack: error.stack });
    req.flash("error", "Something went wrong. Try again.");
    return res.redirect("back");
  }
});

// 🗑️ Delete a Comment
router.post("/comment/delete/:commentId", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const comment = await Comment.findById(req.params.commentId).populate("blogId");
    if (!comment) {
      req.flash("error", "Comment not found.");
      return res.redirect("back");
    }

    // Check Authorization: User must be Comment Author OR Blog Owner
    const isAuthor = comment.createdBy.toString() === req.user._id.toString();
    const isBlogOwner = comment.blogId.createdBy.toString() === req.user._id.toString();

    if (!isAuthor && !isBlogOwner && req.user.role !== "ADMIN") {
      req.flash("error", "Unauthorized to delete this comment.");
      return res.redirect("back");
    }

    // 🧠 Smart Delete: Soft delete if replies exist, Hard delete if leaf node
    const hasChildren = await Comment.exists({ parentId: req.params.commentId });

    if (hasChildren) {
      // Soft Delete: Preserve thread structure
      await Comment.findByIdAndUpdate(req.params.commentId, {
        content: "[This comment was deleted]",
        isDeleted: true
      });
      req.flash("success", "Comment deleted (thread preserved).");
    } else {
      // Hard Delete: Clean up DB
      await Comment.findByIdAndDelete(req.params.commentId);
      req.flash("success", "Comment deleted.");
    }

    return res.redirect(`/blog/${comment.blogId._id}`);

  } catch (error) {
    logger.error("❌ Error deleting comment:", error);
    req.flash("error", "Server error.");
    return res.redirect("back");
  }
});

// 💬 Reply to Comment (Threaded)
router.post("/comment/:commentId/reply", async (req, res) => {
  try {
    if (!req.user) return res.status(401).send("Unauthorized");

    const parentComment = await Comment.findById(req.params.commentId).populate("blogId");
    if (!parentComment) return res.status(404).send("Parent comment not found");

    // 🛡️ Moderation Check
    const moderation = await moderateContent(req.body.content, { userId: req.user._id, ip: req.ip });
    if (!moderation.safe) {
      return res.status(400).json({ error: `Reply Rejected: ${moderation.reason}` });
    }

    // ✅ Threaded Reply: Create new Document
    const reply = await Comment.create({
      content: req.body.content,
      blogId: parentComment.blogId._id,
      createdBy: req.user._id,
      parentId: parentComment._id,
      depth: (parentComment.depth || 1) + 1,
      createdAt: new Date()
    });

    // 💬 Notify anyone @mentioned in the reply
    notifyMentions(req.body.content, parentComment.blogId, req.user, req);

    // Notify Parent Author
    if (parentComment.createdBy.toString() !== req.user._id.toString()) {
      await Notification.create({
        userId: parentComment.createdBy,
        senderId: req.user._id,
        message: `${req.user.fullName} replied: "${req.body.content}"`,
        type: "reply",
        blogId: parentComment.blogId._id, // Deep Link Support
        targetUrl: `/blog/${parentComment.blogId._id}#comment-${reply._id}`, // 🎯 Deep Link
        read: false,
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${parentComment.createdBy.toString()}`).emit("new_notification", {
          message: `${req.user.fullName} replied: "${req.body.content}"`
        });
      }
    }

    // 🚀 UNIFIED RENDER: Generate HTML for both Socket & AJAX
    const populatedReply = await Comment.findById(reply._id).populate("createdBy", "fullName profilePic");

    // Render the partial to a string
    res.render("partials/comment-thread", {
      comment: populatedReply,
      user: req.user,
      blog: parentComment.blogId,
      moment: require("moment")
    }, (err, html) => {
      if (err) {
        console.error("❌ EJS Render Error:", err);
        return res.status(500).json({ success: false, error: "Render Error" });
      }

      // 🔴 1. Real-time Update (Everyone else)
      const io = req.app.get("io");
      if (io) {
        io.to(`blog:${parentComment.blogId._id}`).emit("new_comment", {
          html: html,
          parentId: parentComment._id,
          commentId: reply._id
        });
      }

      // 🟢 2. AJAX Response (The sender)
      if (req.xhr || req.headers.accept.includes('json')) {
        return res.json({ success: true, reply: populatedReply, html: html });
      }

      // 🔵 3. Fallback Redirect (No-JS)
      req.flash("success", "Reply posted.");
      return res.redirect(`/blog/${parentComment.blogId._id}`);
    });



  } catch (error) {
    logger.error("❌ Error replying:", error);
    if (req.xhr || req.headers.accept.includes('json')) {
      return res.status(500).json({ success: false, error: "Server Error" });
    }
    res.status(500).send("Server Error");
  }
});

// 📌 Toggle Pin Comment
router.post("/comment/:commentId/pin", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });

    const comment = await Comment.findById(req.params.commentId).populate("blogId");
    if (!comment) return res.status(404).json({ success: false, message: "Comment not found" });

    // Auth: Only Blog Author can pin
    if (comment.blogId.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Only author can pin" });
    }

    // Toggle logic
    const wasPinned = comment.isPinned;

    // Optional: Unpin all others if you want only 1 pinned comment? 
    // Let's stick to simple toggle for now, allowing multiple pins is fine, or UI will sort them.
    // If we want Single Pin behavior:
    if (!wasPinned) {
      await Comment.updateMany({ blogId: comment.blogId._id }, { isPinned: false });
    }

    comment.isPinned = !wasPinned;
    await comment.save();

    return res.json({ success: true, isPinned: comment.isPinned });
  } catch (error) {
    logger.error("❌ Pin Error:", error);
    res.status(500).json({ success: false });
  }
});

// 😍 Reaction to Comment
router.post("/comment/:commentId/react", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Login required" });

    const { emoji } = req.body;
    // 🔒 Fixed: Validate emoji to prevent arbitrary data storage
    const ALLOWED_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍', '👎', '😲', '🤔', '🙌'];
    if (!emoji || !ALLOWED_EMOJIS.includes(emoji)) {
      return res.status(400).json({ success: false, message: "Invalid emoji reaction." });
    }
    const userId = req.user._id.toString();

    // Use lean() to get POJO and avoid Schema Validation on load
    // This allows us to handle the "corrupt" Array data without crashing
    let comment = await Comment.findById(req.params.commentId).lean();
    if (!comment) return res.status(404).json({ success: false });

    let reactions = comment.reactions || {};
    let isCorrupt = false;

    // Detect legacy/corrupt data (Array instead of Map/Object)
    if (Array.isArray(reactions) || typeof reactions !== 'object') {
      reactions = {};
      isCorrupt = true; // Flag to overwrite entire field to fix it
    }

    const currentEmoji = reactions[userId];
    let updateQuery = {};

    if (currentEmoji === emoji) {
      // Toggle OFF
      delete reactions[userId]; // Update local for counts
      if (isCorrupt) {
        updateQuery = { $set: { reactions: reactions } }; // Overwrite/Reset to valid object
      } else {
        updateQuery = { $unset: { [`reactions.${userId}`]: 1 } };
      }
    } else {
      // Toggle ON / Switch
      reactions[userId] = emoji; // Update local for counts
      if (isCorrupt) {
        updateQuery = { $set: { reactions: reactions } }; // Overwrite/Reset to valid object
      } else {
        updateQuery = { $set: { [`reactions.${userId}`]: emoji } };
      }
    }

    // Perform atomic update (bypasses schema validation)
    await Comment.updateOne({ _id: req.params.commentId }, updateQuery);

    // Calculate new counts
    const reactionCounts = {};
    Object.values(reactions).forEach((e) => {
      reactionCounts[e] = (reactionCounts[e] || 0) + 1;
    });

    return res.json({ success: true, reactionCounts });

  } catch (error) {
    logger.error("❌ Reaction Error:", error);
    res.status(500).json({ success: false });
  }
});

// ✏️ Edit Blog Page (GET)
router.get("/edit/:id", async (req, res) => {
  try {
    if (!req.user) return res.redirect("/user/signin");

    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      req.flash("error", "Blog not found.");
      return res.redirect("/");
    }

    // Check Ownership or Admin Role
    if (blog.createdBy.toString() !== req.user._id.toString() && req.user.role !== "ADMIN") {
      req.flash("error", "Unauthorized to edit this blog.");
      return res.redirect(`/blog/${blog._id}`);
    }

    return res.render("editBlog", {
      user: req.user,
      blog: blog,
      searchQuery: req.query.search || "",
    });
  } catch (error) {
    logger.error("❌ Error fetching blog for edit:", error);
    res.redirect("/");
  }
});

// ✏️ Edit Blog Action (POST)
router.post("/edit/:id", upload.single("coverImage"), async (req, res) => {
  try {
    if (!req.user) return res.status(401).send("Unauthorized");

    const { title, body, category, tags } = req.body;
    const blog = await Blog.findById(req.params.id);

    if (!blog) return res.status(404).send("Blog not found");
    // Check Ownership or Admin Role
    if (blog.createdBy.toString() !== req.user._id.toString() && req.user.role !== "ADMIN") {
      return res.status(403).send("Unauthorized");
    }

    // Rate Limiting (Cooldown) - 2 Minutes
    // Exempt Admins
    if (req.user.role !== "ADMIN") {
      const EDIT_COOLDOWN = 2 * 60 * 1000; // 2 minutes
      const lastUpdate = new Date(blog.updatedAt).getTime();
      const timeSinceUpdate = Date.now() - lastUpdate;

      if (timeSinceUpdate < EDIT_COOLDOWN) {
        const remainingSeconds = Math.ceil((EDIT_COOLDOWN - timeSinceUpdate) / 1000);
        req.flash("error", `Please wait ${remainingSeconds} seconds before updating again.`);
        return res.redirect(`/blog/edit/${req.params.id}`);
      }
    }

    // Validation: 50 Word Minimum

    // Validation: 50 Word Minimum
    const textBody = body ? body.replace(/<[^>]*>/g, '').trim() : "";
    const wordCount = textBody.split(/\s+/).filter(word => word.length > 0).length;

    if (wordCount < 50) {
      req.flash("error", `Too short! Please write at least 50 words (currently ${wordCount}).`);
      return res.redirect(`/blog/edit/${req.params.id}`);
    }

    // Update Fields
    blog.title = title;
    blog.body = body;
    blog.category = category;

    if (tags) {
      blog.tags = tags.split(",").map(tag => tag.trim());
    }

    // Update Cover Image if new one uploaded or AI URL provided
    // Update Cover Image if new one uploaded or AI URL provided
    if (req.file) {
      let finalUrl = req.file.path;
      // Fix for strange relative paths
      if (!finalUrl || !finalUrl.startsWith('http')) {
        if (req.file.secure_url) {
          finalUrl = req.file.secure_url;
        } else if (req.file.filename) {
          finalUrl = cloudinary.url(req.file.filename, { secure: true });
        }
      }
      blog.coverImageURL = finalUrl;
    } else if (req.body.aiCoverURL) {
      // 🔒 Fixed: Validate URL to prevent SSRF attacks
      try {
        const parsedUrl = new URL(req.body.aiCoverURL);
        const allowedHosts = ['pollinations.ai', 'picsum.photos', 'images.unsplash.com', 'res.cloudinary.com'];
        const isAllowed = allowedHosts.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host));
        if (!isAllowed) {
          req.flash("error", "Invalid cover image source URL.");
          return res.redirect(`/blog/edit/${req.params.id}`);
        }
        logger.info("⬆️ Uploading generated AI Image to Cloudinary (Edit)...");
        const result = await cloudinary.uploader.upload(req.body.aiCoverURL, { folder: "lumina_uploads" });
        blog.coverImageURL = result.secure_url;
      } catch (err) {
        if (err.code === 'ERR_INVALID_URL') {
          req.flash("error", "Invalid cover image URL format.");
          return res.redirect(`/blog/edit/${req.params.id}`);
        }
        console.error("❌ Failed to save AI Image to Cloudinary. Falling back to hotlink.", err);
        blog.coverImageURL = req.body.aiCoverURL;
      }
    }

    // ✅ Handle Status Update (Draft <-> Published)
    if (req.body.action === "draft") {
      blog.status = "draft";
    } else if (req.body.action === "publish") {
      // If transitioning from Draft -> Published, treat as new post (bump date & notify)
      if (blog.status === "draft") {
        blog.status = "published";
        blog.createdAt = new Date(); // Bump to top of feed

        // 🔔 Send "New Blog" Notifications (copy of POST / logic)
        // Self Notification
        const selfNotification = new Notification({
          userId: req.user._id,
          senderId: req.user._id,
          type: "blog_upload",
          message: `You published your draft: "${title}"`,
          blogId: blog._id,
          targetUrl: `/blog/${blog._id}`,
          read: false,
          createdAt: new Date(),
        });
        await selfNotification.save();

        // Follower Notifications
        const user = await User.findById(req.user._id).populate("followers", "fullName profilePic");
        if (user && user.fullName && user.followers.length > 0) {
          const followerNotifications = user.followers.map((follower) => ({
            userId: follower._id,
            senderId: req.user._id,
            type: "blog_upload",
            message: `${user.fullName} published a new blog: "${title}"`,
            blogId: blog._id,
            targetUrl: `/blog/${blog._id}`,
            read: false,
            createdAt: new Date(),
          }));

          await Notification.insertMany(followerNotifications);

          // Real-time Notify
          const io = req.app.get("io");
          if (io) {
            followerNotifications.forEach(n => {
              io.to(`user:${n.userId}`).emit("new_notification", {
                message: n.message
              });
            });
          }
        }
      } else {
        // Just ensure it's published (if it was already published, no change)
        blog.status = "published";
      }
    }

    // Generate new embedding in background (Fire-and-forget)
    // We do NOT await this, so the user gets a faster response.
    generateEmbedding(`${title} ${textBody}`).then(async (embedding) => {
      if (embedding.length > 0) {
        await Blog.findByIdAndUpdate(blog._id, { embedding });

      }
    }).catch(err => {
      logger.error("⚠️ Background Embedding Error:", err);
    });

    // Save initial blog immediately
    await blog.save();

    // Edited content is cached under its page (and may show on the landing) — drop both.
    pageCache.bustBlog(blog._id.toString());

    req.flash("success", "Blog updated successfully!");
    return res.redirect(`/blog/${blog._id}`);

  } catch (error) {
    logger.error("❌ Error updating blog:", error);
    req.flash("error", "Failed to update blog. Please try again.");
    return res.redirect(`/blog/edit/${req.params.id}`);
  }
});

// Delete a Blog Post
router.post("/delete/:blogId", async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const blog = await Blog.findById(req.params.blogId);
    if (!blog) {
      return res.status(404).json({ success: false, message: "Blog not found" });
    }

    // 🔒 Fixed: Allow admins to also delete blogs
    if (blog.createdBy.toString() !== req.user._id.toString() && req.user.role !== "ADMIN") {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    await blog.deleteOne();
    pageCache.bustBlog(req.params.blogId);
    return res.redirect("/");
  } catch (error) {
    logger.error("❌ Error deleting blog:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Category for Blogs
router.get("/category/:category", async (req, res) => {
  try {
    const category = req.params.category;
    const blogs = await Blog.find({ category, status: "published" }).select("-body").populate("createdBy", "fullName profilePic").lean();
    return res.render("home", { user: req.user, blogs });
  } catch (err) {
    logger.error("❌ Error fetching blogs by category:", err);
    req.flash("error", "Failed to load blogs for this category.");
    return res.redirect("/");
  }
});

// Tag for Blogs
router.get("/tag/:tag", async (req, res) => {
  try {
    const tag = req.params.tag;
    const blogs = await Blog.find({ tags: tag, status: "published" }).select("-body").populate("createdBy", "fullName profilePic").lean();
    return res.render("home", { user: req.user, blogs });
  } catch (err) {
    logger.error("❌ Error fetching blogs by tag:", err);
    req.flash("error", "Failed to load blogs for this tag.");
    return res.redirect("/");
  }
});

// 🔥 Fetch Featured Blogs
router.get("/featured", async (req, res) => {
  const featuredBlogs = await Blog.find({ featured: true, status: "published" }).select("-body").populate("createdBy", "fullName profilePic").lean();

  return res.render("home", { user: req.user, blogs: featuredBlogs });
});

// 🚀 Fetch Trending Blogs (Most Viewed)
router.get("/trending", async (req, res) => {
  const trendingBlogs = await Blog.find({ status: "published" }).sort({ views: -1 }).limit(3).select("-body").populate("createdBy", "fullName profilePic").lean();
  return res.render("home", { user: req.user, blogs: trendingBlogs });
});

// 📝 Create a Blog
router.post("/", blogLimiter, upload.single("coverImage"), async (req, res) => {
  const BLOG_COOLDOWN = 10 * 60 * 1000; // 10 minutes in milliseconds
  try {
    // 🔒 Fixed: Auth check FIRST before any AI/processing happens
    if (!req.user) {
      return res.status(401).send("Unauthorized: Please log in first.");
    }

    const { title, body, category, tags, useAI, aiCoverURL } = req.body;

    // 🛡️ Moderation Check (after auth to prevent free AI abuse)
    // We combine Title + Body + Tags to check the full context
    const fullContent = `${title} ${body} ${tags}`;
    const moderation = await moderateContent(fullContent, { userId: req.user._id, ip: req.ip });
    if (!moderation.safe) {
      return res.status(400).send(`Content Rejected: ${moderation.reason}`);
    }

    // ✅ Check last blog post time of this user
    const lastBlog = await Blog.findOne({ createdBy: req.user._id })
      .sort({ createdAt: -1 }) // Get the latest blog
      .select("createdAt");

    // Cooldown applies only to publishing/scheduling — saving drafts is unlimited.
    if (lastBlog && req.user.role !== "ADMIN" && req.body.action !== "draft") {
      const timeSinceLastBlog = new Date() - new Date(lastBlog.createdAt);
      if (timeSinceLastBlog < BLOG_COOLDOWN) {
        const remainingTime = Math.ceil((BLOG_COOLDOWN - timeSinceLastBlog) / 60000); // Convert to minutes
        // Keep them on the editor (work preserved) and suggest saving a draft.
        req.flash("error", `You can publish again in ${remainingTime} min. Save this as a draft for now.`);
        return res.redirect("/blog/add-new");
      }
    }

    const isDraft = req.body.action === "draft";
    const tagArray = tags ? tags.split(",").map(tag => tag.trim()).filter(Boolean) : [];
    let finalBody = body?.trim() || "";

    // Drafts are intentionally lenient: a title + some content is enough, so you
    // can save unfinished work. Cover/category/tags/length are only enforced when
    // actually publishing or scheduling.
    if (isDraft) {
      if (!title || !title.trim()) {
        req.flash("error", "Give your draft a title before saving.");
        return res.redirect("/blog/add-new");
      }
      if (!finalBody) finalBody = "<p></p>"; // body is required by the schema
    } else {
      // On any failure, send the writer back to the editor with a clear message
      // instead of a dead-end error page (their draft is preserved via autosave).
      if (!title || !category) {
        req.flash("error", "Add a title and pick a category before publishing.");
        return res.redirect("/blog/add-new");
      }
      if (tagArray.length === 0) {
        req.flash("error", "Add at least one tag so readers can find your story.");
        return res.redirect("/blog/add-new");
      }
      if (!req.file && !aiCoverURL) {
        req.flash("error", "Add a cover image before publishing.");
        return res.redirect("/blog/add-new");
      }
      if (!finalBody || finalBody.trim().length === 0) {
        req.flash("error", "Your story needs some content before publishing.");
        return res.redirect("/blog/add-new");
      }

      // Validation: 50 Word Minimum
      const textBody = finalBody.replace(/<[^>]*>/g, '').trim();
      const wordCount = textBody.split(/\s+/).filter(word => word.length > 0).length;

      if (wordCount < 50) {
        req.flash("error", `Story too short! Please write at least 50 words (currently ${wordCount}).`);
        return res.redirect("/blog/add-new"); // Redirect back to editor
      }
    }

    // ✅ Save Blog in Database (Initially without embedding)
    // 🗓️ Scheduling: a future publishAt (on a publish action) schedules the post.
    let scheduledAt = null;
    if (req.body.action !== "draft" && req.body.publishAt) {
      const when = new Date(req.body.publishAt);
      if (!isNaN(when) && when.getTime() > Date.now()) scheduledAt = when;
    }
    const blogStatus = req.body.action === "draft"
      ? "draft"
      : (scheduledAt ? "scheduled" : "published");

    let finalCoverImageURL = "";
    if (req.file) {
      finalCoverImageURL = req.file.path;
      if (!finalCoverImageURL || !finalCoverImageURL.startsWith('http')) {
        if (req.file.secure_url) {
          finalCoverImageURL = req.file.secure_url;
        } else if (req.file.filename) {
          finalCoverImageURL = cloudinary.url(req.file.filename, { secure: true });
        }
      }
    } else if (aiCoverURL) {
      // 🔒 Fixed: Validate URL to prevent SSRF attacks
      try {
        const parsedUrl = new URL(aiCoverURL);
        const allowedHosts = ['pollinations.ai', 'picsum.photos', 'images.unsplash.com', 'res.cloudinary.com'];
        const isAllowed = allowedHosts.some(host => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host));
        if (!isAllowed) {
          return res.status(400).send("Invalid cover image source URL.");
        }
        logger.info("⬆️ Uploading generated AI Image to Cloudinary...");
        const result = await cloudinary.uploader.upload(aiCoverURL, { folder: "lumina_uploads" });
        finalCoverImageURL = result.secure_url;
      } catch (err) {
        if (err.code === 'ERR_INVALID_URL') {
          return res.status(400).send("Invalid cover image URL format.");
        }
        console.error("❌ Failed to save AI Image to Cloudinary. Falling back to hotlink.", err);
        finalCoverImageURL = aiCoverURL;
      }
    }

    const blog = await Blog.create({
      title,
      body: finalBody,
      category,
      tags: tagArray,
      createdBy: req.user._id,
      coverImageURL: finalCoverImageURL,
      createdAt: new Date(),
      embedding: [], // Will be populated in background
      status: blogStatus,
      publishAt: scheduledAt,
    });

    // A new post changes the landing feed — drop the cached landing page.
    pageCache.bustBlog(blog._id.toString());

    // ⚡ Phase-4: embedding generation runs as a background job (off the request
    // path, retried, rate-limit-friendly) instead of a fire-and-forget promise.
    const fullText = `${title} ${finalBody.replace(/<[^>]*>/g, '')}`;
    enqueue("embed", { blogId: blog._id.toString(), text: fullText });

    // ✅ Notification fan-out (self + followers) runs as a background job so a
    // popular author's publish doesn't block the request on a huge insertMany.
    if (blogStatus === "published") {
      enqueue("fanout", { authorId: req.user._id.toString(), blogId: blog._id.toString(), title });
    } else if (blogStatus === "scheduled") {
      req.flash("success", `🗓️ Scheduled — this post will publish on ${scheduledAt.toLocaleString()}.`);
      return res.redirect("/blog/drafts");
    } else {
      req.flash("success", "Draft saved successfully!");
      return res.redirect("/blog/drafts");
    }

    req.flash("success", "Blog posted successfully!");
    return res.redirect(`/blog/${blog._id}`);

  } catch (error) {
    logger.error("❌ Error creating blog:", error);
    req.flash("error", "Failed to post your story. Please try again.");
    return res.redirect("/blog/add-new");
  }
});

// ⚡ Local API: Get Paginated Blogs (Infinite Scroll)
const feedCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 Seconds

router.get("/api/feed", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const categoryFilterRaw = String(req.query.category || "all").trim();

    // 🛑 Check Cache First
    const cacheKey = `${page}-${categoryFilterRaw}`;
    const cachedData = feedCache.get(cacheKey);

    if (cachedData && (Date.now() - cachedData.timestamp < CACHE_TTL)) {
      // console.log("🚀 Serving Feed from Cache:", cacheKey);
      return res.json(cachedData.data);
    }

    const limit = 5;
    // 🔒 Security: Escape categoryFilter for safe RegExp use (ReDoS prevention)
    const categoryFilter = categoryFilterRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const skip = (page - 1) * limit;

    let query = { status: "published" };
    if (categoryFilterRaw !== "all") {
      if (categoryFilterRaw === "featured") {
        query.featured = true;
      } else if (categoryFilterRaw === "trending") {
        // Trending handled by sort
      } else {
        query.category = { $regex: new RegExp(categoryFilter, "i") };
      }
    }

    let sort = { createdAt: -1 };
    if (categoryFilterRaw === "trending") {
      sort = { views: -1 };
    }

    // 🏎️ Optimized Query: Added .select() to exclude body
    const blogs = await Blog.find(query)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .select("title coverImageURL category views createdAt createdBy tags featured readTime")
      .populate("createdBy", "fullName profilePic");

    const { optimizeImage } = require('../services/imageHelper');

    const responseData = {
      blogs: blogs.map(blog => {
        const bObj = blog.toObject();
        // Optimize Images
        if (bObj.coverImageURL) {
          bObj.coverImageURL = optimizeImage(bObj.coverImageURL, { width: 600, crop: 'fill' });
        }
        if (bObj.createdBy && bObj.createdBy.profilePic) {
          bObj.createdBy.profilePic = optimizeImage(bObj.createdBy.profilePic, { width: 48, crop: 'fill' });
        }

        return {
          ...bObj,
          // readTime is now pre-calculated in the model
          readTime: bObj.readTime || 0 
        };
      }),
      hasMore: blogs.length === limit
    };

    // 📝 Save to Cache
    feedCache.set(cacheKey, {
      data: responseData,
      timestamp: Date.now()
    });

    res.json(responseData);
  } catch (error) {
    logger.error("❌ API Feed Error:", error);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

const { generateSummary, generateCounterpoint, rewriteAtLevel } = require("../services/ai");

// ⚡ Simple in-memory cache (per server instance) for AI-generated post content.
// AI results (counterpoint / rewrite / summary) are expensive and rate-limited by
// Gemini, so cache them in the shared layer (Redis when enabled, else in-process)
// for an hour. Shared caching means one generation serves every instance + viewer.
const { cache: sharedCache } = require("../services/redis");
const AI_CACHE_TTL_SECONDS = 60 * 60; // 1 hour
const aiCacheGet = (key) => sharedCache.get(`ai:${key}`);
const aiCacheSet = (key, val) => sharedCache.set(`ai:${key}`, val, AI_CACHE_TTL_SECONDS);

// 🥊 Steelman / Counterpoint (API)
router.get("/api/:id/counterpoint", async (req, res) => {
  try {
    const key = `cp:${req.params.id}`;
    const cached = await aiCacheGet(key);
    if (cached) return res.json({ counterpoint: cached, cached: true });

    const blog = await Blog.findById(req.params.id).select("title body");
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    const plainBody = blog.body.replace(/<[^>]*>/g, "");
    const counterpoint = await generateCounterpoint(blog.title, plainBody);
    await aiCacheSet(key, counterpoint);
    res.json({ counterpoint });
  } catch (error) {
    logger.error("❌ Counterpoint API Error:", error);
    res.status(500).json({ error: "Failed to generate counterpoint" });
  }
});

// 🎚️ Adaptive reading level rewrite (API)  — ?level=eli5|expert
router.get("/api/:id/rewrite", async (req, res) => {
  try {
    const level = req.query.level === "expert" ? "expert" : "eli5";
    const key = `rw:${level}:${req.params.id}`;
    const cached = await aiCacheGet(key);
    if (cached) return res.json({ level, content: cached, cached: true });

    const blog = await Blog.findById(req.params.id).select("title body");
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    const plainBody = blog.body.replace(/<[^>]*>/g, "");
    const content = await rewriteAtLevel(level, blog.title, plainBody);
    await aiCacheSet(key, content);
    res.json({ level, content });
  } catch (error) {
    logger.error("❌ Rewrite API Error:", error);
    res.status(500).json({ error: "Failed to rewrite post" });
  }
});

// 📊 Get Blog Summary & Highlights (API)
router.get("/api/:id/summary", async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: "Blog not found" });

    // AI summary re-enabled
    const plainBody = blog.body.replace(/<[^>]*>/g, '');
    const data = await generateSummary(plainBody);

    res.json({
      title: blog.title,
      summary: data.summary,
      highlights: data.highlights,
      coverImage: blog.coverImageURL,
      id: blog._id
    });
  } catch (error) {
    logger.error("❌ Summary API Error:", error);
    res.status(500).json({ error: "Failed to generate summary" });
  }
});


// 🎞️ GIPHY Proxy Endpoint
router.get("/api/giphy", async (req, res) => {
  try {
    const { q } = req.query;
    const apiKey = process.env.GIPHY_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: "GIPHY API Key missing on server" });
    }

    if (!q) {
      return res.status(400).json({ error: "Query required" });
    }

    const response = await axios.get(`https://api.giphy.com/v1/gifs/search`, {
      params: {
        api_key: apiKey,
        q: q,
        limit: 10,
        rating: 'g'
      }
    });

    res.json(response.data);
  } catch (error) {
    logger.error("❌ GIPHY Proxy Error:", error.message);
    if (error.response) {
      // Pass through GIPHY error message if available
      const giphyMsg = error.response.data?.meta?.msg || error.response.data?.message;
      return res.status(error.response.status).json({ error: giphyMsg || "GIPHY API Error" });
    }
    res.status(500).json({ error: "Failed to connect to GIPHY" });
  }
});

module.exports = router;