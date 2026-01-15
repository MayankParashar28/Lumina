const mongoose = require("mongoose");
const { Schema } = require("mongoose");
const { model } = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    blogId: {
      type: Schema.Types.ObjectId,
      ref: "blog",
      required: true,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: "comment",
      default: null,
    },
    depth: {
      type: Number,
      default: 1,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Add Reactions support
commentSchema.add({
  reactions: {
    type: Map,
    of: String,
    default: {}
  }
});

// Virtual for populating children
commentSchema.virtual("children", {
  ref: "comment",
  localField: "_id",
  foreignField: "parentId"
});

// ⚡ Indexes for Threaded Fetching
commentSchema.index({ blogId: 1, parentId: 1, createdAt: -1 }); // Top-level
commentSchema.index({ parentId: 1, createdAt: 1 }); // Replies (oldest first usually)

const Comment = model("comment", commentSchema);

module.exports = Comment;
