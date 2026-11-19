// services/unlockRules.js — what a member sees, and what unlocks the rest.
const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate, check } = require("../services/unlockRules");

const fresh = { posts: 0, drafts: 0, followers: 0, following: 0, reads: 0, highlights: 0, verified: false, accountAgeDays: 0 };

test("a brand-new member gets the basics, a checklist, and the next two locks", () => {
  const r = evaluate(fresh);
  for (const k of ["drafts", "highlights", "history", "vibe", "analytics", "embed", "ai", "bestTime", "newsletter"]) {
    assert.equal(r.has.has(k), false, `${k} hidden for a new member`);
  }
  assert.equal(r.checklist.length, 3);
  assert.equal(r.next.length, 2, "only the two closest locks are teased");
  assert.ok(r.next.every((n) => n.hint && typeof n.progress === "number"));
  assert.equal(r.next[0].key, "analytics", "the obvious next step: publish a first post");
  assert.equal(new Set(r.next.map((n) => n.hint.split(" (")[0])).size, 2, "no two teases with the same next step");
});

test("useful items appear as soon as there is something in them", () => {
  const r = evaluate({ ...fresh, drafts: 1, highlights: 1, reads: 3 });
  for (const k of ["drafts", "highlights", "history", "vibe"]) assert.equal(r.has.has(k), true, k);
  assert.deepEqual(r.newlyEarned, [], "showing a menu item isn't an achievement");
});

test("a first post unlocks analytics and the embed card; AI also needs a verified email", () => {
  const unverified = evaluate({ ...fresh, posts: 1 });
  assert.ok(unverified.has.has("analytics") && unverified.has.has("embed"));
  assert.equal(unverified.has.has("ai"), false);
  const verified = evaluate({ ...fresh, posts: 1, verified: true });
  assert.ok(verified.has.has("ai"));
  assert.ok(verified.newlyEarned.includes("ai"));
});

test("email followers needs followers, posts and account age together", () => {
  const almost = { ...fresh, verified: true, posts: 2, followers: 10, accountAgeDays: 13.9 };
  assert.equal(evaluate(almost).has.has("newsletter"), false);
  assert.equal(evaluate({ ...almost, accountAgeDays: 14 }).has.has("newsletter"), true);
  const c = check("newsletter", { ...almost, followers: 3 });
  const followers = c.needs.find((n) => /follower/.test(n.label));
  assert.equal(followers.current, 3);
  assert.equal(followers.target, 10);
  assert.equal(followers.met, false);
});

test("unlocks are permanent, grants and admins see everything", () => {
  const kept = evaluate(fresh, { unlocked: ["newsletter"] });
  assert.equal(kept.has.has("newsletter"), true, "earned once, kept even after followers drop");
  assert.deepEqual(kept.newlyEarned, []);
  assert.equal(evaluate(fresh, { granted: ["bestTime"] }).has.has("bestTime"), true);
  const admin = evaluate(fresh, { admin: true });
  assert.ok(["analytics", "ai", "newsletter", "drafts"].every((k) => admin.has.has(k)));
  assert.deepEqual(admin.newlyEarned, [], "admins don't get unlock notifications");
});

test("the checklist disappears once all three steps are done", () => {
  assert.deepEqual(evaluate({ ...fresh, reads: 3, following: 1, posts: 1 }).checklist, []);
  const partial = evaluate({ ...fresh, reads: 5 }).checklist;
  assert.equal(partial.filter((c) => c.done).length, 1);
});

test("progress never shows more than the target", () => {
  const c = check("bestTime", { ...fresh, posts: 9, followers: 1 });
  const posts = c.needs.find((n) => /post/.test(n.label));
  assert.equal(posts.current, posts.target);
  assert.equal(posts.met, true);
});
