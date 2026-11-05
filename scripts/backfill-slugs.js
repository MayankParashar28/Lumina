// One-off: give every pre-existing post a slug.
//
// Posts created before utils/slug.js have no `slug`, so they keep working only
// through the ObjectId fallback in the view route — every visit costs an extra
// query and a 301, and the URL a reader sees and shares stays unreadable. This
// fills the field in so they become first-class.
//
// Safe to re-run: it only ever writes a slug to a post that has none, and it
// writes nothing else. Nothing is deleted or overwritten.
//
//   node scripts/backfill-slugs.js --dry-run   # report only, no writes
//   node scripts/backfill-slugs.js             # apply
require("dotenv").config();
const mongoose = require("mongoose");
const { buildSlug } = require("../utils/slug");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URL || process.env.MONGO_URL;
  if (!uri) throw new Error("MONGODB_URL is not set.");

  await mongoose.connect(uri);
  // The raw collection, not the model: the model's pre-validate hooks would
  // re-sanitise every body on save, which is a much larger change than this
  // script is allowed to make.
  const col = mongoose.connection.db.collection("blogs");

  const missing = await col
    .find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] })
    .project({ _id: 1, title: 1 })
    .toArray();

  console.log(`${missing.length} post(s) without a slug.`);
  if (!missing.length) return;

  // Guard against colliding with a slug that already exists. The six-hex id
  // suffix makes this essentially impossible, but a duplicate would throw on the
  // unique index and abort the run partway, so it is worth one cheap check.
  const taken = new Set(
    (await col.find({ slug: { $type: "string", $ne: "" } }).project({ slug: 1 }).toArray())
      .map((d) => d.slug)
  );

  const ops = [];
  for (const post of missing) {
    let slug = buildSlug(post.title, post._id);
    if (taken.has(slug)) {
      // Fall back to the full id, which is unique by definition.
      slug = buildSlug(post.title, String(post._id) + String(post._id).slice(0, 6));
      console.warn(`  ! collision on ${post._id}, using ${slug}`);
    }
    taken.add(slug);
    ops.push({ updateOne: { filter: { _id: post._id }, update: { $set: { slug } } } });
    console.log(`  ${post._id}  ->  /blog/${slug}`);
  }

  if (DRY_RUN) {
    console.log(`\nDry run: ${ops.length} post(s) would be updated. Nothing written.`);
    return;
  }

  const result = await col.bulkWrite(ops, { ordered: false });
  console.log(`\nUpdated ${result.modifiedCount} post(s).`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
