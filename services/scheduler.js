const Blog = require("../models/blog");
const User = require("../models/user");
const Notification = require("../models/Notification");
const logger = require("./logger");

/**
 * Publishes any "scheduled" posts whose publishAt time has arrived, bumping them
 * to the top of the feed and sending the same follower notifications a normal
 * publish does. Safe to call repeatedly (idempotent per post).
 * @param {object} io - optional Socket.io instance for real-time notifications
 * @returns {Promise<number>} number of posts published
 */
async function publishDueScheduled(io) {
  try {
    const now = new Date();
    const due = await Blog.find({ status: "scheduled", publishAt: { $lte: now } });
    if (due.length === 0) return 0;

    for (const blog of due) {
      blog.status = "published";
      blog.createdAt = new Date(); // bump to top of the feed
      blog.publishAt = undefined;
      await blog.save();

      try {
        const author = await User.findById(blog.createdBy).populate("followers", "fullName");
        if (author) {
          await Notification.create({
            userId: author._id, senderId: author._id, type: "blog_upload",
            message: `Your scheduled post is now live: "${blog.title}"`,
            blogId: blog._id, targetUrl: `/blog/${blog._id}`, read: false, createdAt: new Date(),
          });

          if (author.followers && author.followers.length > 0) {
            const notifs = author.followers.map(f => ({
              userId: f._id, senderId: author._id, type: "blog_upload",
              message: `${author.fullName} published a new blog: "${blog.title}"`,
              blogId: blog._id, targetUrl: `/blog/${blog._id}`, read: false, createdAt: new Date(),
            }));
            await Notification.insertMany(notifs);
            if (io) notifs.forEach(n => io.to(`user:${n.userId}`).emit("new_notification", { message: n.message }));
          }
        }
      } catch (e) {
        logger.error("⚠️ Scheduled-publish notify error:", e.message);
      }

      logger.info(`🗓️ Auto-published scheduled post: "${blog.title}"`);
    }
    return due.length;
  } catch (err) {
    logger.error("❌ publishDueScheduled error:", err.message);
    return 0;
  }
}

module.exports = { publishDueScheduled };
