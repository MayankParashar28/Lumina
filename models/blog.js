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



// Indexes, one per query shape this app actually issues.
//
// These used to be seven single-field indexes. MongoDB uses only ONE index per
// query, so a single-field index cannot serve a filter and a sort at the same
// time: every feed query matched on `status` with the `status_1` index and then
// sorted the matches in memory, and the category and tag feeds fell back to
// walking `createdAt_-1` end to end. Measured on the live collection, filtering
// by category examined 31 documents to return 6, and the default signed-in feed
// examined 27 to return 8, both with an in-memory SORT stage.
//
// Each compound below puts the equality field first, then the sort field, which
// is the order MongoDB can walk without sorting. The sort direction matters: an
// index can be read backwards, but {views:1, createdAt:-1} reversed is
// {views:-1, createdAt:1}, which is NOT the trending sort -- hence two views
// indexes rather than one.
blogSchema.index({ title: "text", body: "text", tags: "text" }); // search

// Newest-first, unfiltered: the admin list, where the filter may be empty.
blogSchema.index({ createdAt: -1 });

// Public feeds. `status` is an equality match on every one of them.
blogSchema.index({ status: 1, createdAt: -1 });            // newest published
blogSchema.index({ status: 1, views: -1, createdAt: -1 }); // trending
blogSchema.index({ status: 1, views: 1, createdAt: -1 });  // hidden gems (default feed)
blogSchema.index({ status: 1, featured: 1, createdAt: -1 });
blogSchema.index({ status: 1, category: 1, createdAt: -1 });
blogSchema.index({ status: 1, tags: 1, createdAt: -1 });

// Author pages, drafts, "more from this author", the weekly digest.
blogSchema.index({ createdBy: 1, createdAt: -1 });

// The scheduler polls this shape every minute looking for posts that are due.
blogSchema.index({ status: 1, publishAt: 1 });

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