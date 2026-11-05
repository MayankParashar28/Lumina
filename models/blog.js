const mongoose = require("mongoose");
const { model } = require("mongoose");
const { Schema } = require("mongoose");
const User = require("./user"); // Ensure "User" model exists
const { sanitizePostBody, stripTags } = require("../utils/sanitize");
const { buildSlug } = require("../utils/slug");

const blogSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,  // Fixed "require" to "required"
    },
    // Readable permalink: "my-post-title-a1b2c3". Assigned once on creation by
    // the hook below and never regenerated, so a URL that has been shared keeps
    // working after the title is edited. Legacy posts predate the field; the
    // route falls back to an ObjectId lookup and 301s to the canonical URL, so
    // `sparse` is what lets them stay index-legal with no slug at all.
    slug: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },
    // The snippet a search engine and a link preview show. Left empty, the view
    // route falls back to the first ~150 characters of the body, which is what
    // every post used to get. Authoring one is strictly better: the opening line
    // of an article is rarely the sentence that makes someone click.
    metaDescription: {
      type: String,
      trim: true,
      maxlength: 160,
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
    // The view total as of this post's last weekly digest. The digest reports
    // the difference, so "views this week" is a real number rather than the
    // all-time count relabelled.
    viewsAtLastDigest: {
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
      enum: ["draft", "published", "private", "scheduled"],
      default: "published",
    },
    // 🗓️ When a "scheduled" post should auto-publish
    publishAt: {
      type: Date,
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
    readTime: {
      type: Number,
      default: 0,
    },

  },
  { timestamps: true }
);

// Assign the permalink, once.
//
// This runs on validate so the unique index never sees a document without a
// slug, and it is guarded on `!this.slug` rather than on isNew: a legacy post
// being edited picks one up here, while a post that already has one keeps it
// even when the title changes.
//
// `this._id` is already populated at this point -- mongoose assigns it when the
// document is constructed, not when it is saved -- so the six-hex uniqueness
// suffix is available before the first write.
blogSchema.pre("validate", function (next) {
  if (!this.slug) this.slug = buildSlug(this.title, this._id);
  next();
});

// Keep the meta description plain text within its length limit.
//
// It is rendered into a <meta content="..."> attribute, so markup in it is
// meaningless at best; maxlength would reject an over-long one and fail the
// whole save, which is a poor outcome for a field that is purely advisory.
// Trim it instead.
blogSchema.pre("validate", function (next) {
  if (this.isModified("metaDescription") && typeof this.metaDescription === "string") {
    const plain = stripTags(this.metaDescription).replace(/\s+/g, " ").trim();
    this.metaDescription = plain.length > 160 ? plain.slice(0, 160).trim() : plain;
  }
  next();
});

// 🧼 Sanitise the body before anything else looks at it.
//
// The routes sanitise too, so their own length/emptiness checks run against what
// will actually be stored — but this hook is the backstop: a future write path
// that forgets, or a script run by hand, still cannot put executable markup in
// the database. It runs on validate rather than save so `required` sees the
// sanitised value (a body made of nothing but <script> collapses to "" and is
// rejected) and so readTime below is computed from the real text.
blogSchema.pre("validate", function (next) {
  if (this.isModified("body") && typeof this.body === "string") {
    this.body = sanitizePostBody(this.body);
  }
  next();
});

// ✅ Calculate readTime before saving
blogSchema.pre("save", function (next) {
  if (this.isModified("body") && this.body) {
    const plainText = this.body.replace(/<[^>]*>/g, ""); // Remove HTML tags
    const words = plainText.split(/\s+/).filter(word => word.length > 0).length;
    this.readTime = Math.ceil(words / 200); // Average 200 words per minute
  }
  next();
});



// Indexing for search functionality and performance
blogSchema.index({ title: "text", body: "text", tags: "text" }); // Text Search
blogSchema.index({ createdAt: -1 }); // Sorting by Newest
blogSchema.index({ views: -1 });     // Sorting by Trending
blogSchema.index({ category: 1 });   // Filtering by Category
blogSchema.index({ createdBy: 1 });  // User Profile Feed
blogSchema.index({ tags: 1 });       // Efficient Tag Filtering
blogSchema.index({ status: 1 });     // Filtering Drafts vs Published
// slug already has a unique sparse index from the field definition above.

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