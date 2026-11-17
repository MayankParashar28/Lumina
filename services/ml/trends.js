// Trend detection: which topics/tags are rising right now.
//
// For each key we compare activity in the current window with what its own
// recent history predicts. A Poisson-style z-score asks "is this more than
// noise?", a smoothed growth ratio asks "how much more?", and a minimum count
// keeps one stray read from looking like a trend.

/**
 * @param {Map<string, {current:number, baseline:number}>|object} counts
 *   current  = events in the current window (e.g. last 7 days)
 *   baseline = events in the baseline period, already scaled to one window
 *              (e.g. previous 28 days ÷ 4)
 * @returns {{key, current, expected, growth, z, score}[]} rising keys, best first
 */
function risingKeys(counts, { minCurrent = 3, minGrowth = 1.5, minZ = 1.5, limit = 10 } = {}) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts);
  const out = [];
  for (const [key, { current = 0, baseline = 0 }] of entries) {
    if (current < minCurrent) continue;
    const expected = Math.max(baseline, 0.5); // a brand-new key still needs volume to rise
    const growth = (current + 1) / (expected + 1);
    const z = (current - expected) / Math.sqrt(expected + 1);
    if (growth < minGrowth || z < minZ) continue;
    // Rank by evidence, tempered by size so 30 vs 10 beats 4 vs 0.5.
    const score = z * Math.log2(1 + current);
    out.push({ key, current, expected: Math.round(expected * 10) / 10, growth: Math.round(growth * 10) / 10, z: Math.round(z * 10) / 10, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * Build {current, baseline} per key from timestamped events.
 * events: { key, at: Date|number, weight? }[]
 */
function windowCounts(events, { now = Date.now(), windowDays = 7, baselineWindows = 4 } = {}) {
  const w = windowDays * 864e5;
  const counts = new Map();
  for (const e of events) {
    const t = new Date(e.at).getTime();
    if (!Number.isFinite(t) || t > now) continue;
    const age = now - t;
    if (age >= w * (1 + baselineWindows)) continue;
    const c = counts.get(e.key) || { current: 0, baseline: 0 };
    const weight = e.weight == null ? 1 : e.weight;
    if (age < w) c.current += weight;
    else c.baseline += weight / baselineWindows;
    counts.set(e.key, c);
  }
  return counts;
}

module.exports = { risingKeys, windowCounts };
