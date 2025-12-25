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
        enum: ["like", "comment", "follow","blog_upload"],
        required: true,
    }, // Action type
    message: {
        type: String,
        required: true,
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

module.exports = mongoose.model("Notification", notificationSchema);
