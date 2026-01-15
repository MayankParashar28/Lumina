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

        // 📊 Aggregation for Charts (Removed as per request)
        // const sixMonthsAgo = new Date(); ...

        // Fetch latest users and blogs
        const users = await User.find(userQuery).sort({ createdAt: -1 }).limit(50); // Increased limit for search
        const blogs = await Blog.find().populate("createdBy", "fullName").sort({ createdAt: -1 }).limit(20);



        res.render("admin/dashboard", {
            user: req.user,
            userCount,
            blogCount,
            commentCount,
            users,
            blogs,
            searchQuery // ✅ Pass search query
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

module.exports = router;
