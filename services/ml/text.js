// Text utilities for the ML features: tokenising, keywords (TF-IDF), and
// overlap measures for the originality check. Pure functions, no I/O.

const STOPWORDS = new Set((
  "a about above after again against all am an and any are aren't as at be because been before being below between both " +
  "but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had " +
  "hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd " +
  "i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only " +
  "or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that " +
  "that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through " +
  "to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which " +
  "while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves " +
  "also just like get got one two can will may might much many even really make made use used using way new well know " +
  "think want need lot things thing something every us still yet back first last see go going come take"
).split(" "));

const stripHtml = (html) =>
  String(html || "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

// Lowercase word tokens (letters/digits, inner apostrophes and hyphens kept).
const words = (text) =>
  (String(text || "").toLowerCase().match(/[a-z0-9À-ɏ]+(?:['’-][a-z0-9À-ɏ]+)*/g) || []).map((w) =>
    w.replace(/’/g, "'")
  );

const contentWords = (text) => words(text).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));

/**
 * Top keywords per document group by TF-IDF. `groups` is an array of arrays of
 * strings (e.g. the titles + tags of the posts in one topic). Returns, per
 * group, its best `top` terms. Bigrams are included so "machine learning"
 * survives as a phrase.
 */
function groupKeywords(groups, { top = 5 } = {}) {
  const isContent = (w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w);
  const termsOf = (texts) => {
    const counts = new Map();
    for (const t of texts) {
      const ws = words(t);
      for (let i = 0; i < ws.length; i++) {
        if (!isContent(ws[i])) continue;
        counts.set(ws[i], (counts.get(ws[i]) || 0) + 1);
        // Phrases only from words that were really next to each other — not
        // stitched together across a dropped "for" or "the".
        if (i + 1 < ws.length && isContent(ws[i + 1])) {
          const bi = ws[i] + " " + ws[i + 1];
          counts.set(bi, (counts.get(bi) || 0) + 1.5); // phrases slightly favoured
        }
      }
    }
    return counts;
  };
  const tfs = groups.map(termsOf);
  const df = new Map();
  for (const tf of tfs) for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const n = groups.length;
  return tfs.map((tf) => {
    const scored = [...tf.entries()]
      .filter(([, c]) => c >= 1.5) // must appear more than once (or as a phrase)
      .map(([term, c]) => [term, c * Math.log(1 + n / (df.get(term) || 1))]);
    scored.sort((a, b) => b[1] - a[1]);
    const out = [];
    for (const [term] of scored) {
      // Skip a term that shares a word with one already chosen, so the list
      // isn't "machine learning, learning models, models explained".
      const parts = term.split(" ");
      if (out.some((t) => t.split(" ").some((w) => parts.includes(w)))) continue;
      out.push(term);
      if (out.length >= top) break;
    }
    return out;
  });
}

// ---- Originality: word shingles ----

// Set of hashed k-word shingles. Hashing keeps memory small for long posts.
function shingles(text, k = 6) {
  const ws = words(stripHtml(text));
  const out = new Set();
  for (let i = 0; i + k <= ws.length; i++) out.add(fnv1a(ws.slice(i, i + k).join(" ")));
  return out;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * How much of `a` also appears in `b` (0..1): the share of a's shingles found
 * in b. Asymmetric on purpose — a short post copied wholesale into a long one
 * should score 1 from the short post's side.
 */
function containment(aSet, bSet) {
  if (!aSet.size) return 0;
  let hit = 0;
  for (const s of aSet) if (bSet.has(s)) hit++;
  return hit / aSet.size;
}

function jaccard(aSet, bSet) {
  if (!aSet.size && !bSet.size) return 0;
  let inter = 0;
  for (const s of aSet) if (bSet.has(s)) inter++;
  return inter / (aSet.size + bSet.size - inter);
}

module.exports = { STOPWORDS, stripHtml, words, contentWords, groupKeywords, shingles, containment, jaccard };
