// A passage a reader highlighted in a post, optionally with a private note.
//
// Private to the reader who made it. The passage is stored as text plus a bit
// of surrounding context (prefix/suffix) rather than as DOM offsets, so it can
// still be found after the author edits other parts of the post. If the passage
// itself is edited away, the highlight stays on the reader's Highlights page.
const mongoose = require("mongoose");

const highlightSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    blogId: { type: mongoose.Schema.Types.ObjectId, ref: "blog", required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    prefix: { type: String, default: "", maxlength: 64 },
    suffix: { type: String, default: "", maxlength: 64 },
    note: { type: String, default: "", trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// One reader's highlights on one post (the post page), and all of a reader's
// highlights newest first (the Highlights page).
highlightSchema.index({ userId: 1, blogId: 1, createdAt: 1 });
highlightSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("highlight", highlightSchema);
