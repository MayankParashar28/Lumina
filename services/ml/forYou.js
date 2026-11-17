// ✨ "For you": a personal feed learned from what each reader actually does.
//
// Signals (last 120 days), each weighted by how strongly it says "more like this":
//   read to the end / for a long time   strong     (read signals)
//   bounced within seconds              very weak
//   highlighted a passage               strong
//   liked                               strong
//   bookmarked                          medium
//   older reading history               weak (pre-dates read signals)
// …and faded with age, so the feed follows current interests.
//
// The reader's taste vector is the weighted average of those posts'
// embeddings. Candidates are scored on relevance, freshness, popularity and
// whether the reader follows the author, then diversified (MMR) so the feed
// isn't five near-identical posts from one person. Each pick says why.
const { cosine, weightedCentroid } = require("./vectors");
const { freshness, popularity, mmr } = require("./rank");

const HALF_LIFE_DAYS = 30;
const SIGNAL_WEIGHT = { highlight: 1.6, like: 1.5, bookmark: 1.2, history: 0.6 };
const REASON_VERB = { read: "read", highlight: "highlighted", like: "liked", bookmark: "saved", history: "read" };

/** Engagement weight of one reading session, 0.1 (bounce) .. 1 (read it all). */
function readWeight({ seconds = 0, depth = 0 }, readTimeMinutes = 4) {
  const expected = Math.max(60, readTimeMinutes * 60 * 0.6);
  if (seconds < 15 && depth < 0.25) return 0.1;
  const engaged = Math.max(depth, Math.min(1, seconds / expected));
  return 0.2 + 0.8 * engaged;
}

const decay = (at, now) => {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return 0.8;
  return Math.pow(0.5, Math.max(0, now - t) / 864e5 / HALF_LIFE_DAYS);
};

/**
 * Collapse raw signals into one weight per post (strongest signal wins its
 * kind, kinds add up a little).
 * signals: { blogId, kind: "read"|"highlight"|"like"|"bookmark"|"history", at?, seconds?, depth?, readTime? }[]
 */
function signalWeights(signals, { now = Date.now() } = {}) {
  const byBlog = new Map();
  for (const s of signals) {
    const id = String(s.blogId);
    let w = s.kind === "read" ? readWeight(s, s.readTime) : SIGNAL_WEIGHT[s.kind] || 0;
    w *= decay(s.at, now);
    const e = byBlog.get(id) || { blogId: id, weight: 0, best: null, bestW: 0, kinds: new Set() };
    // Same kind twice (re-reads): keep the stronger; a new kind adds on.
    if (!e.kinds.has(s.kind)) e.weight += w;
    else e.weight = Math.max(e.weight, w);
    e.kinds.add(s.kind);
    if (w > e.bestW) { e.bestW = w; e.best = s.kind; }
    byBlog.set(id, e);
  }
  return [...byBlog.values()];
}

/**
 * Rank candidate posts for a reader.
 * @param {object} p
 * @param {{blogId, weight, best}[]} p.weights           from signalWeights
 * @param {Map<string, {vector, title}>} p.signalPosts   embeddings/titles of the posts behind the signals
 * @param {{_id, vector, createdAt, views, authorId, authorName}[]} p.candidates
 * @param {Set<string>} p.following   author ids the reader follows
 * @param {Set<string>} p.exclude     posts not to recommend (already read, own posts)
 */
function rankForYou({ weights, signalPosts, candidates, following = new Set(), exclude = new Set(), limit = 10, now = Date.now() }) {
  const taste = weightedCentroid(
    weights.map((w) => ({ vector: (signalPosts.get(w.blogId) || {}).vector, weight: w.weight }))
  );
  if (!taste) return [];

  // The few strongest signals, used to explain each pick.
  const anchors = weights
    .filter((w) => signalPosts.has(w.blogId))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12)
    .map((w) => ({ ...w, ...signalPosts.get(w.blogId) }));

  const scored = [];
  for (const c of candidates) {
    const id = String(c._id);
    if (exclude.has(id) || !Array.isArray(c.vector) || c.vector.length !== taste.length) continue;
    const rel = cosine(taste, c.vector);
    if (rel < 0.2) continue;
    const follows = c.authorId && following.has(String(c.authorId));
    const score = 0.62 * rel + 0.18 * freshness(c.createdAt, { now, halfLifeDays: 21 }) + 0.08 * popularity(c.views) + (follows ? 0.12 : 0);
    scored.push({ ...c, id, rel, score, follows, authorId: c.authorId, vector: c.vector });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = mmr(scored.slice(0, limit * 4), { limit, lambda: 0.75 });

  return picked.map((p) => {
    let reason = null;
    let bestSim = 0.55; // only cite a post that is genuinely close
    for (const a of anchors) {
      const s = cosine(p.vector, a.vector);
      if (s > bestSim) { bestSim = s; reason = `Because you ${REASON_VERB[a.best] || "read"} “${a.title}”`; }
    }
    if (!reason && p.follows) reason = `From ${p.authorName || "a writer"} you follow`;
    if (!reason) reason = "Picked for your interests";
    return { _id: p._id, score: Math.round(p.score * 1000) / 1000, reason };
  });
}

module.exports = { readWeight, signalWeights, rankForYou };
