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
    status: {
      type: String,
      enum: ["draft", "published", "private"],
      default: "published",
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



// Indexing for search functionality and performance
blogSchema.index({ title: "text", body: "text", tags: "text" }); // Text Search
blogSchema.index({ createdAt: -1 }); // Sorting by Newest
blogSchema.index({ views: -1 });     // Sorting by Trending
blogSchema.index({ category: 1 });   // Filtering by Category
blogSchema.index({ createdBy: 1 });  // User Profile Feed
blogSchema.index({ tags: 1 });       // Efficient Tag Filtering
blogSchema.index({ status: 1 });     // Filtering Drafts vs Published

blogSchema.statics.getTrendingTags = async function () {
  try {
    const tags = await this.aggregate([
      { $unwind: "$tags" },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);
    return tags;
  } catch (err) {
    console.error("Error fetching trending tags:", err);
    return [];
  }
};


// ✅ Prevents overwriting the model if already compiled
const Blog = mongoose.models.blog || mongoose.model("blog", blogSchema);

module.exports = Blog;