// Ranking helpers: fusing result lists, freshness, and diversity.
const { cosine } = require("./vectors");

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one. An item ranked
 * well by more than one list rises to the top, and no list's raw scores need
 * to be comparable with another's (cosine vs. text score). k=60 is the value
 * from the original paper and works well without tuning.
 *
 * lists: { name, items: [{ id, ... }] }[]  →  [{ id, score, sources[], item }]
 */
function reciprocalRankFusion(lists, { k = 60 } = {}) {
  const byId = new Map();
  for (const { name, items, weight = 1 } of lists) {
    (items || []).forEach((item, rank) => {
      const id = String(item.id != null ? item.id : item._id);
      const entry = byId.get(id) || { id, score: 0, sources: [], item };
      entry.score += weight / (k + rank + 1);
      if (!entry.sources.includes(name)) entry.sources.push(name);
      byId.set(id, entry);
    });
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

// 1 for brand new, 0.5 after `halfLifeDays`, approaching 0 after that.
function freshness(date, { now = Date.now(), halfLifeDays = 14 } = {}) {
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now - t) / 864e5);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

// Popularity squashed to 0..1 so one viral post can't dominate.
function popularity(views, { pivot = 200 } = {}) {
  const v = Math.max(0, Number(views) || 0);
  return Math.log1p(v) / Math.log1p(v + pivot);
}

/**
 * Maximal Marginal Relevance: pick `limit` items that are relevant but not
 * near-duplicates of each other (same topic, same author). Each candidate:
 * { score, vector?, authorId? }. lambda=1 is pure relevance.
 */
function mmr(candidates, { limit = 10, lambda = 0.7, sameAuthorPenalty = 0.15 } = {}) {
  const pool = candidates.slice();
  const picked = [];
  while (picked.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let maxSim = 0;
      let authorRepeat = 0;
      for (const p of picked) {
        if (c.vector && p.vector) maxSim = Math.max(maxSim, cosine(c.vector, p.vector));
        if (c.authorId && p.authorId && String(c.authorId) === String(p.authorId)) authorRepeat += 1;
      }
      const val = lambda * c.score - (1 - lambda) * maxSim - sameAuthorPenalty * authorRepeat;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}

module.exports = { reciprocalRankFusion, freshness, popularity, mmr };
