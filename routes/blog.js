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
const { response } = require("express");

const dotenv = require("dotenv");
dotenv.config();

const { generateEmbedding, cosineSimilarity } = require("../services/ai"); // Import AI Service

const router = Router();

const { storage } = require("../config/cloudConfig");
const upload = multer({ storage: storage });

// 📝 Create a Blog
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
    const blog = await Blog.findById(req.params.id).populate("createdBy", "fullName profilePic");

    if (!blog) {
      return res.status(404).render("error", { message: "Blog not found." });
    }

    // Increase view count
    blog.views += 1;
    await blog.save();

    // Fetch comments
    const comments = await Comment.find({ blogId: req.params.id })
      .populate("createdBy", "fullName profilePic")
      .lean() || [];

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
    if (blog.createdBy.toString() !== userId.toString()) {
      await Notification.create({
        userId: blog.createdBy, // Blog owner's ID
        senderId: userId, // Commenter's ID
        message: `${req.user.fullName} commented ${comment.content ? `: "${comment.content}"` : ""} on your blog.`,
        type: "comment",
        read: false,
        createdAt: new Date(),
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`user:${blog.createdBy}`).emit("new_notification", {
          message: `${req.user.fullName} commented on your blog.`
        });
      }
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

    await Comment.findByIdAndDelete(req.params.commentId);
    req.flash("success", "Comment deleted.");
    return res.redirect(`/blog/${comment.blogId._id}`);

  } catch (error) {
    console.error("❌ Error deleting comment:", error);
    req.flash("error", "Server error.");
    return res.redirect("back");
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

    // Generate new embedding if title or body changed
    try {
      const fullText = `${title} ${textBody}`;
      const embedding = await generateEmbedding(fullText);
      if (embedding.length > 0) {
        blog.embedding = embedding;
      }
    } catch (embError) {
      console.error("⚠️ Failed to update embedding:", embError);
    }

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
  console.log(featuredBlogs); // Debugging: Check if blogs are fetched  console.log("Featured Blogs:", featuredBlogs); // Debugging
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

    // ✅ Generate Embedding before saving
    let embedding = [];
    try {
      const fullText = `${title} ${finalBody.replace(/<[^>]*>/g, '')}`;
      embedding = await generateEmbedding(fullText);
    } catch (embError) {
      console.error("⚠️ AI Embedding Generation Failed:", embError);
    }

    // ✅ Save Blog in Database
    const blog = await Blog.create({
      title,
      body: finalBody,
      category,
      tags: tagArray,
      createdBy: req.user._id,
      coverImageURL: req.file ? req.file.path : aiCoverURL,
      createdAt: new Date(),
      embedding: embedding, // Save the vectors
    });

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

    return res.redirect("/");
  } catch (error) {
    console.error("❌ Server Error:", error);
    res.status(500).send("Internal Server Error");
  }
});


// 🚀 Infinite Scroll API
router.get("/api/feed", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8;
    const categoryFilter = req.query.category ? req.query.category.toLowerCase() : "";
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

module.exports = router;