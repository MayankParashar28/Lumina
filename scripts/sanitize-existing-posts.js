// One-off backfill: run the server-side allowlist over blog bodies that were
// stored before sanitisation existed on the write paths.
//
// Nothing depends on this running — views/blog.ejs still sanitises in the
// browser before injecting a body, so old posts render safely either way. It is
// here so the database can be cleaned at a time of the operator's choosing.
//
//   node scripts/sanitize-existing-posts.js            # dry run, changes nothing
//   node scripts/sanitize-existing-posts.js --apply    # write the cleaned bodies
//
// Needs the app's .env (models/blog.js pulls in models/user.js, which requires
// JWT_SECRET at load time) and MONGODB_URL pointing at the database to clean.
//
// Take a backup before --apply. Updates are written with timestamps disabled so
// updatedAt is not bumped — the edit cooldown in routes/blog.js reads it, and a
// mass rewrite would otherwise lock every author out of editing for two minutes.
require("dotenv").config();
const mongoose = require("mongoose");
const Blog = require("../models/blog");
const { sanitizePostBody } = require("../utils/sanitize");

const URI = process.env.MONGODB_URL || "mongodb://localhost:27017/blogiFy";
const APPLY = process.argv.includes("--apply");

async function main() {
    await mongoose.connect(URI);
    console.log(`✅ Connected to ${URI.replace(/\/\/[^@]+@/, "//***@")}`);
    console.log(APPLY ? "✍️  APPLY mode — bodies will be rewritten." : "🔍 Dry run — nothing will be written. Pass --apply to write.");

    let scanned = 0;
    let changed = 0;

    const cursor = Blog.find({}).select("_id title body").lean().cursor();

    for await (const blog of cursor) {
        scanned += 1;
        if (typeof blog.body !== "string") continue;

        const clean = sanitizePostBody(blog.body);
        if (clean === blog.body) continue;

        changed += 1;
        const removed = blog.body.length - clean.length;
        console.log(`  • ${blog._id} "${blog.title}" — ${removed} chars removed`);

        if (APPLY) {
            await Blog.updateOne({ _id: blog._id }, { $set: { body: clean } }, { timestamps: false });
        }
    }

    console.log(`\n${APPLY ? "Rewrote" : "Would rewrite"} ${changed} of ${scanned} posts.`);
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error("❌ Backfill failed:", err);
    await mongoose.disconnect().catch(() => { });
    process.exit(1);
});
