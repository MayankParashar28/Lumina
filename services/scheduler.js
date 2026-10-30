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
    const due = await Blog.find({ status: "scheduled", publishAt: { $lte: now } }).select("_id");
    if (due.length === 0) return 0;

    let publishedCount = 0;
    for (const candidate of due) {
      // Claim the post with a conditional update rather than find-then-save. Up to
      // three things can run this concurrently (the setInterval, the repeatable
      // BullMQ job, and the /cron/publish-scheduled endpoint); read-then-write let
      // two of them publish the same post and send every follower duplicate
      // notifications. Only the caller that actually flips the status proceeds.
      const blog = await Blog.findOneAndUpdate(
        { _id: candidate._id, status: "scheduled" },
        { $set: { status: "published", createdAt: new Date() }, $unset: { publishAt: "" } },
        { new: true }
      );
      if (!blog) continue; // another runner got to it first

      publishedCount += 1;

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
    return publishedCount;
  } catch (err) {
    logger.error("❌ publishDueScheduled error:", err.message);
    return 0;
  }
}

module.exports = { publishDueScheduled };
