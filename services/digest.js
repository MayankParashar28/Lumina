// 📊 The weekly digest, and the rule for who gets one.
//
// Not a cron with a fixed firing time. Each author carries their own watermark
// (lastDigestAt) and becomes due a week after their last one, which means:
//   - a missed run reports the whole gap instead of losing a week,
//   - two instances cannot both send, because the watermark is claimed with a
//     conditional update before anything is sent,
//   - and the check can run as often as we like without sending twice.
const logger = require("./logger");
const { linkFor } = require("../utils/unsubscribe");
const { sendWeeklyDigestEmail } = require("./emailService");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = Number(process.env.DIGEST_INTERVAL_MS) || WEEK_MS;

function baseUrl() {
  return (
    process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000"
  ).replace(/\/+$/, "");
}

/**
 * Sends the digest to every author who is due one.
 *
 * @param {object} [opts]
 * @param {Date}   [opts.now] for tests
 * @returns {Promise<number>} how many were sent
 */
async function sendDueDigests({ now = new Date() } = {}) {
  const User = require("../models/user");
  const Blog = require("../models/blog");
  const Comment = require("../models/comment");
  const Notification = require("../models/Notification");

  // Only people who have actually published something. Nobody else has a week
  // to hear about.
  const authorIds = await Blog.distinct("createdBy", { status: "published" });
  if (!authorIds.length) return 0;

  const due = await User.find({
    _id: { $in: authorIds },
    isVerified: true,
    email: { $exists: true, $ne: "" },
    "notificationPreferences.emailOnWeeklyDigest": { $ne: false },
  })
    .select("_id fullName email lastDigestAt")
    .lean();

  let sentCount = 0;

  for (const author of due) {
    try {
      // First time we ever see this author: set the watermarks and send
      // nothing. Otherwise the first digest would report every view since the
      // site began under the heading "this week", which is a lie.
      if (!author.lastDigestAt) {
        await initialiseWatermark(author._id, now, { User, Blog });
        continue;
      }

      if (now - new Date(author.lastDigestAt) < INTERVAL_MS) continue;

      // Claim it before doing any work. The filter repeats the condition, so if
      // another instance got here first this matches nothing and we move on.
      const claimed = await User.updateOne(
        { _id: author._id, lastDigestAt: author.lastDigestAt },
        { $set: { lastDigestAt: now } }
      );
      if (!claimed.modifiedCount) continue;

      const since = new Date(author.lastDigestAt);
      const posts = await Blog.find({ createdBy: author._id, status: "published" })
        .select("title slug views viewsAtLastDigest")
        .lean();

      const postIds = posts.map((p) => p._id);
      const [comments, followers] = await Promise.all([
        Comment.countDocuments({ blogId: { $in: postIds }, createdAt: { $gt: since } }),
        Notification.countDocuments({
          userId: author._id,
          type: "follow",
          createdAt: { $gt: since },
        }),
      ]);

      const withReads = posts
        .map((p) => ({
          title: p.title,
          url: `${baseUrl()}/blog/${p.slug || p._id}`,
          // A post edited or re-counted could in principle move backwards;
          // never report a negative.
          views: Math.max(0, (p.views || 0) - (p.viewsAtLastDigest || 0)),
        }))
        .filter((p) => p.views > 0)
        .sort((a, b) => b.views - a.views)
        .slice(0, 5);

      const views = withReads.reduce((a, p) => a + p.views, 0);

      // Move every post's watermark whether or not we send: the week has
      // passed either way, and otherwise a quiet week would be added onto the
      // next one and reported twice.
      await resetWatermarks(posts, Blog);

      // Nothing happened. Saying so out loud helps nobody and trains them to
      // ignore the next one.
      if (views === 0 && comments === 0 && followers === 0) continue;

      await sendWeeklyDigestEmail(author.email, {
        authorName: author.fullName,
        since: since.toLocaleDateString("en-GB", { day: "numeric", month: "long" }),
        views,
        comments,
        followers,
        posts: withReads,
        url: `${baseUrl()}/user/analytics`,
        unsubscribeUrl: linkFor(author._id, "digest", baseUrl()),
      });
      sentCount += 1;
    } catch (err) {
      // One author's digest failing must not stop everyone else's.
      logger.error("⚠️ Digest for %s failed: %s", author._id, err.message);
    }
  }

  if (sentCount) logger.info("📊 Weekly digests sent: %d", sentCount);
  return sentCount;
}

async function initialiseWatermark(userId, now, { User, Blog }) {
  const posts = await Blog.find({ createdBy: userId, status: "published" })
    .select("views")
    .lean();
  await resetWatermarks(posts, Blog);
  await User.updateOne({ _id: userId }, { $set: { lastDigestAt: now } });
}

async function resetWatermarks(posts, Blog) {
  if (!posts.length) return;
  await Blog.bulkWrite(
    posts.map((p) => ({
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { viewsAtLastDigest: p.views || 0 } },
      },
    }))
  );
}

module.exports = { sendDueDigests, INTERVAL_MS };
