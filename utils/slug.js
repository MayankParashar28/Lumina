// URL slugs for posts.
//
// Posts were addressed by raw ObjectId (/blog/68f2a1...), which tells a reader
// nothing and gives a search engine nothing to match a query against. A slug
// carries the title instead.
//
// Every slug ends in six hex characters taken from the post's ObjectId. That is
// not decoration:
//
//   1. It makes the slug unique by construction. Two posts called "Hello World"
//      get different URLs without a retry-on-collision loop, and without a
//      unique-index write conflict under concurrent publishes.
//   2. It gives the public-page cache a pattern it can recognise. index.js has
//      to decide, from the path alone and before any database lookup, whether a
//      URL is a cacheable post. "ends in -<6 hex>" distinguishes a post from the
//      sibling routes that are not posts (/blog/drafts, /blog/add-new,
//      /blog/search, /blog/featured, /blog/trending, /blog/preview) — none of
//      which can match, since none ends in a hyphen followed by six hex digits.
//
// A slug is assigned once, at creation, and deliberately never regenerated when
// the title is edited: the URL is the permalink people have already shared, and
// churning it would break those links to no benefit. The title shown on the page
// is always the current one.
const ID_SUFFIX_LENGTH = 6;

// Latin-1 letters a writer is likely to use in a title, folded to ASCII so the
// URL stays readable and typeable rather than becoming percent-escapes.
const FOLD = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", æ: "ae", ç: "c",
  è: "e", é: "e", ê: "e", ë: "e", ì: "i", í: "i", î: "i", ï: "i",
  ñ: "n", ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", œ: "oe",
  ß: "ss", ù: "u", ú: "u", û: "u", ü: "u", ý: "y", ÿ: "y", þ: "th", ð: "d",
};

// Keep the readable part short enough that the whole path stays well inside the
// ~2000 characters every browser and proxy handles, and short enough to not be
// truncated in a search result. Titles longer than this are cut at a word
// boundary so the slug does not end mid-word.
const MAX_BASE_LENGTH = 70;

function slugifyTitle(title) {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[À-ÿ]/g, (ch) => FOLD[ch] || ch)
    // Strip accents that survive as combining marks (é written as e + U+0301).
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // Apostrophes join rather than split: "don't" -> "dont", not "don-t".
    .replace(/['‘’ʼ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length <= MAX_BASE_LENGTH) return base;

  const cut = base.slice(0, MAX_BASE_LENGTH);
  const lastHyphen = cut.lastIndexOf("-");
  // Only honour the word boundary if it leaves something substantial; a title
  // whose first "word" is longer than the limit is just hard-truncated.
  return (lastHyphen > MAX_BASE_LENGTH / 2 ? cut.slice(0, lastHyphen) : cut)
    .replace(/-+$/g, "");
}

// `id` is the post's ObjectId (or its string form). The suffix is always
// present, so buildSlug never returns a bare word that could collide with a
// sibling route name.
function buildSlug(title, id) {
  const suffix = String(id || "").slice(-ID_SUFFIX_LENGTH).toLowerCase();
  // A title of nothing but punctuation or non-Latin script slugifies to "";
  // "post" keeps the URL well-formed rather than leaving a leading hyphen.
  const base = slugifyTitle(title) || "post";
  return suffix ? `${base}-${suffix}` : base;
}

// A 24-character hex string is an ObjectId, i.e. a legacy permalink.
//
// mongoose.Types.ObjectId.isValid() is deliberately not used for this: it also
// returns true for any 12-character string, so a slug like "weekly-notes"
// would be misread as an id.
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const isObjectIdParam = (value) => OBJECT_ID_RE.test(String(value || ""));

// The shape index.js and the page cache match on. Anchored, and the six-hex
// suffix is what keeps /blog/drafts and friends out.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f\d]{6}$/i;
const isSlugParam = (value) => SLUG_RE.test(String(value || ""));

module.exports = {
  slugifyTitle,
  buildSlug,
  isObjectIdParam,
  isSlugParam,
  OBJECT_ID_RE,
  SLUG_RE,
  MAX_BASE_LENGTH,
};
