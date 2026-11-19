// ✍️ ML tools for writers, used from the editor.
//
//   POST /writer/suggest-tags   tags + category, from similar posts and AI
//   POST /writer/review         AI review: grammar, clarity, tone
//   POST /writer/originality    is this too close to a post already on Lumina?
//   GET  /writer/best-time      when this writer's audience reads (?tz=<minutes>)
//
// Readability and the headline score run in the browser
// (public/javascript/writing-core.js); these are the parts that need data or AI.
const express = require("express");
const rateLimit = require("express-rate-limit");
const Blog = require("../models/blog");
const ReadEvent = require("../models/readEvent");
const logger = require("../services/logger");
const { cache, makeRateLimitStore } = require("../services/redis");
const { generateEmbedding, generateJson, aiEnabled } = require("../services/ai");
const { nearestPosts } = require("../services/ml/corpus");
const { voteFromNeighbours, cleanTags, tagKey } = require("../services/ml/tagger");
const { stripHtml, shingles, containment } = require("../services/ml/text");
const { bestPublishTimes } = require("../services/ml/bestTime");
const { getTaxonomy } = require("../services/taxonomy");
const { requireFeature } = require("../services/unlocks");

const router = express.Router();
const OBJECT_ID = /^[a-f\d]{24}$/i;

router.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Sign in to use writing tools." });
  next();
});

const perUser = (max, prefix) =>
  rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    store: makeRateLimitStore(prefix),
    handler: (req, res) => res.status(429).json({ error: "Slow down a little — try again in a minute." }),
  });

const draftText = (req) => {
  const title = String((req.body && req.body.title) || "").slice(0, 300);
  const plain = stripHtml((req.body && req.body.body) || "").slice(0, 20000);
  return { title, plain, text: `${title}\n\n${plain}`.trim() };
};
const ownId = (req) => (OBJECT_ID.test(String(req.body && req.body.blogId)) ? String(req.body.blogId) : null);

// ---------------------------------------------------------------------------
// Tags + category
// ---------------------------------------------------------------------------
router.post("/suggest-tags", perUser(12, "rl:writer-tags:"), async (req, res) => {
  const { title, plain, text } = draftText(req);
  if (plain.split(/\s+/).length < 15 && title.length < 5) {
    return res.status(400).json({ error: "Write a title and a few sentences first." });
  }
  try {
    const taxonomy = await getTaxonomy();
    const categories = (taxonomy.categories || []).filter(Boolean);
    const vocab = (taxonomy.trendingTagsList || []).map((t) => t._id).concat(taxonomy.tags || []);

    // 1) Similar posts vote (works without the AI text model).
    const vector = await generateEmbedding(text);
    const neighbours = vector.length
      ? await nearestPosts(vector, { limit: 15, excludeIds: ownId(req) ? [ownId(req)] : [] })
      : [];
    const vote = voteFromNeighbours(neighbours.map((n) => ({ similarity: n.score, tags: n.tags, category: n.category })));

    // 2) AI, told to prefer the site's existing categories and tags.
    let ai = null;
    // The AI half only once AI helpers are unlocked; similar posts always vote.
    if (aiEnabled() && (!req.unlocks || req.unlocks.has("ai"))) {
      ai = await generateJson(
        "You tag blog posts. Choose ONE category from this list (exact spelling): " +
          JSON.stringify(categories.slice(0, 40)) +
          ". Then give 3-5 specific tags; prefer these existing tags when they fit: " +
          JSON.stringify([...new Set(vocab)].slice(0, 80)) +
          '. Tags are 1-3 words, no "#".\n\nTitle: ' + title + "\n\nPost:\n" + plain.slice(0, 3000) +
          '\n\nReturn JSON: {"category":"...","tags":["..."]}'
      );
    }

    const aiTags = ai && Array.isArray(ai.tags) ? ai.tags.filter((t) => typeof t === "string") : [];
    const merged = cleanTags([...aiTags, ...vote.tags.map((t) => t.tag)], { vocabulary: vocab, max: 8 });
    const aiKeys = new Set(aiTags.map(tagKey));
    const voteKeys = new Set(vote.tags.map((t) => tagKey(t.tag)));
    const tags = merged.map((tag) => {
      const k = tagKey(tag);
      const source = aiKeys.has(k) && voteKeys.has(k) ? "both" : aiKeys.has(k) ? "ai" : "similar";
      return { tag, source };
    });
    // Agreed-on tags first.
    tags.sort((a, b) => (a.source === "both" ? -1 : 0) - (b.source === "both" ? -1 : 0));

    let category = null;
    const aiCat = ai && typeof ai.category === "string"
      ? categories.find((c) => c.toLowerCase() === ai.category.trim().toLowerCase())
      : null;
    if (aiCat) category = { value: aiCat, source: vote.category && vote.category.category.toLowerCase() === aiCat.toLowerCase() ? "both" : "ai" };
    else if (vote.category && vote.category.confidence >= 0.4) category = { value: vote.category.category, source: "similar" };

    res.json({ category, tags, basedOn: { similarPosts: vote.voters, ai: !!ai } });
  } catch (err) {
    logger.error("❌ Tag suggestion error:", err);
    res.status(500).json({ error: "Couldn't suggest tags right now." });
  }
});

// ---------------------------------------------------------------------------
// AI writing review
// ---------------------------------------------------------------------------
router.post("/review", requireFeature("ai"), perUser(4, "rl:writer-review:"), async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI review isn't configured on this site." });
  const { title, plain } = draftText(req);
  if (plain.split(/\s+/).length < 40) return res.status(400).json({ error: "Write at least a paragraph or two first." });
  try {
    const out = await generateJson(
      "You are a careful copy editor. Review this blog post for grammar and spelling mistakes, unclear " +
        "sentences, and tone problems (preachy, defensive, overly formal for a blog). Report at most 8 of the " +
        "most useful issues, most important first. Quote the exact words from the text (max 15 words) so the " +
        "writer can find them. Don't rewrite the whole post and don't comment on topic choice.\n\n" +
        "Title: " + title + "\n\nPost:\n" + plain.slice(0, 12000) +
        '\n\nReturn JSON: {"summary":"one or two sentences on overall quality",' +
        '"tone":"one or two words","issues":[{"type":"grammar|clarity|tone|spelling","quote":"...","suggestion":"..."}]}',
      { timeoutMs: 30000 }
    );
    if (!out) return res.status(502).json({ error: "The AI didn't answer. Try again in a moment." });
    const TYPES = new Set(["grammar", "clarity", "tone", "spelling"]);
    const issues = (Array.isArray(out.issues) ? out.issues : [])
      .filter((i) => i && typeof i.quote === "string" && typeof i.suggestion === "string")
      .slice(0, 8)
      .map((i) => ({
        type: TYPES.has(i.type) ? i.type : "clarity",
        quote: i.quote.slice(0, 160),
        suggestion: i.suggestion.slice(0, 300),
        // Only show issues whose quote really is in the text.
        found: plain.toLowerCase().includes(i.quote.toLowerCase().slice(0, 40)),
      }))
      .filter((i) => i.found);
    res.json({
      summary: typeof out.summary === "string" ? out.summary.slice(0, 400) : "",
      tone: typeof out.tone === "string" ? out.tone.slice(0, 40) : "",
      issues,
    });
  } catch (err) {
    logger.error("❌ Writing review error:", err);
    res.status(500).json({ error: "Couldn't review the post right now." });
  }
});

// ---------------------------------------------------------------------------
// Originality
// ---------------------------------------------------------------------------
router.post("/originality", requireFeature("ai"), perUser(10, "rl:writer-orig:"), async (req, res) => {
  const { plain, text } = draftText(req);
  if (plain.split(/\s+/).length < 30) return res.status(400).json({ error: "Write a bit more first." });
  try {
    const vector = await generateEmbedding(text);
    if (!vector.length) return res.status(503).json({ error: "The similarity check isn't available right now." });

    const exclude = ownId(req) ? [ownId(req)] : [];
    const near = await nearestPosts(vector, { limit: 6, minScore: 0.75, excludeIds: exclude });
    const docs = await Blog.find({ _id: { $in: near.map((n) => n._id) }, status: "published" })
      .select("title slug body createdBy")
      .populate("createdBy", "fullName")
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const mine = shingles(plain);

    const matches = near
      .filter((n) => byId.has(String(n._id)))
      .map((n) => {
        const d = byId.get(String(n._id));
        const theirs = shingles(d.body);
        // Either direction: a short draft copied into a long post, or the reverse.
        const overlap = Math.max(containment(mine, theirs), containment(theirs, mine));
        const isOwn = d.createdBy && String(d.createdBy._id) === String(req.user._id);
        const level = overlap >= 0.25 || n.score >= 0.97 ? "copy" : n.score >= 0.86 ? "similar" : "related";
        return {
          title: d.title,
          url: `/blog/${d.slug || d._id}`,
          author: d.createdBy ? d.createdBy.fullName : null,
          isOwn,
          similarity: Math.round(n.score * 100),
          overlap: Math.round(overlap * 100),
          level,
        };
      })
      .sort((a, b) => b.overlap - a.overlap || b.similarity - a.similarity);

    const worst = matches.find((m) => !m.isOwn && m.level === "copy")
      ? "copy"
      : matches.some((m) => m.level !== "related") ? "similar" : "original";
    res.json({ verdict: worst, matches: matches.filter((m) => m.level !== "related").slice(0, 5) });
  } catch (err) {
    logger.error("❌ Originality check error:", err);
    res.status(500).json({ error: "Couldn't run the check right now." });
  }
});

// ---------------------------------------------------------------------------
// Best time to publish
// ---------------------------------------------------------------------------
const MIN_SAMPLE = 30;

router.get("/best-time", requireFeature("bestTime"), perUser(20, "rl:writer-time:"), async (req, res) => {
  const tz = Math.max(-840, Math.min(840, parseInt(req.query.tz, 10) || 0));
  const key = `besttime:${req.user._id}:${tz}`;
  try {
    const cached = await cache.get(key);
    if (cached) return res.json(cached);

    const since = new Date(Date.now() - 90 * 864e5);
    const followers = (req.user.followers || []).slice(0, 5000);
    // Your audience: people reading your posts, and your followers reading anything.
    let events = await ReadEvent.find({
      createdAt: { $gte: since },
      $or: [{ authorId: req.user._id }, ...(followers.length ? [{ userId: { $in: followers } }] : [])],
    })
      .select("createdAt")
      .limit(20000)
      .lean();
    let source = "audience";
    if (events.length < MIN_SAMPLE) {
      // Not enough of your own audience yet: when Lumina readers read in general.
      events = await ReadEvent.find({ createdAt: { $gte: new Date(Date.now() - 30 * 864e5) } })
        .select("createdAt")
        .sort({ createdAt: -1 })
        .limit(20000)
        .lean();
      source = "site";
    }
    if (events.length < MIN_SAMPLE) {
      return res.json({ source: "none", slots: [], sample: events.length });
    }

    const result = { source, ...bestPublishTimes(events.map((e) => e.createdAt), { tzOffsetMinutes: tz }) };
    await cache.set(key, result, 60 * 60);
    res.json(result);
  } catch (err) {
    logger.error("❌ Best time error:", err);
    res.status(500).json({ error: "Couldn't work out the best time right now." });
  }
});

module.exports = router;
