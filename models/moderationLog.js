const mongoose = require("mongoose");
const { Schema } = mongoose;

const moderationLogSchema = new Schema(
    {
        content: {
            type: String,
            required: true,
        },
        reason: {
            type: String,
            required: true,
        },
        flaggedWords: [String],
        userId: {
            type: Schema.Types.ObjectId,
            ref: "user",
        },
        ipAddress: {
            type: String,
        },
        actionTaken: {
            type: String,
            enum: ["BLOCKED", "FLAGGED", "ALLOWED"],
            default: "BLOCKED",
        },
        // Smarter moderation (services/ml/moderation.js): the risk score, and
        // for a comment that was posted but held for review, where it is.
        riskScore: { type: Number },
        commentId: { type: Schema.Types.ObjectId, ref: "comment" },
        blogId: { type: Schema.Types.ObjectId, ref: "blog" },
        // Set when an admin has dealt with a FLAGGED entry.
        resolvedAt: { type: Date },
        resolution: { type: String, enum: ["deleted", "kept"] },
    },
    { timestamps: true }
);

const ModerationLog = mongoose.models.moderationLog || mongoose.model("moderationLog", moderationLogSchema);

module.exports = ModerationLog;
