const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const logger = require("../services/logger"); // Structured Logging

// 📌 Get all notifications for logged-in user
router.get("/", async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      logger.warn("❌ No userId found in request");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 🧱 Phase-2 scaling: cursor-paginate instead of loading every notification.
    // `before` is the createdAt of the last item on the previous page.
    const PAGE_SIZE = 20;
    const query = { userId };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!isNaN(before)) query.createdAt = { $lt: before };
    }

    const batch = await Notification.find(query)
      .populate("senderId", "fullName profilePic")
      .sort({ createdAt: -1 })
      .limit(PAGE_SIZE + 1) // fetch one extra to detect "has more"
      .lean();

    const hasMore = batch.length > PAGE_SIZE;
    const notifications = batch.slice(0, PAGE_SIZE);
    const nextCursor = hasMore && notifications.length
      ? new Date(notifications[notifications.length - 1].createdAt).toISOString()
      : null;

    res.render("notifications", {
      notifications,
      hasMore,
      nextCursor,
      searchQuery: "",
      user: req.user
    });

  } catch (error) {
    logger.error("❌ Error fetching notifications:", error);
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

// Removed: POST /create.
//
// It took a `userId` and a `message` straight from the request body with no
// authentication, so anyone could have written an arbitrary notification into any
// user's feed — a ready-made phishing channel. It never actually worked (it omitted
// the schema-required `senderId` and `type`, so every call returned 500) and nothing
// in the codebase or UI called it. Notifications are created by the actions that
// cause them (likes, comments, follows, publishes) in routes/blog.js, routes/user.js
// and services/jobs.js. Don't reintroduce a generic endpoint for this.

// 📌 Mark a notification as read
router.post("/mark-read/:id", async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // ✅ Ensure the provided ID is a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid notification ID" });
    }

    // ✅ Find and update the correct notification
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id }, // Ensure the notification belongs to the user
      { read: true },
      { new: true } // Return the updated document
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    // ✅ Get the updated unread count
    const unreadCount = await Notification.countDocuments({
      userId: req.user._id,
      read: false,
    });

    return res.json({ success: true, count: unreadCount, notification });

  } catch (error) {
    logger.error("❌ Error marking notification as read:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


// 📌 Mark ALL of the user's notifications as read
router.post("/mark-all-read", async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true }
    );
    return res.json({ success: true, count: 0 });
  } catch (error) {
    logger.error("❌ Error marking all notifications as read:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// 📌 Get unread notifications count
router.get("/unread-count", async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.json({ count: 0 });
    }

    // ✅ Fetch unread notifications count
    const unreadCount = await Notification.countDocuments({
      userId: req.user._id, // Ensure this field exists in your Notification model
      read: false,
    });

    return res.json({ count: unreadCount });

  } catch (error) {
    logger.error("❌ Error fetching unread notifications count:", error);
    return res.status(500).json({ error: "Server error" });
  }
});
module.exports = router;