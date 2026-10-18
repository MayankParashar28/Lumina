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
async function fanoutJob({ authorId, blogId, title, scheduled }) {
  const User = require("../models/user");
  const Notification = require("../models/Notification");

  const author = await User.findById(authorId).populate("followers", "fullName");
  if (!author) return;

  const selfMessage = scheduled
    ? `Your scheduled post is now live: "${title}"`
    : `You successfully uploaded a new blog: "${title}"`;
  await Notification.create({
    userId: author._id, senderId: author._id, type: "blog_upload",
    message: selfMessage, blogId, targetUrl: `/blog/${blogId}`, read: false, createdAt: new Date(),
  });

  if (author.followers && author.followers.length > 0) {
    const verb = scheduled ? "published" : "uploaded";
    const notifs = author.followers.map((f) => ({
      userId: f._id, senderId: author._id, type: "blog_upload",
      message: `${author.fullName} ${verb} a new blog: "${title}"`,
      blogId, targetUrl: `/blog/${blogId}`, read: false, createdAt: new Date(),
    }));
    await Notification.insertMany(notifs);
    if (io) notifs.forEach((n) => io.to(`user:${n.userId}`).emit("new_notification", { message: n.message }));
  }
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

module.exports = { setIo, runJob, PROCESSORS };
