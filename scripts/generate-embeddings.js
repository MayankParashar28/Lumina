// Backfill post embeddings.
//
//   node scripts/generate-embeddings.js           posts with no embedding
//   node scripts/generate-embeddings.js --stale   also posts embedded by a different
//                                                 model than the current one
//
// Run --stale once after changing GOOGLE_EMBEDDING_MODEL (or when the default
// changes): vectors from different models can't be compared, so until old
// posts are re-embedded, recommendations and search mix incomparable scores.
require("dotenv").config();
const mongoose = require("mongoose");
const Blog = require("../models/blog");
const { generateEmbedding, EMBEDDING_MODEL_ID } = require("../services/ai");

const URI = process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy";
const STALE = process.argv.includes("--stale");
const PAUSE_MS = Number(process.env.EMBED_PAUSE_MS) || 1500;

async function backfill() {
  await mongoose.connect(URI);
  console.log("✅ Connected to MongoDB. Embedding model:", EMBEDDING_MODEL_ID);

  const missing = [{ embedding: { $exists: false } }, { embedding: { $size: 0 } }];
  const filter = STALE
    ? { $or: [...missing, { embeddingModel: { $ne: EMBEDDING_MODEL_ID } }] }
    : { $or: missing };

  const blogs = await Blog.find(filter).select("title body").lean();
  console.log(`🔍 ${blogs.length} posts to embed${STALE ? " (including stale)" : ""}.`);

  let done = 0;
  for (const blog of blogs) {
    let attempts = 0;
    for (;;) {
      const text = `${blog.title} ${String(blog.body || "").replace(/<[^>]*>/g, " ")}`;
      const embedding = await generateEmbedding(text);
      if (embedding.length > 0) {
        await Blog.updateOne({ _id: blog._id }, { $set: { embedding, embeddingModel: EMBEDDING_MODEL_ID } });
        done++;
        console.log(`✅ ${done}/${blogs.length} ${blog.title}`);
        break;
      }
      if (++attempts >= 3) {
        console.log(`⚠️ Skipped after 3 attempts: ${blog.title}`);
        break;
      }
      console.log("⏳ No embedding returned (rate limit?). Waiting 60s…");
      await new Promise((r) => setTimeout(r, 60000));
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  console.log(`🎉 Done: ${done}/${blogs.length}. Next: rebuild topics from the admin moderation page or run \`node scripts/build-topics.js\`.`);
  await mongoose.disconnect();
}

backfill().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
