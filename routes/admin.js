const { Router } = require("express");
const User = require("../models/user");
const Blog = require("../models/blog");
const Comment = require("../models/comment");
const ModerationLog = require("../models/moderationLog"); // 🛡️ Import Model

const { checkForAdmin } = require("../middleware/admin");

const router = Router();

// Middleware to check if user is admin
const adminAuth = (req, res, next) => {
    if (req.user && req.user.role === "ADMIN") {
        return next();
    }
    return res.status(403).render("error", { message: "Access Denied: Admins Only" });
};

// 🛡️ Apply Admin Middleware to all routes here
router.use(checkForAdmin);

// 🛡️ Moderation Logs Route
router.get("/moderation", adminAuth, async (req, res) => {
    try {
        const logs = await ModerationLog.find()
            .populate("userId", "fullName email profilePic")
            .sort({ createdAt: -1 })
            .limit(50); // Show last 50 events

        res.render("admin/moderation", {
            user: req.user,
            logs: logs
        });
    } catch (error) {
        console.error("Error fetching moderation logs:", error);
        res.status(500).render("error", { message: "Failed to load logs" });
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
                    { fullName: { $regex: searchQuery, $options: "i" } },
                    { email: { $regex: searchQuery, $options: "i" } }
                ]
            };
        }

        // 🔍 Search Blogs
        const blogSearchQuery = req.query.blogSearch || "";
        let blogQuery = {};
        if (blogSearchQuery) {
            blogQuery = {
                title: { $regex: blogSearchQuery, $options: "i" }
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
        const users = await User.find(userQuery).sort({ createdAt: -1 }).limit(50); // Increased limit for search
        const blogs = await Blog.find(blogQuery).populate("createdBy", "fullName").sort({ createdAt: -1 }).limit(50);



        res.render("admin/dashboard", {
            user: req.user,
            userCount,
            blogCount,
            commentCount,
            users,
            blogs,
            users,
            blogs,
            users,
            blogs,
            searchQuery, // ✅ Pass user search query
            blogSearchQuery, // ✅ Pass blog search query
            analytics: { labels, userGrowthData, blogGrowthData } // 📊 Pass Chart Data
        });
    } catch (error) {
        console.error("Admin Dashboard Error:", error);
        res.redirect("/");
    }
});

// 👑 Update User Role (Promote/Demote)
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
        console.error("Role Update Error:", error);
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

        await User.findByIdAndDelete(req.params.id);
        // Optionally delete their blogs too? For now, keep it simple.

        req.flash("success", "User has been banned and deleted.");
        res.redirect("/admin");
    } catch (error) {
        console.error("Delete User Error:", error);
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
        console.error("Delete Blog Error:", error);
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
        console.error("Toggle Feature Error:", error);
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
        console.error("Toggle Private Error:", error);
        req.flash("error", "Failed to update privacy.");
        res.redirect("/admin");
    }
});

module.exports = router;
