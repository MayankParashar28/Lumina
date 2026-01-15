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
    },
    { timestamps: true }
);

const ModerationLog = mongoose.models.moderationLog || mongoose.model("moderationLog", moderationLogSchema);

module.exports = ModerationLog;
