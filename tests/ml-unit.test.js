// Unit tests for the pure ML modules (no database needed).
const test = require("node:test");
const assert = require("node:assert/strict");

const { cosine, weightedCentroid, normalize } = require("../services/ml/vectors");
const { reciprocalRankFusion, freshness, popularity, mmr } = require("../services/ml/rank");
const { kmeans, autoCluster, rng } = require("../services/ml/kmeans");
const { groupKeywords, shingles, containment, stripHtml } = require("../services/ml/text");
const { risingKeys, windowCounts } = require("../services/ml/trends");
const { bestPublishTimes } = require("../services/ml/bestTime");
const { normalizeTag, cleanTags, voteFromNeighbours } = require("../services/ml/tagger");
const { scoreComment, scoreAccount } = require("../services/ml/risk");
const writing = require("../public/javascript/writing-core");

// Points scattered around a few centres, in `dim` dimensions.
function blobs(centres, perBlob, dim, spread, seed = 1) {
  const random = rng(seed);
  const pts = [];
  const truth = [];
  centres.forEach((c, ci) => {
    for (let i = 0; i < perBlob; i++) {
      pts.push(c.map((x) => x + (random() - 0.5) * spread));
      truth.push(ci);
    }
  });
  return { pts, truth, dim };
}
const axis = (dim, i) => Array.from({ length: dim }, (_, j) => (j === i ? 1 : 0));

// --- vectors -------------------------------------------------------------------

test("cosine and weighted centroid", () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 100), 100);
  assert.equal(Math.round(cosine([1, 0], [0, 1]) * 100), 0);
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, "mismatched dims are 0, not NaN");
  assert.equal(cosine([], []), 0);

  // Heavier weight pulls the centroid towards it.
  const c = weightedCentroid([{ vector: [1, 0], weight: 3 }, { vector: [0, 1], weight: 1 }]);
  assert.ok(c[0] > c[1]);
  assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-9, "unit length");
  assert.equal(weightedCentroid([]), null);
  assert.equal(weightedCentroid([{ vector: [1, 0], weight: 0 }]), null);
});

// --- ranking -------------------------------------------------------------------

test("rank fusion rewards items found by both lists", () => {
  const fused = reciprocalRankFusion([
    { name: "meaning", items: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    { name: "keywords", items: [{ id: "c" }, { id: "d" }] },
  ]);
  assert.equal(fused[0].id, "c", "in both lists beats first in one");
  assert.deepEqual(fused[0].sources.sort(), ["keywords", "meaning"]);
  assert.equal(fused.length, 4);
});

test("freshness halves at the half-life, popularity is bounded", () => {
  const now = Date.now();
  assert.equal(Math.round(freshness(now, { now }) * 100), 100);
  assert.equal(Math.round(freshness(now - 14 * 864e5, { now, halfLifeDays: 14 }) * 100), 50);
  assert.ok(popularity(1e9) < 1 && popularity(1e9) > popularity(10));
  assert.equal(popularity(0), 0);
});

test("MMR spreads picks across authors and topics", () => {
  const cands = [
    { id: 1, score: 1.0, authorId: "x", vector: [1, 0] },
    { id: 2, score: 0.99, authorId: "x", vector: [1, 0.01] },
    { id: 3, score: 0.9, authorId: "y", vector: [0, 1] },
  ];
  const picked = mmr(cands, { limit: 2, lambda: 0.7 });
  assert.deepEqual(picked.map((p) => p.id), [1, 3], "the near-duplicate from the same author waits");
});

// --- clustering ----------------------------------------------------------------

test("k-means finds well-separated topics", () => {
  const dim = 8;
  const { pts, truth } = blobs([axis(dim, 0), axis(dim, 3), axis(dim, 6)], 20, dim, 0.3);
  const { labels } = kmeans(pts, 3, { seed: 3 });
  // Every true blob should map to exactly one cluster.
  for (let b = 0; b < 3; b++) {
    const ls = new Set(labels.filter((_, i) => truth[i] === b));
    assert.equal(ls.size, 1, `blob ${b} stays together`);
  }
  assert.equal(new Set(labels).size, 3);
});

test("autoCluster picks a sensible k and is deterministic", () => {
  const dim = 10;
  const { pts } = blobs([axis(dim, 0), axis(dim, 2), axis(dim, 4), axis(dim, 6)], 15, dim, 0.25, 9);
  const a = autoCluster(pts, { minK: 2, maxK: 8 });
  const b = autoCluster(pts, { minK: 2, maxK: 8 });
  assert.equal(a.k, 4);
  assert.deepEqual(a.labels, b.labels, "same input, same topics");
  assert.equal(autoCluster(pts.slice(0, 2)).k, 1, "too few posts: one group");
});

// --- text ----------------------------------------------------------------------

test("keywords describe each group, not what every group shares", () => {
  const groups = [
    ["Machine learning for beginners", "Machine learning models explained", "Training neural networks", "Neural networks and machine learning in practice"],
    ["Healthy breakfast recipes", "Easy breakfast ideas", "Recipes for a healthy week", "Healthy recipes for busy people"],
  ];
  const [ml, food] = groupKeywords(groups, { top: 3 });
  assert.ok(ml.some((k) => k.includes("machine learning") || k.includes("neural")), ml.join(","));
  assert.ok(food.some((k) => k.includes("recipes") || k.includes("healthy") || k.includes("breakfast")), food.join(","));
  assert.ok(!ml.some((k) => k.includes("recipe")));
  assert.ok(!ml.includes("learning beginners"), "no phrases stitched across a dropped word");
});

test("shingle containment catches copied text and ignores mere topic overlap", () => {
  const original = "<p>The quick brown fox jumps over the lazy dog while the farmer watches from the old wooden porch at dawn.</p>";
  const copied = "Intro line. The quick brown fox jumps over the lazy dog while the farmer watches from the old wooden porch at dawn. Outro.";
  const sameTopic = "A fox and a dog met on a farm. The farmer saw them both in the morning from his porch.";
  const o = shingles(original);
  assert.ok(containment(o, shingles(copied)) > 0.9);
  assert.equal(containment(o, shingles(sameTopic)), 0);
  assert.equal(stripHtml("<p>a&nbsp;<b>b</b></p>"), "a b");
});

// --- trends --------------------------------------------------------------------

test("rising topics: a real jump rises, steady and tiny ones don't", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const day = 864e5;
  const ev = [];
  const add = (key, n, daysAgoFrom, daysAgoTo) => {
    for (let i = 0; i < n; i++) ev.push({ key, at: now - (daysAgoFrom + ((daysAgoTo - daysAgoFrom) * i) / n) * day });
  };
  add("ai-agents", 30, 0, 7); // 30 this week
  add("ai-agents", 8, 7, 35); // ~2/week before
  add("cooking", 10, 0, 7); // steady 10/week
  add("cooking", 40, 7, 35);
  add("one-off", 2, 0, 7); // tiny
  const rising = risingKeys(windowCounts(ev, { now }));
  assert.deepEqual(rising.map((r) => r.key), ["ai-agents"]);
  assert.ok(rising[0].growth >= 5);
});

// --- best time -----------------------------------------------------------------

test("best time finds the audience's peak in the author's time zone", () => {
  // Readers active Tuesdays ~20:00 IST (14:30 UTC), plus noise.
  const base = Date.parse("2026-11-03T14:30:00Z"); // a Tuesday
  const ts = [];
  for (let w = 0; w < 6; w++) for (let i = 0; i < 10; i++) ts.push(base + w * 7 * 864e5 + i * 60000);
  ts.push(Date.parse("2026-11-05T03:00:00Z"));
  const { slots, sample, grid } = bestPublishTimes(ts, { tzOffsetMinutes: -330, leadHours: 1 });
  assert.equal(sample, 61);
  assert.equal(slots[0].peakDay, 2, "Tuesday");
  assert.equal(slots[0].peakHour, 20, "8 PM local");
  assert.equal(slots[0].hour, 19, "publish an hour before");
  assert.match(slots[0].label, /^Tuesday 7:00 PM$/);
  assert.equal(grid.length, 7);
  assert.equal(grid[0].length, 24);
  assert.deepEqual(bestPublishTimes([]).slots, []);
});

// --- tags ----------------------------------------------------------------------

test("tags get one canonical spelling", () => {
  assert.equal(normalizeTag("#poetry"), "Poetry");
  assert.equal(normalizeTag("  ##machine   learning "), "Machine Learning");
  assert.equal(normalizeTag("ai"), "AI");
  assert.equal(normalizeTag("JavaScript"), "JavaScript");
  assert.equal(normalizeTag("art of war"), "Art of War");
  assert.deepEqual(
    cleanTags(["#AI", "ai", "Poetry", "poetry ", ""], { vocabulary: ["Poetry"] }),
    ["AI", "Poetry"]
  );
});

test("tag votes come from similar posts, weighted by similarity", () => {
  const { tags, category } = voteFromNeighbours([
    { similarity: 0.9, tags: ["AI", "#Ethics"], category: "Tech" },
    { similarity: 0.8, tags: ["ai", "Future"], category: "Tech" },
    { similarity: 0.7, tags: ["Ethics", "Law"], category: "Society" },
    { similarity: 0.2, tags: ["Cooking"], category: "Food" }, // too dissimilar to vote
  ]);
  assert.deepEqual(tags.map((t) => t.tag), ["AI", "Ethics"]);
  assert.equal(category.category, "Tech");
});

// --- moderation ----------------------------------------------------------------

test("ordinary comments are low risk, even from new accounts", () => {
  const r = scoreComment({ text: "Great post, the part about caching really helped me.", accountAgeDays: 0, isVerified: false });
  assert.equal(r.level, "low");
});

test("link spam and duplicates are blocked; hostility is held", () => {
  const spam = scoreComment({
    text: "Cheap SEO services!! Click here bit.ly/xyz and www.spam.xyz to increase your traffic",
    accountAgeDays: 0,
    duplicateCount: 3,
  });
  assert.equal(spam.level, "block");
  assert.ok(spam.reasons.some((r) => /link shortener/i.test(r)));

  const rude = scoreComment({ text: "You're an idiot and nobody asked." });
  assert.equal(rude.level, "review", "rudeness goes to a human, not an automatic block");
  assert.ok(rude.reasons.includes("Insulting language"));

  const threat = scoreComment({ text: "I will find you." });
  assert.equal(threat.level, "block");
});

test("account risk flags bot-like behaviour only", () => {
  assert.equal(scoreAccount({}).level, "low");
  const bot = scoreAccount({ accountAgeDays: 0, isVerified: false, followsLastHour: 120, duplicateComments: 6, linkCommentsLastDay: 8 });
  assert.equal(bot.level, "high");
  assert.ok(bot.reasons.length >= 3);
});

// --- writing assistant ---------------------------------------------------------

test("writing analysis: readability and the issues it reports", () => {
  const easy = writing.analyze("The cat sat. The dog ran. We had fun. It was a good day.");
  assert.ok(easy.readingEase >= 80, String(easy.readingEase));
  assert.equal(easy.sentences, 4);

  const long = "This sentence " + "keeps going and going ".repeat(10) + "until it finally ends.";
  const hard = writing.analyze(long + " The report was written by the team. It is very very really important to note that we basically did it in order to win.");
  const types = hard.issues.map((i) => i.type);
  assert.ok(types.includes("long-sentence"));
  assert.ok(types.includes("wordy"));
  assert.ok(types.includes("adverbs"));
  assert.ok(types.includes("passive"));
  assert.equal(writing.sentencesOf("Dr. Smith paid $3.50 for it. Then left!").length, 2, "abbreviations and decimals don't split");
});

test("headline score prefers specific, concrete titles", () => {
  const weak = writing.headlineScore("Some thoughts");
  const strong = writing.headlineScore("7 Mistakes I Made Building My First SaaS (and How to Avoid Them)");
  const shout = writing.headlineScore("YOU WON'T BELIEVE THIS!!!");
  assert.ok(strong.score > weak.score + 25, `${strong.score} vs ${weak.score}`);
  assert.ok(shout.score < 40);
  assert.ok(weak.tips.length > 0);
  assert.equal(writing.headlineScore("").score, 0);
});

// --- topic naming --------------------------------------------------------------

test("a topic is named after the tag most of its posts share, else its keyword", () => {
  const { labelFromCluster } = require("../services/ml/tagger");
  const posts = [{ tags: ["#AI", "Ethics"] }, { tags: ["ai"] }, { tags: ["AI", "Law"] }, { tags: [] }];
  assert.equal(labelFromCluster(posts, ["machine learning"]), "AI");
  assert.equal(labelFromCluster(posts, ["machine learning"], new Set(["ai"])), "Machine Learning", "names stay distinct");
  assert.equal(labelFromCluster([{ tags: [] }], []), null);
});

// --- For you -------------------------------------------------------------------

test("a finished read counts far more than a bounce", () => {
  const { readWeight } = require("../services/ml/forYou");
  assert.equal(readWeight({ seconds: 5, depth: 0.1 }), 0.1);
  assert.ok(readWeight({ seconds: 300, depth: 1 }) > 0.95);
  assert.ok(readWeight({ seconds: 60, depth: 0.5 }, 5) > readWeight({ seconds: 20, depth: 0.3 }, 5));
});

test("For you follows what the reader engages with, explains why, and stays diverse", () => {
  const { signalWeights, rankForYou } = require("../services/ml/forYou");
  const now = Date.parse("2026-11-17T00:00:00Z");
  const dim = 6;
  const AI = axis(dim, 0);
  const FOOD = axis(dim, 3);
  const near = (v, j, e = 0.15) => v.map((x, i) => x + (i === j ? e : 0));

  // Highlighted an AI post, bounced off a food post.
  const weights = signalWeights([
    { blogId: "s-ai", kind: "highlight", at: now - 864e5 },
    { blogId: "s-food", kind: "read", seconds: 4, depth: 0.05, at: now - 864e5 },
  ], { now });
  const signalPosts = new Map([
    ["s-ai", { vector: AI, title: "Agents explained" }],
    ["s-food", { vector: FOOD, title: "Pasta night" }],
  ]);
  const candidates = [
    { _id: "c-ai-1", vector: near(AI, 1), createdAt: now, views: 10, authorId: "x", authorName: "X" },
    { _id: "c-ai-2", vector: near(AI, 2), createdAt: now, views: 10, authorId: "x", authorName: "X" },
    { _id: "c-ai-3", vector: near(AI, 4), createdAt: now, views: 10, authorId: "y", authorName: "Y" },
    { _id: "c-food", vector: near(FOOD, 5), createdAt: now, views: 500, authorId: "z", authorName: "Z" },
    { _id: "s-ai", vector: AI, createdAt: now, views: 10, authorId: "w" }, // already read
  ];
  const out = rankForYou({ weights, signalPosts, candidates, exclude: new Set(["s-ai"]), limit: 3, now });
  const ids = out.map((o) => String(o._id));
  assert.ok(!ids.includes("s-ai"), "nothing already read");
  assert.ok(ids.indexOf("c-food") === -1 || ids.indexOf("c-food") === ids.length - 1, "the bounced topic ranks last at best");
  assert.ok(ids.includes("c-ai-3"), "a second author makes the cut (diversity)");
  assert.match(out[0].reason, /Because you highlighted “Agents explained”/);
  assert.deepEqual(rankForYou({ weights: [], signalPosts: new Map(), candidates }), []);
});
