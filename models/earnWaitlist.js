// The Earn page waitlist: who is interested in Creator Rewards, what would
// motivate them, and whether they bring others — the signals for deciding
// whether to build the rewards program at all.
const mongoose = require("mongoose");

const entrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    email: { type: String, required: true }, // normalised (utils/email.js)
    name: { type: String, default: "" },
    joinNumber: { type: Number, required: true }, // 1, 2, 3… in order of joining
    refCode: { type: String, required: true }, // this person's invite code
    referredBy: { type: String, default: null }, // the inviter's refCode
    referralCount: { type: Number, default: 0 }, // people who joined with this code
    source: { type: String, default: "direct" }, // nav, home, publish, ref, direct…
    wasWriter: { type: Boolean, default: false }, // had published before joining
    // Lets a signed-out visitor answer the survey right after joining.
    token: { type: String, required: true, select: false },
    survey: {
      motivation: { type: String, enum: ["money", "readers", "recognition", "learning", null], default: null },
      frequency: { type: String, enum: ["weekly", "monthly", "occasionally", null], default: null },
      invites: { type: String, enum: ["0", "1-5", "5+", null], default: null },
      answeredAt: { type: Date },
    },
  },
  { timestamps: true }
);

entrySchema.index({ email: 1 }, { unique: true });
entrySchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } });
entrySchema.index({ refCode: 1 }, { unique: true });
entrySchema.index({ token: 1 });
entrySchema.index({ createdAt: -1 });

// Join numbers come from an atomic counter so two people joining at the same
// moment can't get the same number.
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.models.earnCounter || mongoose.model("earnCounter", counterSchema);

entrySchema.statics.nextJoinNumber = async function () {
  const c = await Counter.findOneAndUpdate({ _id: "earn-waitlist" }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return c.seq;
};

// Unique visitors to /earn per day and source, for conversion rates.
const visitSchema = new mongoose.Schema({
  day: { type: String, required: true }, // YYYY-MM-DD (UTC)
  source: { type: String, required: true },
  visitors: { type: Number, default: 0 },
});
visitSchema.index({ day: 1, source: 1 }, { unique: true });

const EarnWaitlist = mongoose.models.earnWaitlist || mongoose.model("earnWaitlist", entrySchema);
const EarnVisit = mongoose.models.earnVisit || mongoose.model("earnVisit", visitSchema);

module.exports = { EarnWaitlist, EarnVisit };
