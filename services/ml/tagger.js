// Tag clean-up and tag/category suggestion from similar posts.
//
// The stored tags were inconsistent ("#poetry", "Poetry", " poetry ", "ai",
// "AI"), which splits one topic across several tag pages. normalizeTag gives
// every tag one canonical spelling; canonicalTag prefers the spelling the site
// already uses most.

const ACRONYMS = new Set(["ai", "ml", "ui", "ux", "api", "css", "html", "js", "sql", "ios", "seo", "llm", "llms", "gpu", "cpu", "iot", "ar", "vr", "nft", "saas", "devops", "nlp", "aws", "gcp"]);
const SMALL = new Set(["and", "or", "of", "the", "a", "an", "in", "on", "for", "to", "with", "vs"]);

function normalizeTag(raw) {
  let t = String(raw == null ? "" : raw)
    .replace(/^[#\s]+/, "")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  if (t.length > 40) t = t.slice(0, 40).trim();
  return t
    .split(" ")
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      // Keep deliberate inner capitals (JavaScript, iPhone, OpenAI).
      if (/[a-z][A-Z]/.test(w)) return w;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

const tagKey = (t) => normalizeTag(t).toLowerCase();

/**
 * Normalise a list of tags, drop empties and case-insensitive duplicates, and
 * map each to the spelling already used on the site when there is one.
 * `vocabulary` is a list of existing tag spellings, most used first.
 */
function cleanTags(tags, { vocabulary = [], max = 8 } = {}) {
  const known = new Map();
  for (const v of vocabulary) {
    const k = tagKey(v);
    if (k && !known.has(k)) known.set(k, normalizeTag(v));
  }
  const out = [];
  const seen = new Set();
  for (const raw of tags || []) {
    const k = tagKey(raw);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(known.get(k) || normalizeTag(raw));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Vote for tags and a category from the nearest posts by meaning.
 * neighbours: { similarity:number, tags:string[], category?:string }[]
 * Each neighbour's vote is weighted by how similar it is (only reasonably
 * similar posts vote at all).
 */
function voteFromNeighbours(neighbours, { minSimilarity = 0.45, maxTags = 6 } = {}) {
  const tagVotes = new Map();
  const catVotes = new Map();
  let voters = 0;
  for (const n of neighbours) {
    const w = n.similarity;
    if (!(w >= minSimilarity)) continue;
    voters++;
    const seen = new Set();
    for (const t of n.tags || []) {
      const k = tagKey(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      const e = tagVotes.get(k) || { tag: normalizeTag(t), score: 0, count: 0 };
      e.score += w;
      e.count += 1;
      tagVotes.set(k, e);
    }
    if (n.category) {
      const ck = String(n.category).toLowerCase();
      const e = catVotes.get(ck) || { category: n.category, score: 0 };
      e.score += w;
      catVotes.set(ck, e);
    }
  }
  const tags = [...tagVotes.values()]
    .filter((e) => e.count >= 2 || voters <= 2) // a tag used by one neighbour of many is noise
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTags)
    .map((e) => ({ tag: e.tag, score: Math.round((e.score / Math.max(voters, 1)) * 100) / 100 }));
  const cats = [...catVotes.values()].sort((a, b) => b.score - a.score);
  const totalCat = cats.reduce((s, c) => s + c.score, 0);
  const category = cats[0]
    ? { category: cats[0].category, confidence: Math.round((cats[0].score / totalCat) * 100) / 100 }
    : null;
  return { tags, category, voters };
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Pick a readable label for a cluster without AI. Prefers a tag that most of
 * the cluster's posts share (authors chose those words), else the best keyword.
 */
function labelFromCluster(posts, keywords, usedLabels = new Set()) {
  const counts = new Map();
  for (const p of posts) {
    const seen = new Set();
    for (const t of p.tags || []) {
      const k = tagKey(t);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      counts.set(k, { tag: normalizeTag(t), n: ((counts.get(k) || {}).n || 0) + 1 });
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  for (const { tag, n } of ranked) {
    if (n / posts.length >= 0.3 && !usedLabels.has(tag.toLowerCase())) return tag;
  }
  for (const k of keywords) {
    const label = titleCase(k);
    if (!usedLabels.has(label.toLowerCase())) return label;
  }
  return null;
}

module.exports = { normalizeTag, tagKey, cleanTags, voteFromNeighbours, labelFromCluster };
