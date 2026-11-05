// 👁️ What a "view" means.
//
// It used to mean "a request reached the blog route", which was wrong in two
// opposite directions at once and so produced a number that could not be
// reasoned about at all:
//
//   too high — every request incremented it, unconditionally. A crawler
//              sweeping the site, a link preview fetched by WhatsApp, an uptime
//              check, or a reader who refreshed four times all counted.
//   too low  — anonymous reads are served from the page cache, which answers
//              before the route runs, so the most common read of all was never
//              counted.
//
// Counting here, in middleware ahead of that cache, fixes the second. A bot
// filter and a per-reader window fix the first.
const { createHash } = require("node:crypto");
const { cache } = require("./redis");
const logger = require("./logger");
const { isObjectIdParam, isSlugParam } = require("../utils/slug");

// How long one reader's view of one post counts for. A reader who comes back
// tomorrow is a second view; one who refreshes, opens two tabs, or follows a
// link back from the comments is not.
const DEDUP_SECONDS = Number(process.env.VIEW_DEDUP_SECONDS) || 6 * 60 * 60;

// Deliberately broad. A false negative inflates the number, which is the
// failure mode we are trying to get away from; a false positive loses one view,
// which nobody can tell. "preview" and the messenger agents are here because a
// link pasted into a chat fetches the page once per recipient's client.
const BOT_RE = new RegExp(
  [
    "bot", "crawler", "crawl", "spider", "slurp", "scrape",
    "facebookexternalhit", "whatsapp", "telegram", "discord", "slackbot",
    "twitterbot", "linkedinbot", "pinterest", "redditbot", "embedly",
    "quora link preview", "preview", "fetcher", "monitor", "uptime", "pingdom",
    "lighthouse", "headless", "phantomjs", "puppeteer", "playwright",
    "curl", "wget", "python-requests", "go-http-client", "java/", "okhttp",
    "axios", "node-fetch", "libwww", "httpclient",
  ].join("|"),
  "i"
);

// No user agent at all is not a reader either: every browser sends one.
const isBot = (ua) => !ua || BOT_RE.test(ua);

// Who is reading, for deduplication only.
//
// A signed-in reader is themselves. Everyone else is a salted hash of their
// address and browser string — enough to tell two readers apart for a few
// hours, and not something that can be turned back into an address. Nothing
// identifying is stored; the key is a digest and it expires.
function viewerKey(req) {
  if (req.user && req.user._id) return `u:${req.user._id}`;
  const salt = process.env.JWT_SECRET || "view-salt";
  const raw = `${req.ip || ""}|${req.get("user-agent") || ""}`;
  return `a:${createHash("sha256").update(salt).update(raw).digest("hex").slice(0, 20)}`;
}

/**
 * Counts one view of one post, if it is a real reader who has not been counted
 * recently. Never throws, never blocks the response.
 *
 * @returns {Promise<boolean>} whether it counted
 */
async function countView(req, idOrSlug) {
  try {
    if (req.method !== "GET") return false;
    if (isBot(req.get("user-agent"))) return false;

    const byId = isObjectIdParam(idOrSlug);
    if (!byId && !isSlugParam(idOrSlug)) return false;

    const key = `view:${idOrSlug}:${viewerKey(req)}`;
    if (await cache.get(key)) return false;
    // Set before the write, not after: two near-simultaneous requests from the
    // same reader (a browser prefetch and the click behind it) must not both
    // get past this.
    await cache.set(key, 1, DEDUP_SECONDS);

    const Blog = require("../models/blog");
    await Blog.updateOne(byId ? { _id: idOrSlug } : { slug: idOrSlug }, { $inc: { views: 1 } });
    return true;
  } catch (err) {
    // A view count is never worth failing a page read over.
    logger.error("⚠️ View count failed: %s", err.message);
    return false;
  }
}

module.exports = { countView, isBot, viewerKey, DEDUP_SECONDS, BOT_RE };
