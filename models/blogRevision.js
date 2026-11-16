// A saved version of a post's title and body, for the editor's version history.
//
// Written by the editor's autosave and by every real save. Autosave never
// touches the post itself — a published post's live text only changes when the
// author presses Update — so this collection is where in-progress work lives
// until then. Only the newest MAX_REVISIONS per post are kept.
const mongoose = require("mongoose");

const blogRevisionSchema = new mongoose.Schema(
  {
    blogId: { type: mongoose.Schema.Types.ObjectId, ref: "blog", required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    title: { type: String, default: "", maxlength: 300 },
    body: { type: String, default: "" },
    // original: the post as it was before history began; autosave: editor
    // work in progress; saved: what a real Save/Update stored; restore: the
    // content that was in the editor just before a version was restored.
    kind: { type: String, enum: ["original", "autosave", "saved", "restore"], required: true },
    wordCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

blogRevisionSchema.index({ blogId: 1, updatedAt: -1 });

blogRevisionSchema.statics.MAX_REVISIONS = 30;

module.exports = mongoose.model("blogRevision", blogRevisionSchema);
