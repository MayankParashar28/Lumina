const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema({
    message: {
        type: String,
        required: true,
    },
    type: {
        type: String,
        enum: ["info", "warning", "danger", "success"],
        default: "info",
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    expiresAt: {
        type: Date,
        default: null, // Null = Always active
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Announcement = mongoose.model("Announcement", announcementSchema);

module.exports = Announcement;
