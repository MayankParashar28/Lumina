const mongoose = require("mongoose");
const { model } = require("mongoose");
const { Schema } = require("mongoose");
const User = require("./user"); // Ensure "User" model exists

const blogSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,  // Fixed "require" to "required"
    },
    body: {
      type: String,
      required: true,  // Fixed "require" to "required"
    },
    coverImageURL: {
      type: String,
      required: false,  // Fixed "require" to "required"
    },
    views: {
      type: Number,
      default: 0,
    },
    category: {
      type: String,
      required: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    tags: {
      type: [String],
      default: [],
    },
    featured: {
      type: Boolean,
      default: false,
    },
    likes: {
      type: Number,
      default: 0,
    },

    likedBy: {
      type: [String],
      default: [],
    },
    totalLikes: {
      type: Number,
      default: 0,
    },
    totalComments: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Comment",  // Ensure "Comment" model exists
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",  // Ensure "User" model exists
      required: true, // Optional: Ensure blogs always have a creator
    },
    embedding: {
      type: [Number], // Store vector embeddings
      select: false,   // Don't return by default to save bandwidth
    },

  },
  { timestamps: true }
);



// Indexing for search functionality
blogSchema.index({ title: "text", body: "text", tags: "text" });



// ✅ Prevents overwriting the model if already compiled
const Blog = mongoose.models.blog || mongoose.model("blog", blogSchema);

module.exports = Blog;