// 🛡️ Smarter moderation: score comments and accounts (services/ml/risk.js)
// using recent behaviour, and record what needs a human.
const Comment = require("../../models/comment");
const ModerationLog = require("../../models/moderationLog");
const Notification = require("../../models/Notification");
const User = require("../../models/user");
const Blog = require("../../models/blog");
const logger = require("../logger");
const { scoreComment, scoreAccount } = require("./risk");

const daysSince = (d) => (d ? (Date.now() - new Date(d).getTime()) / 864e5 : 365);

/**
 * Score a comment before it is saved.
 * @returns {Promise<{score, level:"low"|"review"|"block", reasons:string[]}>}
 */
async function assessComment(user, content) {
  try {
    const text = String(content || "").trim();
    const [recentCount, duplicateCount] = await Promise.all([
      Comment.countDocuments({ createdBy: user._id, createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } }),
      text.length >= 10
        ? Comment.countDocuments({ createdBy: user._id, content: text, createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } })
        : 0,
    ]);
    return scoreComment({
      text,
      accountAgeDays: daysSince(user.createdAt),
      isVerified: user.isVerified !== false,
      recentCount,
      duplicateCount,
    });
  } catch (err) {
    logger.error("⚠️ Comment risk scoring failed: %s", err.message);
    return { score: 0, level: "low", reasons: [] }; // fail open; the profanity/AI filter still ran
  }
}

/** Record a comment decision for the admin moderation page. */
async function logDecision({ user, content, risk, action, ip, commentId, blogId }) {
  try {
    await ModerationLog.create({
      content: String(content || "").slice(0, 2000) || "(empty)",
      reason: risk.reasons.join(" · ") || "Risk score",
      userId: user._id,
      ipAddress: ip || "Unknown",
      actionTaken: action,
      riskScore: risk.score,
      commentId,
      blogId,
    });
  } catch (err) {
    logger.error("⚠️ Moderation log failed: %s", err.message);
  }
}

/** Follow bursts: how many people this account followed in the last hour. */
async function followsLastHour(userId) {
  return Notification.countDocuments({
    senderId: userId,
    type: "follow",
    createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  });
}

/**
 * Accounts behaving like spam or bots in the last day, riskiest first.
 * Only accounts with some unusual activity are scored at all.
 */
async function suspiciousAccounts({ limit = 20 } = {}) {
  const day = new Date(Date.now() - 864e5);
  const hour = new Date(Date.now() - 60 * 60 * 1000);
  const week = new Date(Date.now() - 7 * 864e5);
  const [comments, follows, flagged, posts] = await Promise.all([
    Comment.aggregate([
      { $match: { createdAt: { $gte: day } } },
      {
        $group: {
          _id: "$createdBy",
          n: { $sum: 1 },
          links: { $sum: { $cond: [{ $regexMatch: { input: "$content", regex: /https?:\/\/|www\./i } }, 1, 0] } },
          texts: { $push: "$content" },
        },
      },
    ]),
    Notification.aggregate([
      { $match: { type: "follow", createdAt: { $gte: hour } } },
      { $group: { _id: "$senderId", n: { $sum: 1 } } },
    ]),
    ModerationLog.aggregate([
      { $match: { createdAt: { $gte: week }, userId: { $ne: null }, actionTaken: { $in: ["BLOCKED", "FLAGGED"] } } },
      { $group: { _id: "$userId", n: { $sum: 1 } } },
    ]),
    Blog.aggregate([
      { $match: { createdAt: { $gte: day } } },
      { $group: { _id: "$createdBy", n: { $sum: 1 } } },
    ]),
  ]);

  const stats = new Map();
  const get = (id) => {
    const k = String(id);
    if (!stats.has(k)) stats.set(k, { id: k });
    return stats.get(k);
  };
  for (const c of comments) {
    const s = get(c._id);
    s.commentsLastDay = c.n;
    s.linkCommentsLastDay = c.links;
    const counts = new Map();
    for (const t of c.texts) if (t && t.length >= 10) counts.set(t, (counts.get(t) || 0) + 1);
    s.duplicateComments = Math.max(0, ...[...counts.values()].map((n) => (n > 1 ? n : 0)));
  }
  for (const f of follows) get(f._id).followsLastHour = f.n;
  for (const f of flagged) get(f._id).flaggedComments = f.n;
  for (const p of posts) get(p._id).postsLastDay = p.n;

  // Only bother loading accounts with something unusual going on.
  const interesting = [...stats.values()].filter(
    (s) => (s.followsLastHour || 0) >= 30 || (s.commentsLastDay || 0) >= 30 || (s.linkCommentsLastDay || 0) >= 3 ||
      (s.duplicateComments || 0) >= 2 || (s.flaggedComments || 0) >= 1 || (s.postsLastDay || 0) >= 10
  );
  if (!interesting.length) return [];
  const users = await User.find({ _id: { $in: interesting.map((s) => s.id) } })
    .select("fullName email profilePic createdAt isVerified role")
    .lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  return interesting
    .filter((s) => byId.has(s.id) && byId.get(s.id).role !== "ADMIN")
    .map((s) => {
      const u = byId.get(s.id);
      const risk = scoreAccount({ ...s, accountAgeDays: daysSince(u.createdAt), isVerified: u.isVerified !== false });
      return { user: u, ...risk };
    })
    .filter((r) => r.level !== "low")
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { assessComment, logDecision, followsLastHour, suspiciousAccounts };
