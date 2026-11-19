const { Router } = require("express");
const User = require("../models/user");
const Blog = require("../models/blog");
const Comment = require("../models/comment");
const ModerationLog = require("../models/moderationLog"); // 🛡️ Import Model
const Notification = require("../models/Notification");
const logger = require("../services/logger"); // Structured Logging

const { checkForAdmin } = require("../middleware/admin");

const router = Router();

// 🔒 Escape user input before using it in a RegExp (ReDoS / injection safety)
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Middleware to check if user is admin
const adminAuth = (req, res, next) => {
    if (req.user && req.user.role === "ADMIN") {
        return next();
    }
    return res.status(403).render("error", { message: "Access Denied: Admins Only" });
};

// 🛡️ Apply Admin Middleware to all routes here
router.use(checkForAdmin);

// 🛡️ Moderation: held comments, accounts to watch, ML status, and the log.
router.get("/moderation", adminAuth, async (req, res) => {
    try {
        const Topic = require("../models/topic");
        const { EMBEDDING_MODEL_ID } = require("../services/ai");
        const { suspiciousAccounts } = require("../services/ml/moderation");

        const [pending, logs, accounts, published, embedded, current, topics, latestTopic] = await Promise.all([
            ModerationLog.find({ actionTaken: "FLAGGED", resolvedAt: { $exists: false } })
                .populate("userId", "fullName email profilePic")
                .populate("blogId", "title slug")
                .sort({ riskScore: -1, createdAt: -1 })
                .limit(50)
                .lean(),
            ModerationLog.find()
                .populate("userId", "fullName email profilePic")
                .sort({ createdAt: -1 })
                .limit(50)
                .lean(),
            suspiciousAccounts({ limit: 20 }).catch((err) => {
                logger.error("Suspicious accounts failed:", err);
                return [];
            }),
            Blog.countDocuments({ status: "published" }),
            Blog.countDocuments({ status: "published", embedding: { $exists: true, $ne: [] } }),
            Blog.countDocuments({ status: "published", embeddingModel: EMBEDDING_MODEL_ID }),
            Topic.countDocuments(),
            Topic.findOne().sort({ builtAt: -1 }).select("builtAt").lean(),
        ]);

        res.render("admin/moderation", {
            user: req.user,
            pending,
            logs,
            accounts,
            ml: {
                published,
                embedded,
                current,
                model: EMBEDDING_MODEL_ID,
                topics,
                topicsBuiltAt: latestTopic ? latestTopic.builtAt : null,
            },
        });
    } catch (error) {
        logger.error("Admin/Moderation Error:", error);
        res.status(500).render("error", { message: "Failed to load logs" });
    }
});

// Resolve a held comment: delete it, or keep it (it is already visible).
router.post("/moderation/:id/resolve", adminAuth, async (req, res) => {
    try {
        const action = req.body.action === "delete" ? "deleted" : "kept";
        const log = await ModerationLog.findById(req.params.id);
        if (!log) return res.redirect("/admin/moderation");
        if (action === "deleted" && log.commentId) {
            // The comment and any replies to it.
            await Comment.deleteMany({ $or: [{ _id: log.commentId }, { parentId: log.commentId }] });
        }
        log.resolvedAt = new Date();
        log.resolution = action;
        await log.save();
        req.flash("success", action === "deleted" ? "Comment deleted." : "Comment kept.");
    } catch (error) {
        logger.error("Resolve moderation error:", error);
        req.flash("error", "Couldn't update that item.");
    }
    return res.redirect("/admin/moderation");
});

// Rebuild automatic topics now (normally daily).
router.post("/topics/rebuild", adminAuth, async (req, res) => {
    try {
        const { buildTopics } = require("../services/ml/topics");
        const result = await buildTopics();
        req.flash(
            result.built ? "success" : "error",
            result.built
                ? `Topics rebuilt: ${result.topics} topics from ${result.posts} posts.`
                : `Not enough embedded posts to build topics yet (${result.posts}).`
        );
    } catch (error) {
        logger.error("Topic rebuild error:", error);
        req.flash("error", "Topic rebuild failed: " + error.message);
    }
    return res.redirect("/admin/moderation");
});

// 💸 Earn waitlist results: is there real interest in Creator Rewards?
router.get("/earn", adminAuth, async (req, res) => {
    try {
        const { EarnWaitlist, EarnVisit } = require("../models/earnWaitlist");
        const since = new Date(Date.now() - 30 * 864e5);
        const sinceDay = since.toISOString().slice(0, 10);

        const count = (field) => EarnWaitlist.aggregate([
            { $match: { [`survey.${field}`]: { $ne: null } } },
            { $group: { _id: `$survey.${field}`, n: { $sum: 1 } } },
            { $sort: { n: -1 } },
        ]);
        const [
            joins, visitTotals, visitsBySource, joinsBySource, writers, members, referred, answered,
            motivation, frequency, invites, joinsByDay, visitsByDay, topInviters, recent,
        ] = await Promise.all([
            EarnWaitlist.countDocuments(),
            EarnVisit.aggregate([{ $group: { _id: null, n: { $sum: "$visitors" } } }]),
            EarnVisit.aggregate([{ $group: { _id: "$source", n: { $sum: "$visitors" } } }, { $sort: { n: -1 } }]),
            EarnWaitlist.aggregate([{ $group: { _id: "$source", n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
            EarnWaitlist.countDocuments({ wasWriter: true }),
            EarnWaitlist.countDocuments({ userId: { $type: "objectId" } }),
            EarnWaitlist.countDocuments({ referredBy: { $ne: null } }),
            EarnWaitlist.countDocuments({ "survey.answeredAt": { $exists: true } }),
            count("motivation"),
            count("frequency"),
            count("invites"),
            EarnWaitlist.aggregate([
                { $match: { createdAt: { $gte: since } } },
                { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } },
            ]),
            EarnVisit.aggregate([
                { $match: { day: { $gte: sinceDay } } },
                { $group: { _id: "$day", n: { $sum: "$visitors" } } },
            ]),
            EarnWaitlist.find({ referralCount: { $gt: 0 } }).sort({ referralCount: -1 }).limit(10).select("email name referralCount joinNumber").lean(),
            EarnWaitlist.find().sort({ createdAt: -1 }).limit(50).lean(),
        ]);

        const visitors = visitTotals.length ? visitTotals[0].n : 0;
        const joinsDay = new Map(joinsByDay.map((d) => [d._id, d.n]));
        const visitsDay = new Map(visitsByDay.map((d) => [d._id, d.n]));
        const days = [];
        for (let i = 29; i >= 0; i--) {
            const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
            days.push({ day, joins: joinsDay.get(day) || 0, visitors: visitsDay.get(day) || 0 });
        }
        const visitsBy = new Map(visitsBySource.map((v) => [v._id, v.n]));

        res.render("admin/earn", {
            user: req.user,
            stats: {
                visitors,
                joins,
                conversion: visitors ? Math.round((joins / visitors) * 1000) / 10 : null,
                writers,
                members,
                referred,
                answered,
            },
            sources: joinsBySource.map((j) => ({
                source: j._id,
                joins: j.n,
                visitors: visitsBy.get(j._id) || 0,
            })),
            survey: { motivation, frequency, invites },
            days,
            maxDay: Math.max(1, ...days.map((d) => Math.max(d.joins, d.visitors))),
            topInviters,
            recent,
        });
    } catch (error) {
        logger.error("Admin/Earn Error:", error);
        res.status(500).render("error", { message: "Failed to load waitlist results" });
    }
});

// The waitlist as CSV (for the launch email).
router.get("/earn.csv", adminAuth, async (req, res) => {
    try {
        const { EarnWaitlist } = require("../models/earnWaitlist");
        const rows = await EarnWaitlist.find().sort({ joinNumber: 1 }).lean();
        const cell = (v) => {
            const s = v == null ? "" : String(v);
            // Quote, and stop spreadsheet formula injection (=, +, -, @).
            return `"${(/^[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
        };
        const header = ["join_number", "email", "name", "source", "was_writer", "invited_by", "referrals", "motivation", "frequency", "invites", "joined_at"];
        const lines = rows.map((r) => [
            r.joinNumber, r.email, r.name, r.source, r.wasWriter, r.referredBy, r.referralCount,
            r.survey && r.survey.motivation, r.survey && r.survey.frequency, r.survey && r.survey.invites,
            new Date(r.createdAt).toISOString(),
        ].map(cell).join(","));
        res.set("Content-Type", "text/csv; charset=utf-8");
        res.set("Content-Disposition", `attachment; filename="earn-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send([header.join(","), ...lines].join("\n"));
    } catch (error) {
        logger.error("Admin/Earn CSV Error:", error);
        res.status(500).send("Export failed");
    }
});

// 📊 Admin Dashboard
router.get("/", async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const blogCount = await Blog.countDocuments();
        const commentCount = await Comment.countDocuments();

        // 🔍 Search Users
        const searchQuery = req.query.search || "";
        let userQuery = {};
        if (searchQuery) {
            userQuery = {
                $or: [
                    { fullName: { $regex: escapeRegex(searchQuery), $options: "i" } },
                    { email: { $regex: escapeRegex(searchQuery), $options: "i" } }
                ]
            };
        }

        // 🔍 Search Blogs
        const blogSearchQuery = req.query.blogSearch || "";
        let blogQuery = {};
        if (blogSearchQuery) {
            blogQuery = {
                title: { $regex: escapeRegex(blogSearchQuery), $options: "i" }
            };
        }

        // 📊 Aggregation for Charts (Last 6 Months)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5); // Go back 5 months + current
        sixMonthsAgo.setDate(1); // Start of that month

        const getMonthlyStats = async (Model) => {
            const stats = await Model.aggregate([
                { $match: { createdAt: { $gte: sixMonthsAgo } } },
                {
                    $group: {
                        _id: { $month: "$createdAt" },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            // Map to array of 12 months (or just the last 6 dynamically)
            // For simplicity, let's return the raw data and handle mapping in EJS or here.
            // Let's normalize it to an array of counts ordered by month index
            return stats;
        };

        const userGrowthRaw = await getMonthlyStats(User);
        const blogGrowthRaw = await getMonthlyStats(Blog);

        // Normalize Data for Chart.js (Labels & Data)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const labels = [];
        const userGrowthData = [];
        const blogGrowthData = [];

        for (let i = 0; i < 6; i++) {
            const d = new Date();
            d.setMonth(d.getMonth() - (5 - i));
            const monthIndex = d.getMonth() + 1; // 1-based for Mongo ID
            labels.push(monthNames[d.getMonth()]);

            const userStat = userGrowthRaw.find(s => s._id === monthIndex);
            userGrowthData.push(userStat ? userStat.count : 0);

            const blogStat = blogGrowthRaw.find(s => s._id === monthIndex);
            blogGrowthData.push(blogStat ? blogStat.count : 0);
        }

        // Fetch latest users and blogs
        const users = await User.find(userQuery).sort({ createdAt: -1 }).limit(50).lean(); // Increased limit for search
        const blogs = await Blog.find(blogQuery).select("-body").populate("createdBy", "fullName").sort({ createdAt: -1 }).limit(50).lean();



        res.render("admin/dashboard", {
            user: req.user,
            userCount,
            blogCount,
            commentCount,
            users,
            blogs,
            searchQuery, // ✅ Pass user search query
            blogSearchQuery, // ✅ Pass blog search query
            analytics: { labels, userGrowthData, blogGrowthData } // 📊 Pass Chart Data
        });
    } catch (error) {
        logger.error("Admin/Moderation Error:", error);
        res.redirect("/");
    }
});

// 👑 Update User Role (Promote/Demote)
// 🔓 Unlock every earned feature for one member (e.g. a writer you invited),
// or take the grant back. Features they earned themselves are never removed.
router.post("/user/unlocks/:id", async (req, res) => {
    try {
        const { FEATURES } = require("../services/unlockRules");
        const user = await User.findById(req.params.id).select("featureGrants fullName");
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/admin");
        }
        const granting = !(user.featureGrants && user.featureGrants.length);
        user.featureGrants = granting ? FEATURES.filter((f) => f.kind === "earned").map((f) => f.key) : [];
        await user.save();
        require("../services/unlocks").bust(user._id);
        logger.info("🔓 Admin %s %s all features for %s", String(req.user._id), granting ? "granted" : "revoked", String(user._id));
        req.flash("success", granting ? `All features unlocked for ${user.fullName}.` : `Granted features removed for ${user.fullName}.`);
        res.redirect("/admin");
    } catch (error) {
        logger.error("Unlock grant error:", error);
        req.flash("error", "Failed to update features.");
        res.redirect("/admin");
    }
});

router.post("/user/role/:id", async (req, res) => {
    try {
        if (req.user._id.toString() === req.params.id) {
            req.flash("error", "You cannot change your own role.");
            return res.redirect("/admin");
        }

        const user = await User.findById(req.params.id);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/admin");
        }

        // Toggle Role
        user.role = user.role === "ADMIN" ? "USER" : "ADMIN";
        await user.save();

        req.flash("success", `User role updated to ${user.role}.`);
        res.redirect("/admin");
    } catch (error) {
        logger.error("Role Update Error:", error);
        req.flash("error", "Failed to update role.");
        res.redirect("/admin");
    }
});



// �🚫 Delete User (Ban)
router.post("/user/delete/:id", async (req, res) => {
    try {
        if (req.params.id === req.user._id.toString()) {
            req.flash("error", "You cannot ban yourself!");
            return res.redirect("/admin");
        }

        // Remove the content along with the account. Leaving it behind orphaned
        // every blog and comment they wrote: templates fall back to "Unknown User",
        // and the comment-delete path dereferenced the missing author and threw.
        const blogIds = (await Blog.find({ createdBy: req.params.id }).select("_id").lean())
            .map((b) => b._id);

        await Promise.all([
            Blog.deleteMany({ createdBy: req.params.id }),
            Comment.deleteMany({ $or: [{ createdBy: req.params.id }, { blogId: { $in: blogIds } }] }),
            Notification.deleteMany({ $or: [{ userId: req.params.id }, { senderId: req.params.id }] }),
            // Drop them from everyone else's follower/following lists.
            User.updateMany(
                { $or: [{ followers: req.params.id }, { following: req.params.id }] },
                { $pull: { followers: req.params.id, following: req.params.id } }
            ),
        ]);
        await User.findByIdAndDelete(req.params.id);

        req.flash("success", "User has been banned and deleted, along with their posts and comments.");
        res.redirect("/admin");
    } catch (error) {
        logger.error("Delete User Error:", error);
        res.redirect("/admin");
    }
});

// 🗑️ Delete Blog (Moderation)
router.post("/blog/delete/:id", async (req, res) => {
    try {
        await Blog.findByIdAndDelete(req.params.id);
        req.flash("success", "Blog removed by moderator.");
        res.redirect("/admin");
    } catch (error) {
        logger.error("Delete Blog Error:", error);
        res.redirect("/admin");
    }
});

// 🌟 Toggle Featured Status
router.post("/blog/feature/:id", async (req, res) => {
    try {
        const blog = await Blog.findById(req.params.id);
        if (!blog) {
            req.flash("error", "Blog not found.");
            return res.redirect("/admin");
        }

        blog.featured = !blog.featured;
        await blog.save();

        req.flash("success", `Blog "${blog.title}" is now ${blog.featured ? "Featured 🌟" : "Un-featured"}.`);
        res.redirect("/admin");
    } catch (error) {
        logger.error("Toggle Feature Error:", error);
        req.flash("error", "Failed to update status.");
        res.redirect("/admin");
    }
});

// 🔒 Toggle Private Status
router.post("/blog/toggle-private/:id", async (req, res) => {
    try {
        const blog = await Blog.findById(req.params.id);
        if (!blog) {
            req.flash("error", "Blog not found.");
            return res.redirect("/admin");
        }

        // Toggle between 'published' and 'private'
        // If it's 'draft', we probably shouldn't mess with it, or maybe we treat draft as modifiable too?
        // User asked "makeing private power on admin", usually implies taking a published blog and hiding it.
        // Or making a private blog public.

        if (blog.status === "private") {
            blog.status = "published";
            req.flash("success", `Blog "${blog.title}" is now Public.`);
        } else {
            blog.status = "private";
            req.flash("success", `Blog "${blog.title}" is now Private 🔒.`);
        }

        await blog.save();
        res.redirect("/admin");
    } catch (error) {
        logger.error("Toggle Private Error:", error);
        req.flash("error", "Failed to update privacy.");
        res.redirect("/admin");
    }
});

module.exports = router;
