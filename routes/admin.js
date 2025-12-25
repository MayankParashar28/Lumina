const { Router } = require("express");
const User = require("../models/user");
const Blog = require("../models/blog");
const Comment = require("../models/comment");
const Announcement = require("../models/announcement");
const { checkForAdmin } = require("../middleware/admin");

const router = Router();

// 🛡️ Apply Admin Middleware to all routes here
router.use(checkForAdmin);

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

        // 📢 Fetch Active Announcement (for Admin UI)
        const activeAnnouncement = await Announcement.findOne({ isActive: true });

        res.render("admin/dashboard", {
            user: req.user,
            userCount,
            blogCount,
            commentCount,
            users,
            blogs,
            searchQuery, // ✅ Pass search query
            activeAnnouncement // ✅ Pass to view
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

// � Create Announcement
router.post("/announcement", async (req, res) => {
    try {
        const { message, type, duration } = req.body;

        // Deactivate all previous announcements
        await Announcement.updateMany({}, { isActive: false });

        let expiresAt = null;
        if (duration && duration !== "always") {
            // Duration is in hours
            expiresAt = new Date(Date.now() + parseInt(duration) * 60 * 60 * 1000);
        }

        await Announcement.create({
            message,
            type: type || "info",
            isActive: true,
            expiresAt
        });

        req.flash("success", "Announcement posted globally!");
        res.redirect("/admin");
    } catch (error) {
        console.error("Announcement Error:", error);
        req.flash("error", "Failed to post announcement.");
        res.redirect("/admin");
    }
});

// ❌ Delete/Deactivate Announcement
router.post("/announcement/delete/:id", async (req, res) => {
    try {
        await Announcement.findByIdAndDelete(req.params.id);
        req.flash("success", "Announcement removed.");
        res.redirect("/admin");
    } catch (error) {
        console.error("Delete Announcement Error:", error);
        req.flash("error", "Failed to remove announcement.");
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
