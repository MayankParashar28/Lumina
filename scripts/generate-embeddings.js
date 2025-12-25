require("dotenv").config({ path: "../.env" }); // Adjust path if running from root or scripts dir
const mongoose = require("mongoose");
const Blog = require("../models/blog");
const { generateEmbedding } = require("../services/ai");

const URI = process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy";

async function backfillembeddings() {
    try {
        await mongoose.connect(URI);
        console.log("✅ Connected to MongoDB");

        const blogs = await Blog.find({
            $or: [
                { embedding: { $exists: false } },
                { embedding: { $size: 0 } }
            ]
        });

        console.log(`🔍 Found ${blogs.length} blogs needing embeddings...`);

        for (const blog of blogs) {
            console.log(`🧠 Generating embedding for: "${blog.title}"...`);

            let attempts = 0;
            let success = false;

            while (!success && attempts < 3) {
                try {
                    const fullText = `${blog.title} ${blog.body.replace(/<[^>]*>/g, '')}`;
                    const embedding = await generateEmbedding(fullText);

                    if (embedding.length > 0) {
                        blog.embedding = embedding;
                        await blog.save();
                        console.log(`✅ Saved embedding for: "${blog.title}"`);
                        success = true;
                    } else {
                        console.log(`⚠️ Skipped (No embedding generated): "${blog.title}"`);
                        break; // Don't retry if it just returned empty
                    }
                } catch (err) {
                    console.error(`❌ Error (Attempt ${attempts + 1}):`, err.message || err);
                    attempts++;
                    if (attempts < 3) {
                        console.log("⏳ Rate limit hit? Waiting 60 seconds before retrying...");
                        await new Promise(r => setTimeout(r, 60000));
                    }
                }
            }

            // Standard Rate limit safety (5 second pause between success)
            await new Promise(r => setTimeout(r, 5000));
        }

        console.log("🎉 All done!");
        process.exit(0);
    } catch (err) {
        console.error("❌ Error:", err);
        process.exit(1);
    }
}

backfillembeddings();
