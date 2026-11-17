// k-means clustering over embeddings, for automatic topics.
//
// Vectors are normalised first, so squared Euclidean distance is a monotone
// function of cosine distance ("spherical k-means"). Seeding is k-means++ with
// a seeded RNG, so the same posts give the same topics run to run.
const { normalize, dot } = require("./vectors");

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// For unit vectors: ||a-b||^2 = 2 - 2·a·b
const dist2 = (a, b) => Math.max(0, 2 - 2 * dot(a, b));

function seedCentroids(points, k, random) {
  const centroids = [points[Math.floor(random() * points.length)]];
  const d = points.map((p) => dist2(p, centroids[0]));
  while (centroids.length < k) {
    const total = d.reduce((s, x) => s + x, 0);
    let target = random() * total;
    let idx = 0;
    for (; idx < points.length - 1; idx++) {
      target -= d[idx];
      if (target <= 0) break;
    }
    const c = points[idx];
    centroids.push(c);
    for (let i = 0; i < points.length; i++) d[i] = Math.min(d[i], dist2(points[i], c));
  }
  return centroids;
}

/**
 * @param {number[][]} vectors
 * @param {number} k
 * @returns {{ labels: number[], centroids: number[][], inertia: number }}
 */
function kmeans(vectors, k, { maxIter = 50, seed = 42 } = {}) {
  const points = vectors.map(normalize);
  const n = points.length;
  if (!n) return { labels: [], centroids: [], inertia: 0 };
  k = Math.max(1, Math.min(k, n));
  const random = rng(seed);
  let centroids = seedCentroids(points, k, random);
  const labels = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const dd = dist2(points[i], centroids[c]);
        if (dd < bestD) { bestD = dd; best = c; }
      }
      if (labels[i] !== best) { changed++; labels[i] = best; }
    }

    const dim = points[0].length;
    const sums = centroids.map(() => new Array(dim).fill(0));
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const s = sums[labels[i]];
      for (let j = 0; j < dim; j++) s[j] += points[i][j];
      counts[labels[i]]++;
    }
    centroids = centroids.map((old, c) => {
      if (!counts[c]) {
        // Empty cluster: re-seed with the point farthest from its centroid.
        let far = 0;
        let farD = -1;
        for (let i = 0; i < n; i++) {
          const dd = dist2(points[i], centroids[labels[i]]);
          if (dd > farD) { farD = dd; far = i; }
        }
        return points[far];
      }
      return normalize(sums[c]);
    });

    if (iter > 0 && changed === 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += dist2(points[i], centroids[labels[i]]);
  return { labels, centroids, inertia };
}

// Silhouette on cosine distance, over a sample (O(m²)).
function silhouette(vectors, labels, { sample = 300, seed = 7 } = {}) {
  const points = vectors.map(normalize);
  const random = rng(seed);
  const idx = points.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const use = idx.slice(0, Math.min(sample, idx.length));
  const clusters = new Set(use.map((i) => labels[i]));
  if (clusters.size < 2) return 0;
  let total = 0;
  for (const i of use) {
    const byCluster = new Map();
    for (const j of use) {
      if (i === j) continue;
      const d = 1 - dot(points[i], points[j]);
      const e = byCluster.get(labels[j]) || { s: 0, n: 0 };
      e.s += d; e.n += 1;
      byCluster.set(labels[j], e);
    }
    const own = byCluster.get(labels[i]);
    if (!own || !own.n) continue; // singleton contributes 0
    const a = own.s / own.n;
    let b = Infinity;
    for (const [c, e] of byCluster) if (c !== labels[i] && e.n) b = Math.min(b, e.s / e.n);
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
  }
  return total / use.length;
}

/**
 * Pick k automatically: try a range around sqrt(n/2) and keep the one with the
 * best silhouette. Small collections get a small k.
 */
function autoCluster(vectors, { minK = 2, maxK = 14, seed = 42 } = {}) {
  const n = vectors.length;
  if (n < 4) return { k: 1, ...kmeans(vectors, 1, { seed }), silhouette: 0 };
  const guess = Math.round(Math.sqrt(n / 2));
  const lo = Math.max(minK, Math.min(guess - 3, maxK));
  const hi = Math.min(maxK, Math.max(guess + 3, minK), n - 1);
  let best = null;
  for (let k = lo; k <= hi; k++) {
    const run = kmeans(vectors, k, { seed });
    const s = silhouette(vectors, run.labels);
    if (!best || s > best.silhouette) best = { k, ...run, silhouette: s };
  }
  return best;
}

module.exports = { kmeans, silhouette, autoCluster, rng };
