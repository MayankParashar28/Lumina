const Blog = require("../models/blog");
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
        // The shared fan-out, not a copy of it: a scheduled post reaches
        // followers by exactly the same path — and with the same emails — as
        // one published by hand. Required lazily because services/jobs.js
        // requires this module back for its publishScheduled processor.
        const { runFanout } = require("./jobs");
        await runFanout(
          { authorId: blog.createdBy, blogId: blog._id, title: blog.title, scheduled: true },
          io
        );
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
