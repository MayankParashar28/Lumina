// Small vector helpers shared by the ML features. Pure functions, no I/O.

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

// Unit-length copy (zero vector stays zero).
function normalize(a) {
  const n = norm(a);
  if (!n) return a.slice();
  return a.map((x) => x / n);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  return dot(a, b) / (na * nb);
}

/**
 * Weighted mean of vectors, each normalised first so long and short posts
 * count equally. Items: { vector, weight }. Returns null when nothing usable.
 */
function weightedCentroid(items) {
  let sum = null;
  let total = 0;
  for (const { vector, weight } of items) {
    if (!Array.isArray(vector) || !vector.length || !(weight > 0)) continue;
    if (sum && vector.length !== sum.length) continue; // mixed dimensions: skip
    const v = normalize(vector);
    if (!sum) sum = new Array(v.length).fill(0);
    for (let i = 0; i < v.length; i++) sum[i] += v[i] * weight;
    total += weight;
  }
  if (!sum || !total) return null;
  return normalize(sum.map((x) => x / total));
}

module.exports = { dot, norm, normalize, cosine, weightedCentroid };
