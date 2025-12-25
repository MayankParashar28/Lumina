const mongoose = require("mongoose");
const { Schema } = mongoose;

const pendingUserSchema = new Schema(
    {
        fullName: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        password: { type: String, required: true }, // Already hashed
        salt: { type: String, required: true },
        verificationToken: { type: String, required: true },
        verificationTokenExpires: { type: Date, required: true },
        profilePic: { type: String },

        // Auto-delete after 24 hours (86400 seconds)
        createdAt: { type: Date, default: Date.now, expires: 86400 },
    },
    { timestamps: true }
);

const PendingUser = mongoose.model("pendingUser", pendingUserSchema);

module.exports = PendingUser;
