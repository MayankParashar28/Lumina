// 🧱 Phase-4 scaling: background job processors.
//
// Each processor runs identically whether invoked inline (no queue configured) or
// by a BullMQ worker, so behaviour is unchanged in dev/tests. Real-time emits use
// a shared Socket.io instance set by the host process (`setIo`), which with the
// Redis adapter reaches clients on every app instance.
const logger = require("./logger");

let io = null;
function setIo(instance) { io = instance; }

// --- Generate and store a blog's embedding (moves Gemini off the request path) ---
async function embedJob({ blogId, text }) {
  const { generateEmbedding } = require("./ai");
  const Blog = require("../models/blog");
  const embedding = await generateEmbedding(text);
  if (embedding && embedding.length > 0) {
    await Blog.findByIdAndUpdate(blogId, { embedding });
  }
}

// --- Notification fan-out: self + every follower (the insertMany + socket storm) ---
//
// There is exactly one copy of this. There used to be three — here, in the
// scheduler, and inline in the edit route — which is why a scheduled post and a
// published draft each notified followers in their own slightly different way
// and neither of them sent the follower emails this job sends.
//
// `ioOverride` exists for the scheduler, which is handed a Socket.io instance by
// its caller rather than reading the one `setIo` stored. It is a parameter and
// not part of `data` on purpose: `data` is serialised into the queue, and a
// socket server cannot be.
async function runFanout({ authorId, blogId, title, scheduled, fromDraft }, ioOverride) {
  const User = require("../models/user");
  const Notification = require("../models/Notification");
  const emit = ioOverride || io;

  const author = await User.findById(authorId).populate("followers", "fullName");
  if (!author) return;

  const selfMessage = scheduled
    ? `Your scheduled post is now live: "${title}"`
    : fromDraft
      ? `You published your draft: "${title}"`
      : `You successfully uploaded a new blog: "${title}"`;
  await Notification.create({
    userId: author._id, senderId: author._id, type: "blog_upload",
    message: selfMessage, blogId, targetUrl: `/blog/${blogId}`, read: false, createdAt: new Date(),
  });

  if (author.followers && author.followers.length > 0) {
    // "uploaded" only for a post written and published in one go; a draft or a
    // scheduled post was already written, so it reads as "published".
    const verb = scheduled || fromDraft ? "published" : "uploaded";
    const notifs = author.followers.map((f) => ({
      userId: f._id, senderId: author._id, type: "blog_upload",
      message: `${author.fullName} ${verb} a new blog: "${title}"`,
      blogId, targetUrl: `/blog/${blogId}`, read: false, createdAt: new Date(),
    }));
    await Notification.insertMany(notifs);
    if (emit) notifs.forEach((n) => emit.to(`user:${n.userId}`).emit("new_notification", { message: n.message }));

    // An in-app notification only reaches a follower who comes back on their
    // own, which is the thing following was supposed to solve. Mail them too.
    //
    // Deliberately last, and deliberately swallowing its own errors: the
    // notifications above are the part that must not be lost, and a mail
    // provider having a bad minute is not a reason to fail a publish.
    await emailFollowers(author, { blogId, title }).catch((err) =>
      logger.error("⚠️ New-post emails failed:", err.message)
    );
  }
}

// The queue's entry point: same fan-out, using the io that `setIo` stored.
async function fanoutJob(data) {
  return runFanout(data);
}

// How many follower emails one publish may send.
//
// With the queue disabled these go out inline (fire-and-forget, so the publish
// response has already been sent), one HTTPS request each. A cap keeps a
// popular author's publish from turning into a few hundred sequential requests
// and from quietly spending the mail quota. Past this, the in-app notification
// is still delivered to everyone — only the mail stops.
const MAX_FOLLOWER_EMAILS = Number(process.env.MAX_FOLLOWER_EMAILS) || 200;

async function emailFollowers(author, { blogId, title }) {
  const { sendNewPostEmail } = require("./emailService");
  const { linkFor } = require("../utils/unsubscribe");
  const User = require("../models/user");
  const Blog = require("../models/blog");

  const baseUrl = (
    process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:8000"
  ).replace(/\/+$/, "");

  // Re-query rather than reuse the populated followers above: that populate
  // selects only fullName, and this needs the address and the preference. It
  // also applies the filter in the database instead of loading every follower
  // and discarding most of them.
  //
  // isVerified matters: an unverified address was never confirmed to belong to
  // the person who typed it, so mailing it is both useless and a way to get
  // reported as spam by whoever actually owns it.
  const recipients = await User.find({
    _id: { $in: author.followers.map((f) => f._id) },
    isVerified: true,
    email: { $exists: true, $ne: "" },
    "notificationPreferences.emailOnNewPost": { $ne: false },
  })
    .select("_id email")
    .limit(MAX_FOLLOWER_EMAILS)
    .lean();

  if (!recipients.length) return;

  // The slug is the canonical URL; a post always has one by the time it
  // publishes, but fall back rather than mail a broken link.
  const post = await Blog.findById(blogId).select("slug body coverImageURL").lean();
  const url = `${baseUrl}/blog/${(post && post.slug) || blogId}`;
  const excerpt = post
    ? post.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180)
    : "";

  let sent = 0;
  for (const r of recipients) {
    try {
      await sendNewPostEmail(r.email, {
        authorName: author.fullName,
        title,
        excerpt: excerpt ? `${excerpt}\u2026` : "",
        url,
        coverImageURL: post && post.coverImageURL,
        unsubscribeUrl: linkFor(r._id, "new-post", baseUrl),
      });
      sent += 1;
    } catch (err) {
      // One bad address must not stop the rest of the list.
      logger.error("⚠️ New-post email to %s failed: %s", r.email, err.message);
    }
  }

  logger.info("📨 New-post emails: %d/%d sent for \"%s\"", sent, recipients.length, title);
}

// --- Publish any scheduled posts whose time has arrived ---
async function publishScheduledJob() {
  const { publishDueScheduled } = require("./scheduler");
  return publishDueScheduled(io);
}

const PROCESSORS = {
  embed: embedJob,
  fanout: fanoutJob,
  publishScheduled: publishScheduledJob,
};

async function runJob(name, data) {
  const fn = PROCESSORS[name];
  if (!fn) throw new Error("Unknown job: " + name);
  return fn(data || {});
}

module.exports = { setIo, runJob, runFanout, PROCESSORS };
