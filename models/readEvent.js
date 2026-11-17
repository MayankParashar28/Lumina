// One reading session: who read which post, for how long, and how far.
//
// This is the signal the ML features learn from — the "For you" feed (what a
// reader actually finishes vs. bounces off), best time to publish (when an
// audience reads), and trends (what is being read more this week). Anonymous
// readers are recorded by a salted hash, never by IP. Kept for 180 days.
const mongoose = require("mongoose");

const readEventSchema = new mongoose.Schema({
  blogId: { type: mongoose.Schema.Types.ObjectId, ref: "blog", required: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  viewer: { type: String, required: true }, // u:<id> or a:<salted hash>
  seconds: { type: Number, default: 0, min: 0, max: 3600 },
  depth: { type: Number, default: 0, min: 0, max: 1 }, // share of the article scrolled through
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

readEventSchema.index({ viewer: 1, blogId: 1, createdAt: -1 }); // dedupe a session
readEventSchema.index({ userId: 1, createdAt: -1 }); // a reader's history (For you)
readEventSchema.index({ authorId: 1, createdAt: -1 }); // an author's audience (best time)
readEventSchema.index({ createdAt: -1 }); // trends window
readEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("readEvent", readEventSchema);
