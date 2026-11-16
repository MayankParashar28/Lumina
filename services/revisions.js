// Version history for posts (see models/blogRevision.js).
const BlogRevision = require("../models/blogRevision");
const { sanitizePostBody } = require("../utils/sanitize");
const logger = require("./logger");

// Consecutive autosaves within this window update one version instead of
// creating a new one each time, so history reads as sessions, not keystrokes.
const AUTOSAVE_COALESCE_MS = 10 * 60 * 1000;
const MAX_BODY = 500 * 1024;

const countWords = (html) =>
  String(html || "").replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length;

async function prune(blogId) {
  const keep = await BlogRevision.find({ blogId })
    .sort({ updatedAt: -1 })
    .skip(BlogRevision.MAX_REVISIONS)
    .select("_id")
    .lean();
  if (keep.length) await BlogRevision.deleteMany({ _id: { $in: keep.map((r) => r._id) } });
}

// Record a version. `kind` is one of the model's kinds.
async function record({ blog, authorId, title, body, kind }) {
  const cleanBody = sanitizePostBody(String(body || "").slice(0, MAX_BODY));
  const cleanTitle = String(title || "").slice(0, 300);
  const doc = {
    blogId: blog._id,
    authorId,
    title: cleanTitle,
    body: cleanBody,
    kind,
    wordCount: countWords(cleanBody),
  };

  // History starts with the post as it was, so the first autosave of an old
  // post can still be undone.
  const any = await BlogRevision.exists({ blogId: blog._id });
  if (!any && kind !== "original") {
    await BlogRevision.create({
      blogId: blog._id,
      authorId,
      title: blog.title || "",
      body: blog.body || "",
      kind: "original",
      wordCount: countWords(blog.body),
    });
  }

  if (kind === "autosave") {
    const latest = await BlogRevision.findOne({ blogId: blog._id }).sort({ updatedAt: -1 }).lean();
    if (latest && latest.title === cleanTitle && latest.body === cleanBody) {
      return { revision: latest, unchanged: true };
    }
    if (
      latest &&
      latest.kind === "autosave" &&
      String(latest.authorId) === String(authorId) &&
      Date.now() - new Date(latest.updatedAt).getTime() < AUTOSAVE_COALESCE_MS
    ) {
      const revision = await BlogRevision.findByIdAndUpdate(
        latest._id,
        { $set: { title: cleanTitle, body: cleanBody, wordCount: doc.wordCount } },
        { new: true }
      ).lean();
      return { revision };
    }
  }

  const revision = (await BlogRevision.create(doc)).toObject();
  prune(blog._id).catch((err) => logger.error("⚠️ Revision prune failed:", err.message));
  return { revision };
}

const summary = (r) => ({
  _id: String(r._id),
  kind: r.kind,
  title: r.title,
  wordCount: r.wordCount,
  updatedAt: r.updatedAt,
});

module.exports = { record, summary, countWords };
