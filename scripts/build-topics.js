// Rebuild automatic topics now (normally done daily by the web process).
//   node scripts/build-topics.js            AI-named when GOOGLE_GEMINI_API_KEY is set
//   node scripts/build-topics.js --no-ai    names from tags / keywords only
require("dotenv").config();
const mongoose = require("mongoose");
const { buildTopics } = require("../services/ml/topics");

(async () => {
  await mongoose.connect(process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy");
  const result = await buildTopics({ useAi: !process.argv.includes("--no-ai") });
  console.log(result);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("❌", err);
  process.exit(1);
});
