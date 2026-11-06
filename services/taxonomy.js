// The category / tag vocabulary of the site, cached, plus the one place that
// turns a `?category=` / `?tag=` query string into a Mongo filter.
//
// Both the server-rendered home feed (index.js) and the JSON feed used by
// infinite scroll and the filter chips (routes/blog.js) need exactly the same
// filter. They used to build it separately, and had drifted: index.js matched
// categories with an unescaped case-insensitive regex, routes/blog.js with an
// escaped one, and only index.js understood `tag` at all. Sharing the builder
// means a filter fix lands in both.

const redisSvc = require("./redis");
const Blog = require("../models/blog");

const TAXONOMY_TTL_SECONDS = 5 * 60;

async function getTaxonomy() {
  const cached = await redisSvc.cache.get("taxonomy");
  if (cached) return cached;

  const [categories, tags, trendingTagsList] = await Promise.all([
    Blog.distinct("category"),
    Blog.distinct("tags"),
    Blog.getTrendingTags(),
  ]);

  const data = { categories, tags, trendingTagsList };
  await redisSvc.cache.set("taxonomy", data, TAXONOMY_TTL_SECONDS);
  return data;
}

const escapeRe = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Resolve a value from the URL to something an index can serve.
//
// The old code did `{ $regex: new RegExp(value, "i") }`. A case-insensitive
// regex cannot use an index, so every category or tag filter walked the whole
// published collection, and because the pattern was never escaped `?category=.*`
// matched the entire site.
//
// The known values are already in the cached taxonomy, so the common case
// becomes an equality match. Only a value missing from the cache -- a category
// used for the first time in the last five minutes -- falls back to a regex,
// and that one is anchored and escaped.
function resolveExact(known, wanted) {
  const w = String(wanted).toLowerCase();
  const hits = (known || []).filter(
    (v) => typeof v === "string" && v.toLowerCase() === w
  );
  return hits.length
    ? { $in: hits }
    : { $regex: new RegExp("^" + escapeRe(wanted) + "$", "i") };
}

// Build the { filter, sort } pair for a feed request. `taxonomy` is passed in
// so a caller that already has it does not fetch it twice.
function buildFeedQuery({ taxonomy, category, tag, search }) {
  const { categories = [], tags = [] } = taxonomy || {};
  const categoryFilter = category ? String(category).trim().toLowerCase() : "";
  const tagFilter = tag ? String(tag).trim().toLowerCase() : "";

  const filter = { status: "published" };
  // Default: "hidden gems" -- least-viewed first, newest to break ties.
  let sort = { views: 1, createdAt: -1 };

  if (search) {
    filter.$text = { $search: search };
    sort = { score: { $meta: "textScore" } };
  }

  if (categoryFilter && categoryFilter !== "all") {
    if (categoryFilter === "trending") {
      sort = { views: -1, createdAt: -1 };
    } else if (categoryFilter === "featured") {
      filter.featured = true;
      sort = { createdAt: -1 };
    } else {
      filter.category = resolveExact(categories, categoryFilter);
      sort = { createdAt: -1 };
    }
  }

  if (tagFilter) {
    filter.tags = resolveExact(tags, tagFilter);
    if (!categoryFilter || categoryFilter === "all") sort = { createdAt: -1 };
  }

  return { filter, sort };
}

// One page size for the whole feed.
//
// This was 8 in the server-rendered home page and 5 in the JSON feed, with both
// paginating by `skip = (page - 1) * limit`. The first page therefore showed
// posts 1-8 and the first infinite-scroll request asked for page 2 at limit 5,
// i.e. skip 5 -- so posts 6, 7 and 8 were rendered a second time. One constant,
// no duplicates.
const FEED_PAGE_SIZE = 8;

module.exports = { getTaxonomy, buildFeedQuery, FEED_PAGE_SIZE, TAXONOMY_TTL_SECONDS };
