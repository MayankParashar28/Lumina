const { Router } = require("express");
const multer = require("multer");
const path = require("path");
const moment = require("moment"); // Ensure moment is imported
const User = require("../models/user");
const Comment = require("../models/comment");
const Blog = require("../models/blog");
const marked = require("marked");
const { checkSubscription } = require("../middleware/subscription");
const { error } = require("console");
const Notification = require("../models/Notification");
const moderateContent = require("../utils/moderator"); // Hybrid Moderation
const { response } = require("express");

const dotenv = require("dotenv");
dotenv.config();

const axios = require("axios"); // Import Axios for GIPHY Proxy

const { generateEmbedding, cosineSimilarity } = require("../services/ai"); // Import AI Service

const router = Router();

const { storage } = require("../config/cloudConfig");
const upload = multer({ storage: storage });

// 👁️ Preview Blog
router.post("/preview", async (req, res) => {
  try {
    const { title, body, aiCoverURL, coverImage } = req.body;

    // Construct mock blog object
    const mockBlog = {
      _id: "preview-id",
      title: title || "[Untitled Story]",
      body: body || "<p>Start writing your story...</p>",
      coverImageURL: aiCoverURL || coverImage || "", // Use AI URL or Placeholder (File upload preview is tricky without saving, simplified here)
      createdBy: req.user,
      createdAt: new Date(),
      views: 0,
      tags: [],
      category: "Preview",
      likes: 0,
      likedBy: [],
      comments: []
    };

    // Render the blog template with mock data
    return res.render("blog", {
      title: mockBlog.title,
      metaDescription: "Preview Mode",
      ogImage: mockBlog.coverImageURL,
      user: req.user || null,
      blog: mockBlog,
      comments: [], // No comments in preview
      isAuthenticated: !!req.user,
      searchQuery: "",
      moment: require("moment"),
      createdByName: req.user ? req.user.fullName : "Author",
      createdByProfilePic: req.user ? req.user.profilePic : "https://api.dicebear.com/7.x/initials/svg?seed=Author",
      formattedDate: "Just now",
      isBookmarked: false,
      relatedBlogs: [],
      isPreview: true // Flag to potentially hide confusing interactions
    });

  } catch (err) {
    console.error("Preview Error:", err);
    res.status(500).send("Preview generation failed");
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
    console.error(err);
    res.redirect("/");
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
          console.error("⚠️ Failed to track history:", histError);
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
    console.error("❌ Error fetching blog:", err.message);
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
      const fallback = await Blog.find({ _id: { $ne: req.params.id } }).limit(3);
      return res.json({ blogs: fallback });
    }

    const allBlogs = await Blog.find({
      _id: { $ne: req.params.id },
      embedding: { $exists: true, $ne: [] }
    }).select("title coverImageURL embedding createdAt");

    // Calculate similarities
    const scoredBlogs = allBlogs.map(blog => {
      const score = cosineSimilarity(currentBlog.embedding, blog.embedding);
      return { ...blog.toObject(), score };
    });

    // Sort by score desc and take top 3
    scoredBlogs.sort((a, b) => b.score - a.score);
    const recommended = scoredBlogs.slice(0, 3);

    res.json({ blogs: recommended });

  } catch (error) {
    console.error("❌ Recommendation Error:", error);
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
    console.error("❌ Bookmarking Error:", error);
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
    console.error("❌ Error in liking blog:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Comment on a Blog
router.post("/comment/:blogId", async (req, res) => {
  const COMMENT_COOLDOWN = 5 * 60 * 1000; // 5 minutes in milliseconds
  try {
    // 🛡️ Moderation Check
    const moderation = await moderateContent(req.body.content);
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
        read: false,
        createdAt: new Date(),
      }).then(() => {
        const io = req.app.get("io");
        if (io) {
          io.to(`user:${blog.createdBy}`).emit("new_notification", {
            message: `${req.user.fullName} commented on your blog.`
          });
        }
      }).catch(err => console.error("⚠️ Notification Error:", err));
    }

    // 🔴 Real-time Update: Emit new root comment
    const io = req.app.get("io");
    if (io) {
      const populatedComment = await Comment.findById(comment._id).populate("createdBy", "fullName profilePic");

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
          console.error("❌ EJS Render Error:", err);
        }
      });
    }

    req.flash("success", "Comment added successfully!");
    return res.redirect(`/blog/${req.params.blogId}`);
  } catch (error) {
    console.error("❌ Error adding comment:", error.message);
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
    console.error("❌ Error deleting comment:", error);
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
    const moderation = await moderateContent(req.body.content);
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

    // Notify Parent Author
    if (parentComment.createdBy.toString() !== req.user._id.toString()) {
      await Notification.create({
        userId: parentComment.createdBy,
        senderId: req.user._id,
        message: `${req.user.fullName} replied: "${req.body.content}"`,
        type: "reply",
        blogId: blog._id, // Deep Link Support
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
    console.error("❌ Error replying:", error);
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
    console.error("❌ Pin Error:", error);
    res.status(500).json({ success: false });
  }
});

// 😍 Reaction to Comment
router.post("/comment/:commentId/react", async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Login required" });

    const { emoji } = req.body;
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
    console.error("❌ Reaction Error:", error);
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

    // Check Ownership
    if (blog.createdBy.toString() !== req.user._id.toString()) {
      req.flash("error", "Unauthorized to edit this blog.");
      return res.redirect(`/blog/${blog._id}`);
    }

    return res.render("editBlog", {
      user: req.user,
      blog: blog,
      searchQuery: req.query.search || "",
    });
  } catch (error) {
    console.error("❌ Error fetching blog for edit:", error);
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
    if (blog.createdBy.toString() !== req.user._id.toString()) {
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
    if (req.file) {
      blog.coverImageURL = req.file.path;
    } else if (req.body.aiCoverURL) {
      blog.coverImageURL = req.body.aiCoverURL;
    }

    // Generate new embedding in background (Fire-and-forget)
    // We do NOT await this, so the user gets a faster response.
    generateEmbedding(`${title} ${textBody}`).then(async (embedding) => {
      if (embedding.length > 0) {
        await Blog.findByIdAndUpdate(blog._id, { embedding });
        // console.log("✅ Background Embedding Updated for:", blog.title);
      }
    }).catch(err => {
      console.error("⚠️ Background Embedding Error:", err);
    });

    // Save initial blog immediately
    await blog.save();

    req.flash("success", "Blog updated successfully!");
    return res.redirect(`/blog/${blog._id}`);

  } catch (error) {
    console.error("❌ Error updating blog:", error);
    res.status(500).send("Internal Server Error");
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

    if (blog.createdBy.toString() !== req.user._id.toString()) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    await blog.deleteOne();
    return res.redirect("/");
  } catch (error) {
    console.error("❌ Error deleting blog:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Category for Blogs
router.get("/category/:category", async (req, res) => {
  const category = req.params.category;
  const blogs = await Blog.find({ category });
  return res.render("home", { user: req.user, blogs });
});

// Tag for Blogs
router.get("/tag/:tag", async (req, res) => {
  const tag = req.params.tag;
  const blogs = await Blog.find({ tags: tag });
  return res.render("home", { user: req.user, blogs });
});

// 🔥 Fetch Featured Blogs
router.get("/featured", async (req, res) => {
  const featuredBlogs = await Blog.find({ featured: true });

  return res.render("home", { user: req.user, blogs: featuredBlogs });
});

// 🚀 Fetch Trending Blogs (Most Viewed)
router.get("/trending", async (req, res) => {
  const trendingBlogs = await Blog.find().sort({ views: -1 }).limit(3);
  return res.render("home", { user: req.user, blogs: trendingBlogs });
});

// 📝 Create a Blog
router.post("/", upload.single("coverImage"), async (req, res) => {
  const BLOG_COOLDOWN = 10 * 60 * 1000; // 10 minutes in milliseconds
  try {
    const { title, body, category, tags, useAI, aiCoverURL } = req.body;

    // 🛡️ Moderation Check
    // We combine Title + Body + Tags to check the full context
    const fullContent = `${title} ${body} ${tags}`;
    const moderation = await moderateContent(fullContent);
    if (!moderation.safe) {
      return res.status(400).send(`Content Rejected: ${moderation.reason}`);
    }

    if (!req.user) {
      console.log("❌ Unauthorized User");
      return res.status(401).send("Unauthorized: Please log in first.");
    }

    // ✅ Check last blog post time of this user
    const lastBlog = await Blog.findOne({ createdBy: req.user._id })
      .sort({ createdAt: -1 }) // Get the latest blog
      .select("createdAt");

    if (lastBlog && req.user.role !== "ADMIN") {
      const timeSinceLastBlog = new Date() - new Date(lastBlog.createdAt);
      if (timeSinceLastBlog < BLOG_COOLDOWN) {
        const remainingTime = Math.ceil((BLOG_COOLDOWN - timeSinceLastBlog) / 60000); // Convert to minutes
        req.flash("error", `Please wait ${remainingTime} minutes before posting another blog.`);
        return res.redirect("/");
      }
    }

    if (!title || !category) {
      console.log("❌ Missing Title or Category");
      return res.status(400).send("Title and Category are required.");
    }

    const tagArray = tags ? tags.split(",").map(tag => tag.trim()) : [];
    if (tagArray.length === 0) {
      console.log("❌ No Tags Provided");
      return res.status(400).send("At least one tag is required.");
    }

    if (!req.file && !aiCoverURL) {
      console.log("❌ No Cover Image Uploaded");
      return res.status(400).send("No cover image uploaded.");
    }

    let finalBody = body?.trim() || "";

    if (!finalBody || finalBody.trim().length === 0) {
      console.log("❌ Final Body Still Empty!");
      return res.status(400).send("Blog content is required.");
    }

    // Validation: 50 Word Minimum
    const textBody = finalBody.replace(/<[^>]*>/g, '').trim();
    const wordCount = textBody.split(/\s+/).filter(word => word.length > 0).length;

    if (wordCount < 50) {
      req.flash("error", `Story too short! Please write at least 50 words (currently ${wordCount}).`);
      return res.redirect("/blog/add-new"); // Redirect back to editor
    }

    // ✅ Save Blog in Database (Initially without embedding)
    const blog = await Blog.create({
      title,
      body: finalBody,
      category,
      tags: tagArray,
      createdBy: req.user._id,
      coverImageURL: req.file ? `/uploads/${req.file.filename}` : aiCoverURL,
      createdAt: new Date(),
      embedding: [] // Will be populated in background
    });

    // ⚡ Background AI: Generate Embedding (Fire-and-forget)
    // This allows the user to see their post immediately while AI works in the background.
    const fullText = `${title} ${finalBody.replace(/<[^>]*>/g, '')}`;
    generateEmbedding(fullText).then(async (embedding) => {
      if (embedding && embedding.length > 0) {
        await Blog.findByIdAndUpdate(blog._id, { embedding });
        // console.log(`✅ Background Embedding Complete for: ${blog.title}`);
      }
    }).catch(err => console.error("⚠️ Background Embedding Error:", err));

    // ✅ Save Notification for Blog Owner
    const selfNotification = new Notification({
      userId: req.user._id, // User receiving notification
      senderId: req.user._id, // The uploader
      type: "blog_upload",
      message: `You successfully uploaded a new blog: "${title}"`,
      read: false,  // Mark notification as unread initially
      createdAt: new Date(),
    });
    await selfNotification.save();

    // ✅ Notify All Followers
    const user = await User.findById(req.user._id).populate("followers", "fullName profilePic");
    if (!user || !user.fullName) {
      console.error("❌ User not found or missing name field.");
      return res.status(500).send("User data is incomplete.");
    }

    const followerNotifications = user.followers.map((follower) => ({
      userId: follower._id, // Follower receiving the notification
      senderId: req.user._id, // User who uploaded the blog
      type: "blog_upload",
      message: `${user.fullName} uploaded a new blog: "${title}"`,
      read: false,
      createdAt: new Date(),
    }));

    await Notification.insertMany(followerNotifications);

    // 📢 Real-time Notify Followers
    const io = req.app.get("io");
    if (io) {
      followerNotifications.forEach(n => {
        io.to(`user:${n.userId}`).emit("new_notification", {
          message: n.message
        });
      });
    }

    req.flash("success", "Blog posted successfully!");
    return res.redirect(`/blog/${blog._id}`);

  } catch (error) {
    console.error("❌ Error creating blog:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ⚡ Local API: Get Paginated Blogs (Infinite Scroll)
router.get("/api/feed", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const categoryFilter = req.query.category || "all";

    const skip = (page - 1) * limit;

    let filter = {};
    if (categoryFilter && categoryFilter !== "all" && categoryFilter !== "trending" && categoryFilter !== "featured") {
      filter.category = { $regex: new RegExp(categoryFilter, "i") };
    } else if (categoryFilter === "featured") {
      filter.featured = true;
    }

    let sort = { createdAt: -1 };
    if (categoryFilter === "trending") {
      sort = { views: -1 };
    }

    const blogs = await Blog.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate("createdBy", "fullName profilePic");

    res.json({
      blogs: blogs.map(blog => {
        // Sanitize body for word count
        const plainBody = blog.body.replace(/<[^>]*>/g, '');
        const wordCount = plainBody.split(/\s+/).length;
        return {
          ...blog.toObject(),
          readTime: Math.ceil(wordCount / 200)
        };
      }),
      hasMore: blogs.length === limit
    });
  } catch (error) {
    console.error("❌ API Feed Error:", error);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

const { generateSummary } = require("../services/ai");

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
    console.error("❌ Summary API Error:", error);
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
    console.error("❌ GIPHY Proxy Error:", error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    res.status(500).json({ error: "Failed to fetch from GIPHY" });
  }
});

module.exports = router;