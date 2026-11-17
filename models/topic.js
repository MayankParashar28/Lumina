// An automatic topic: a cluster of posts that are about the same thing,
// found from their embeddings (services/ml/topics.js) and given a readable
// name. Rebuilt periodically; posts point at their topic via blog.topic.
const mongoose = require("mongoose");

const topicSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    description: { type: String, default: "" },
    keywords: { type: [String], default: [] },
    centroid: { type: [Number], select: false },
    size: { type: Number, default: 0 },
    embeddingModel: { type: String },
    builtAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

topicSchema.index({ size: -1 });

module.exports = mongoose.model("topic", topicSchema);
