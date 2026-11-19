// 🔓 Which features a member can see, and what unlocks the rest.
//
// Pure functions over a member's stats — no database here, so it is easy to
// test and the menu, the pages and the server all agree. Three kinds:
//
//   "core"    always on (reading, writing, profile, settings…) — not listed
//   "useful"  shown once there is something in it (My Drafts after a draft).
//             Not a reward: just no empty pages. Never blocks the page itself.
//   "earned"  unlocked by an achievement. Enforced on the server, celebrated
//             with a notification, and shown as "Unlock more" with progress.
//
// Unlocks are permanent: once earned, a feature stays even if, say, the
// follower count later drops. Thresholds can be changed with env variables.

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const T = {
  readsForHistory: num("UNLOCK_READS", 3),
  newsletterFollowers: num("UNLOCK_NEWSLETTER_FOLLOWERS", 10),
  newsletterPosts: num("UNLOCK_NEWSLETTER_POSTS", 2),
  newsletterAgeDays: num("UNLOCK_NEWSLETTER_AGE_DAYS", 14),
  bestTimePosts: num("UNLOCK_BEST_TIME_POSTS", 3),
  bestTimeFollowers: num("UNLOCK_BEST_TIME_FOLLOWERS", 5),
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;

/**
 * Each requirement: { label, current, target } — met when current >= target.
 * `stats`: { posts, drafts, followers, following, reads, highlights,
 *            verified (bool), accountAgeDays }
 */
const FEATURES = [
  // ---- shown once useful ----
  { key: "drafts", kind: "useful", label: "My Drafts", href: "/blog/drafts", group: "write",
    needs: (s) => [{ label: "save a draft", current: s.drafts, target: 1 }] },
  { key: "highlights", kind: "useful", label: "Highlights", href: "/highlights", group: "read",
    needs: (s) => [{ label: "highlight a passage", current: s.highlights, target: 1 }] },
  { key: "history", kind: "useful", label: "Recently Read", href: "/user/reading-history", group: "read",
    needs: (s) => [{ label: `read ${plural(T.readsForHistory, "story", "stories")}`, current: s.reads, target: T.readsForHistory }] },
  { key: "vibe", kind: "useful", label: "Your Vibe", href: "/user/vibe", group: "read",
    needs: (s) => [{ label: `read ${plural(T.readsForHistory, "story", "stories")}`, current: s.reads, target: T.readsForHistory }] },

  // ---- earned ----
  { key: "analytics", kind: "earned", label: "Analytics", href: "/user/analytics", group: "write",
    pitch: "See who reads your posts and when.",
    needs: (s) => [{ label: "publish your first post", current: s.posts, target: 1 }] },
  { key: "embed", kind: "earned", label: "Embed your posts", href: "/user/profile#embed-title", group: "write", inMenu: false,
    pitch: "Show your latest posts on your own website.",
    needs: (s) => [{ label: "publish your first post", current: s.posts, target: 1 }] },
  { key: "ai", kind: "earned", label: "AI writing helpers", href: "/blog/add-new", group: "write", inMenu: false,
    pitch: "Continue writing, title ideas, AI review and originality check.",
    needs: (s) => [
      { label: "verify your email", current: s.verified ? 1 : 0, target: 1 },
      { label: "publish your first post", current: s.posts, target: 1 },
    ] },
  { key: "bestTime", kind: "earned", label: "Best time to publish", href: "/user/analytics#audience-heatmap", group: "write", inMenu: false,
    pitch: "When your readers are most active, so you can schedule for it.",
    needs: (s) => [
      { label: `publish ${plural(T.bestTimePosts, "post")}`, current: s.posts, target: T.bestTimePosts },
      { label: `reach ${plural(T.bestTimeFollowers, "follower")}`, current: s.followers, target: T.bestTimeFollowers },
    ] },
  { key: "newsletter", kind: "earned", label: "Email Followers", href: "/user/newsletter", group: "write",
    pitch: "Send a note straight to your followers' inboxes.",
    needs: (s) => [
      { label: `reach ${plural(T.newsletterFollowers, "follower")}`, current: s.followers, target: T.newsletterFollowers },
      { label: `publish ${plural(T.newsletterPosts, "post")}`, current: s.posts, target: T.newsletterPosts },
      { label: `have an account for ${T.newsletterAgeDays} days`, current: Math.floor(s.accountAgeDays), target: T.newsletterAgeDays },
    ] },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Requirements of one feature with progress, and whether all are met. */
function check(key, stats) {
  const f = BY_KEY.get(key);
  if (!f) throw new Error(`Unknown feature: ${key}`);
  const needs = f.needs(stats).map((n) => ({
    ...n,
    current: Math.max(0, Math.min(n.current || 0, n.target)),
    met: (n.current || 0) >= n.target,
  }));
  return { feature: f, needs, met: needs.every((n) => n.met) };
}

/**
 * Evaluate everything for one member.
 * @param {object} stats       see FEATURES
 * @param {object} opts
 * @param {string[]} opts.unlocked  features already earned (permanent)
 * @param {string[]} opts.granted   features an admin turned on for them
 * @param {boolean}  opts.admin     admins get everything
 * @returns {{ has: Set<string>, newlyEarned: string[], next: object[], checklist: object[] }}
 */
function evaluate(stats, { unlocked = [], granted = [], admin = false } = {}) {
  const has = new Set();
  const newlyEarned = [];
  const lockedEarned = [];
  const kept = new Set([...unlocked, ...granted]);

  for (const f of FEATURES) {
    const result = check(f.key, stats);
    if (admin || kept.has(f.key) || result.met) {
      has.add(f.key);
      if (f.kind === "earned" && result.met && !kept.has(f.key) && !admin) newlyEarned.push(f.key);
    } else if (f.kind === "earned") {
      lockedEarned.push(result);
    }
  }

  // "Unlock more": the two closest locked features — fewest steps left first,
  // then the natural order of the list (Analytics before AI helpers) — skipping one whose next step is the same as an
  // already-shown one (three features all saying "publish your first post"
  // is noise; the first is enough).
  const progress = (r) => r.needs.reduce((s, n) => s + n.current / n.target, 0) / r.needs.length;
  const stepsLeft = (r) => r.needs.filter((n) => !n.met).length;
  const order = (r) => FEATURES.indexOf(r.feature);
  const seenSteps = new Set();
  const next = lockedEarned
    .sort((a, b) => stepsLeft(a) - stepsLeft(b) || order(a) - order(b) || progress(b) - progress(a))
    .filter((r) => {
      const step = (r.needs.find((n) => !n.met) || {}).label;
      if (seenSteps.has(step)) return false;
      seenSteps.add(step);
      return true;
    })
    .slice(0, 2)
    .map((r) => {
      const missing = r.needs.find((n) => !n.met);
      return {
        key: r.feature.key,
        label: r.feature.label,
        pitch: r.feature.pitch,
        hint: missing ? `${missing.label} (${missing.current}/${missing.target})` : "",
        progress: Math.round(progress(r) * 100),
      };
    });

  // Getting started: shown until all three are done.
  const checklist = [
    { label: `Read ${plural(T.readsForHistory, "story", "stories")}`, done: stats.reads >= T.readsForHistory, href: "/" },
    { label: "Follow a writer", done: stats.following >= 1, href: "/topics" },
    { label: "Publish your first post", done: stats.posts >= 1, href: "/blog/add-new" },
  ];

  return { has, newlyEarned, next, checklist: checklist.every((c) => c.done) ? [] : checklist };
}

module.exports = { FEATURES, BY_KEY, THRESHOLDS: T, check, evaluate };
