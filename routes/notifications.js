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

    // ✅ Fetch notifications and populate sender details
    const notifications = await Notification.find({ userId })
      .populate("senderId", "fullName profilePic")
      .sort({ createdAt: -1 })
      .lean();  // ✅ Improves performance

    res.render("notifications", {
      notifications,
      searchQuery: "",
      user: req.user
    });

  } catch (error) {
    logger.error("❌ Error fetching notifications:", error);
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

// 📌 Create a new notification
router.post("/create", async (req, res) => {
  try {
    const { message, userId } = req.body;

    if (!userId) {
      logger.warn("❌ No userId provided in request body");
      return res.status(400).json({ error: "User ID is required" });
    }

    const notification = new Notification({
      message,
      userId: new mongoose.Types.ObjectId(userId),
      read: false,
      createdAt: new Date()
    });

    await notification.save(); // ✅ Ensure notification is saved properly

    res.status(201).json({ message: "Notification created!", notification });

  } catch (error) {
    logger.error("❌ Error creating notification:", error);
    res.status(500).json({ error: "Error creating notification" });
  }
});

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