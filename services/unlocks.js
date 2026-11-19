// 🔓 Feature unlocks: stats, permanence, celebration, and enforcement.
// The rules themselves are in services/unlockRules.js.
//
// - Stats (posts, drafts, followers, reads, highlights…) are computed per
//   member and cached for a couple of minutes, so the menu costs nothing on
//   most page loads. Actions that change them call bust() for an instant update.
// - A feature earned once is stored on the member and kept forever.
// - The first time a member is evaluated, what they already use is unlocked
//   silently (no "you unlocked…" for things they've had all along).
// - requireFeature() enforces earned features on the server: the menu hiding
//   a link is a convenience, not a lock.
const Blog = require("../models/blog");
const User = require("../models/user");
const ReadEvent = require("../models/readEvent");
const Highlight = require("../models/highlight");
const Notification = require("../models/Notification");
const logger = require("./logger");
const { cache } = require("./redis");
const { evaluate, check, BY_KEY } = require("./unlockRules");
const { wantsJson } = require("../utils/http");

const CACHE_SECONDS = 120;
const NEW_BADGE_DAYS = 3;
const cacheKey = (id) => `unlocks:v1:${id}`;

async function computeStats(user) {
  const uid = user._id;
  const [posts, drafts, readEvents, highlights] = await Promise.all([
    Blog.countDocuments({ createdBy: uid, status: "published" }),
    Blog.countDocuments({ createdBy: uid, status: { $in: ["draft", "scheduled"] } }).limit(1),
    ReadEvent.countDocuments({ userId: uid }).limit(10),
    Highlight.countDocuments({ userId: uid }).limit(1),
  ]);
  const historyReads = new Set((user.readingHistory || []).map((h) => String(h.blogId))).size;
  return {
    posts,
    drafts,
    followers: (user.followers || []).length,
    following: (user.following || []).length,
    reads: Math.max(readEvents, historyReads),
    highlights,
    verified: user.isVerified !== false,
    accountAgeDays: user.createdAt ? (Date.now() - new Date(user.createdAt).getTime()) / 864e5 : 0,
  };
}

async function getStats(user, { fresh = false } = {}) {
  if (!fresh) {
    const hit = await cache.get(cacheKey(user._id));
    if (hit) return hit;
  }
  const stats = await computeStats(user);
  await cache.set(cacheKey(user._id), stats, CACHE_SECONDS);
  return stats;
}

/** Drop the cached stats so the next page load re-evaluates (after publishing etc.). */
function bust(userId) {
  if (!userId) return;
  const id = String(userId._id || userId); // a populated author works too
  cache.del(cacheKey(id)).catch(() => {});
}

// Features the member was already using before unlocks existed.
async function grandfathered(user) {
  const out = [];
  try {
    const Newsletter = require("../models/newsletter");
    if (await Newsletter.exists({ authorId: user._id })) out.push("newsletter");
  } catch (_) { /* model missing in some branches — nothing to grandfather */ }
  if (user.lastAiRequest) out.push("ai");
  return out;
}

async function celebrate(user, key) {
  const f = BY_KEY.get(key);
  try {
    await Notification.create({
      userId: user._id,
      senderId: user._id,
      type: "unlock",
      message: `Unlocked: ${f.label}. ${f.pitch || ""}`.trim(),
      targetUrl: f.href,
      read: false,
    });
  } catch (err) {
    logger.warn("⚠️ Unlock notification failed: %s", err.message);
  }
}

/**
 * Evaluate a member, persisting anything newly earned.
 * @returns {{ has(key):boolean, next, checklist, isNew(key):boolean, stats }}
 */
async function resolve(user) {
  const stats = await getStats(user);
  const admin = user.role === "ADMIN";
  let unlocked = (user.unlocks || []).map((u) => u.key);
  const granted = user.featureGrants || [];

  if (!user.unlocksInitializedAt && !admin) {
    // First evaluation: whatever they have earned or already use is theirs,
    // quietly. Only later unlocks get a notification.
    const initial = evaluate(stats, { unlocked, granted });
    const keys = [...new Set([...initial.newlyEarned, ...(await grandfathered(user))])];
    const now = new Date();
    await User.updateOne(
      { _id: user._id, unlocksInitializedAt: { $exists: false } },
      { $set: { unlocksInitializedAt: now, unlocks: keys.map((key) => ({ key, at: new Date(0) })) } }
    ).catch((err) => logger.warn("⚠️ Unlock init failed: %s", err.message));
    user.unlocks = keys.map((key) => ({ key, at: new Date(0) }));
    user.unlocksInitializedAt = now;
    unlocked = keys;
  }

  const result = evaluate(stats, { unlocked, granted, admin });

  for (const key of result.newlyEarned) {
    // The filter makes this a no-op if another request recorded it first,
    // so the notification is sent once.
    const res = await User.updateOne(
      { _id: user._id, "unlocks.key": { $ne: key } },
      { $push: { unlocks: { key, at: new Date() } } }
    ).catch(() => ({ modifiedCount: 0 }));
    if (res.modifiedCount) {
      (user.unlocks = user.unlocks || []).push({ key, at: new Date() });
      celebrate(user, key);
      logger.info("🔓 %s unlocked %s", String(user._id), key);
    }
  }

  const unlockedAt = new Map((user.unlocks || []).map((u) => [u.key, new Date(u.at).getTime()]));
  return {
    stats,
    has: (key) => result.has.has(key),
    check: (key) => check(key, stats), // requirements + progress, for templates
    isNew: (key) => (unlockedAt.get(key) || 0) > Date.now() - NEW_BADGE_DAYS * 864e5,
    next: result.next,
    checklist: result.checklist,
  };
}

/** Express middleware: res.locals.unlocks for signed-in members. Never fails a request. */
async function attach(req, res, next) {
  if (!req.user) return next();
  try {
    req.unlocks = await resolve(req.user);
    res.locals.unlocks = req.unlocks;
  } catch (err) {
    logger.error("⚠️ Unlock evaluation failed: %s", err.message);
    // Fail open: a broken counter must not take features away.
    req.unlocks = res.locals.unlocks = {
      has: () => true, isNew: () => false, check: () => ({ needs: [], met: true }), next: [], checklist: [], stats: null,
    };
  }
  next();
}

/**
 * Route guard for an earned feature. Signed-out requests pass through (the
 * route's own sign-in check answers them).
 */
function requireFeature(key) {
  return (req, res, next) => {
    if (!req.user) return next();
    const u = req.unlocks;
    if (!u || u.has(key)) return next();
    const { feature, needs } = check(key, u.stats);
    if (wantsJson(req) || req.method !== "GET") {
      const missing = needs.filter((n) => !n.met).map((n) => `${n.label} (${n.current}/${n.target})`);
      return res.status(403).json({
        locked: true,
        feature: key,
        error: `${feature.label} unlocks when you ${missing.join(" and ")}.`,
        needs,
      });
    }
    return res.status(403).render("locked", {
      title: `${feature.label} - Lumina`,
      feature,
      needs,
      searchQuery: "",
    });
  };
}

module.exports = { attach, requireFeature, resolve, bust, getStats };
