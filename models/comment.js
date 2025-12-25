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
  },
  { timestamps: true }
);

const Comment = model("comment", commentSchema);

module.exports = Comment;
