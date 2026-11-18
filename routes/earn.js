// 💸 /earn — "Creator Rewards are coming": a waitlist that measures whether
// writers actually want a rewards program before it is built.
//
//   GET  /earn          the page (and your spot, invite link and survey once joined)
//   POST /earn/join     join (one click when signed in, email otherwise)
//   POST /earn/survey   three quick questions
//
// Nothing here promises money: the copy says rewards "may include" credits,
// perks and future cash rewards. Results are on /admin/earn.
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { EarnWaitlist, EarnVisit } = require("../models/earnWaitlist");
const Blog = require("../models/blog");
const logger = require("../services/logger");
const { cache, makeRateLimitStore } = require("../services/redis");
const { viewerKey, isBot } = require("../services/viewCounter");
const { isValidEmail, normalizeEmail, isDisposable } = require("../utils/email");
const { wantsJson } = require("../utils/http");

const router = express.Router();

const SOURCES = new Set(["nav", "home", "publish", "editor", "ref", "email", "direct"]);
const REF_RE = /^[a-z0-9]{8}$/;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const SPOTS_PER_INVITE = 5; // each friend who joins moves you up this many places
const SHOW_COUNT_FROM = 25; // don't advertise "3 people waiting"
const COOKIE = { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" };

const baseUrl = () => (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const today = () => new Date().toISOString().slice(0, 10);
const newRefCode = () => crypto.randomBytes(6).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "x").slice(0, 8);

async function findMine(req) {
  if (req.user) {
    const byUser = await EarnWaitlist.findOne({ userId: req.user._id }).lean();
    if (byUser) return byUser;
    // Joined by email before signing up: the account owns that (verified)
    // address, so attach the entry to it.
    const byEmail = await EarnWaitlist.findOne({ email: normalizeEmail(req.user.email) }).lean();
    if (byEmail && !byEmail.userId) {
      await EarnWaitlist.updateOne({ _id: byEmail._id, userId: { $exists: false } }, { $set: { userId: req.user._id } });
    }
    return byEmail;
  }
  const token = req.cookies && req.cookies.earn_token;
  if (!TOKEN_RE.test(String(token || ""))) return null;
  return EarnWaitlist.findOne({ token }).lean();
}

// Your place in line: join number, minus SPOTS_PER_INVITE for each friend.
async function spotOf(entry) {
  const score = entry.joinNumber - SPOTS_PER_INVITE * (entry.referralCount || 0);
  const ahead = await EarnWaitlist.countDocuments({
    $expr: { $lt: [{ $subtract: ["$joinNumber", { $multiply: [{ $ifNull: ["$referralCount", 0] }, SPOTS_PER_INVITE] }] }, score] },
  });
  return ahead + 1;
}

// Unique visitors per day and source. Never blocks or fails the page.
async function countVisit(req, source) {
  try {
    if (isBot(req.get("user-agent"))) return;
    const key = `earnview:${today()}:${viewerKey(req)}`;
    if (await cache.get(key)) return;
    await cache.set(key, 1, 26 * 60 * 60);
    await EarnVisit.updateOne({ day: today(), source }, { $inc: { visitors: 1 } }, { upsert: true });
  } catch (err) {
    logger.warn("⚠️ Earn visit count failed: %s", err.message);
  }
}

router.get("/", async (req, res) => {
  try {
    const ref = String(req.query.ref || "").toLowerCase();
    if (REF_RE.test(ref)) res.cookie("earn_ref", ref, { ...COOKIE, maxAge: 30 * 864e5 });
    const source = REF_RE.test(ref) ? "ref" : SOURCES.has(req.query.src) ? req.query.src : "direct";
    countVisit(req, source);

    const [mine, total] = await Promise.all([findMine(req), EarnWaitlist.estimatedDocumentCount()]);
    let me = null;
    if (mine) {
      me = {
        spot: await spotOf(mine),
        joinNumber: mine.joinNumber,
        referralCount: mine.referralCount || 0,
        inviteUrl: `${baseUrl() || `${req.protocol}://${req.get("host")}`}/earn?ref=${mine.refCode}`,
        answered: !!(mine.survey && mine.survey.answeredAt),
        founding: mine.joinNumber <= 100,
      };
    }

    res.render("earn", {
      title: "Earn on Lumina — Creator Rewards are coming",
      metaDescription: "Write, share and get rewarded. Join the Lumina Creator Rewards waitlist — the first 100 creators get a Founding Creator badge.",
      me,
      total: total >= SHOW_COUNT_FROM ? total : null,
      justJoined: req.query.joined === "1",
      surveyDone: req.query.thanks === "1",
      spotsPerInvite: SPOTS_PER_INVITE,
      searchQuery: "",
    });
  } catch (err) {
    logger.error("❌ Earn page error:", err);
    res.status(500).render("error", { message: "Could not load this page." });
  }
});

const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30, // per IP; colleges and offices share one
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRateLimitStore("rl:earn-join:"),
  handler: (req, res) => {
    if (wantsJson(req)) return res.status(429).json({ error: "Too many attempts. Try again later." });
    req.flash("error", "Too many attempts. Try again in a little while.");
    res.redirect("/earn");
  },
});

router.post("/join", joinLimiter, async (req, res) => {
  const fail = (msg) => {
    if (wantsJson(req)) return res.status(400).json({ error: msg });
    req.flash("error", msg);
    return res.redirect("/earn#join");
  };
  try {
    let email;
    let name = "";
    if (req.user) {
      email = req.user.email;
      name = req.user.fullName || "";
    } else {
      email = String((req.body && req.body.email) || "").trim();
      if (!isValidEmail(email)) return fail("Enter a valid email address.");
      if (isDisposable(email)) return fail("Please use an email address you'll keep — temporary inboxes can't join.");
    }
    const normalized = normalizeEmail(email);

    // Already on the list: nothing to do (but remember them on this browser).
    const existing = await EarnWaitlist.findOne(
      req.user ? { $or: [{ userId: req.user._id }, { email: normalized }] } : { email: normalized }
    ).select("+token").lean();
    if (existing) {
      // Signed in: it's theirs (their account's verified email) — link it.
      if (req.user && !existing.userId) {
        await EarnWaitlist.updateOne({ _id: existing._id }, { $set: { userId: req.user._id } });
      }
      // Signed out, we can't know the person typing owns that address, so this
      // never "logs them in" to the entry (no cookie): otherwise anyone could
      // type someone else's email and see their spot and invite link.
      if (wantsJson(req)) return res.json({ ok: true, already: true });
      req.flash("success", "That email is already on the waitlist.");
      return res.redirect(req.user ? "/earn#you" : "/earn#join");
    }

    // Who invited them — never themselves.
    const refRaw = String((req.body && req.body.ref) || (req.cookies && req.cookies.earn_ref) || "").toLowerCase();
    let referredBy = null;
    if (REF_RE.test(refRaw)) {
      const inviter = await EarnWaitlist.findOne({ refCode: refRaw }).select("email userId refCode").lean();
      const self = inviter && (inviter.email === normalized || (req.user && inviter.userId && String(inviter.userId) === String(req.user._id)));
      if (inviter && !self) referredBy = inviter.refCode;
    }

    const wasWriter = req.user ? !!(await Blog.exists({ createdBy: req.user._id, status: "published" })) : false;
    const source = referredBy ? "ref" : SOURCES.has(req.body && req.body.src) ? req.body.src : "direct";
    const token = crypto.randomBytes(24).toString("hex");
    const joinNumber = await EarnWaitlist.nextJoinNumber();

    let created = null;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      try {
        created = await EarnWaitlist.create({
          userId: req.user ? req.user._id : undefined,
          email: normalized,
          name,
          joinNumber,
          refCode: newRefCode(),
          referredBy,
          source,
          wasWriter,
          token,
        });
      } catch (err) {
        if (err && err.code === 11000 && /refCode/.test(err.message)) continue; // rare clash: new code
        if (err && err.code === 11000) {
          // Joined in another tab a moment ago.
          if (wantsJson(req)) return res.json({ ok: true, already: true });
          return res.redirect("/earn#you");
        }
        throw err;
      }
    }
    if (!created) throw new Error("Could not create a unique invite code");

    if (referredBy) await EarnWaitlist.updateOne({ refCode: referredBy }, { $inc: { referralCount: 1 } });
    res.clearCookie("earn_ref", COOKIE);
    if (!req.user) res.cookie("earn_token", token, { ...COOKIE, maxAge: 365 * 864e5 });

    logger.info("💸 Earn waitlist join #%d (%s%s)", joinNumber, source, referredBy ? ", invited" : "");
    if (wantsJson(req)) return res.json({ ok: true, joinNumber });
    return res.redirect("/earn?joined=1#you");
  } catch (err) {
    logger.error("❌ Earn join error:", err);
    return fail("Something went wrong. Please try again.");
  }
});

const ANSWERS = {
  motivation: ["money", "readers", "recognition", "learning"],
  frequency: ["weekly", "monthly", "occasionally"],
  invites: ["0", "1-5", "5+"],
};

router.post("/survey", async (req, res) => {
  try {
    const mine = await findMine(req);
    if (!mine) return res.redirect("/earn#join");
    const set = { "survey.answeredAt": new Date() };
    for (const [field, allowed] of Object.entries(ANSWERS)) {
      const v = String((req.body && req.body[field]) || "");
      if (allowed.includes(v)) set[`survey.${field}`] = v;
    }
    if (Object.keys(set).length === 1) {
      req.flash("error", "Pick at least one answer.");
      return res.redirect("/earn#survey");
    }
    await EarnWaitlist.updateOne({ _id: mine._id }, { $set: set });
    return res.redirect("/earn?thanks=1#you");
  } catch (err) {
    logger.error("❌ Earn survey error:", err);
    req.flash("error", "Couldn't save your answers. Please try again.");
    return res.redirect("/earn#survey");
  }
});

module.exports = router;
