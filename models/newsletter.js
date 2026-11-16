// A note an author emailed to their followers.
//
// Kept so the author can see what they sent and to how many people, and so the
// once-a-week limit can be enforced from the database rather than memory.
const mongoose = require("mongoose");

const newsletterSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, required: true, trim: true, maxlength: 10000 },
    status: { type: String, enum: ["sending", "sent", "failed"], default: "sending" },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    sentAt: { type: Date },
  },
  { timestamps: true }
);

newsletterSchema.index({ authorId: 1, createdAt: -1 });

module.exports = mongoose.model("newsletter", newsletterSchema);
