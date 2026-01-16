const mongoose = require("mongoose");
const { Schema } = require("mongoose");
const { model } = require("mongoose");
const User = require("./user"); // Ensure "User" model exists

const notificationSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        required: true,
    }, // Receiver
    senderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        required: true,
    }, // Who performed the action
    type: {

        type: String,
        enum: ["like", "comment", "follow", "blog_upload", "reply"],
        required: true,
    }, // Action type
    message: {
        type: String,
        required: true,
    },
    blogId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "blog",
    },
    targetUrl: {
        type: String, // Calculated URL for easier frontend rendering (optional but helpful)
    },
    read: {
        type: Boolean,
        default: false,
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
});

// ⚡ Optimize Unread Count Query
notificationSchema.index({ userId: 1, read: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }); // 30 Days TTL
notificationSchema.index({ userId: 1, createdAt: -1 }); // Fast Feed Generation

module.exports = mongoose.model("Notification", notificationSchema);
