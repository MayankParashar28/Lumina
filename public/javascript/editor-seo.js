// Live "search appearance" preview in the post editor.
//
// Cosmetic only. The authoritative slug and meta description are produced
// server-side (utils/slug.js and the model hooks in models/blog.js); this just
// shows the author what they are about to get. slugify() below mirrors
// utils/slug.js — if that changes, change this too, but a drift between them
// costs a slightly wrong preview, never a wrong URL.
(function () {
  "use strict";

  var FOLD = {
    "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "æ": "ae", "ç": "c",
    "è": "e", "é": "e", "ê": "e", "ë": "e", "ì": "i", "í": "i", "î": "i", "ï": "i",
    "ñ": "n", "ò": "o", "ó": "o", "ô": "o", "õ": "o", "ö": "o", "ø": "o", "œ": "oe",
    "ß": "ss", "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y", "ÿ": "y",
    "þ": "th", "ð": "d"
  };
  var MAX_BASE_LENGTH = 70;

  function slugify(title) {
    var base = String(title || "")
      .toLowerCase()
      .replace(/[À-ÿ]/g, function (ch) { return FOLD[ch] || ch; })
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/['‘’ʼ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (base.length <= MAX_BASE_LENGTH) return base;
    var cut = base.slice(0, MAX_BASE_LENGTH);
    var lastHyphen = cut.lastIndexOf("-");
    return (lastHyphen > MAX_BASE_LENGTH / 2 ? cut.slice(0, lastHyphen) : cut)
      .replace(/-+$/g, "");
  }

  var titleInput = document.getElementById("title");
  var metaInput = document.getElementById("metaDescription");
  var slugOut = document.getElementById("seo-slug");
  var titleOut = document.getElementById("seo-title");
  var descOut = document.getElementById("seo-desc");
  var counter = document.getElementById("meta-counter");
  var hostOut = document.querySelector(".seo-preview__host");

  // The whole block is optional: editBlog shows a fixed permalink instead of a
  // derived one, so #seo-slug may legitimately be absent.
  if (!titleInput && !metaInput) return;

  if (hostOut) hostOut.textContent = window.location.host;

  var DESC_PLACEHOLDER =
    "Add a description below, or the opening lines of your story will be used.";

  function renderSlug() {
    if (!slugOut || !titleInput) return;
    // An empty title gets a placeholder; a title that exists but slugifies to
    // nothing (all punctuation, or a script with no Latin characters) gets
    // "post", because that is what utils/slug.js will actually publish it as.
    var base = slugify(titleInput.value)
      || (titleInput.value.trim() ? "post" : "your-story-title");
    // The suffix is six hex characters from the post's id, which does not exist
    // until the first save — show it as a dimmed placeholder rather than
    // inventing a value the published URL will not have.
    slugOut.innerHTML = "";
    slugOut.appendChild(document.createTextNode("/blog/" + base));
    var suffix = document.createElement("span");
    suffix.className = "seo-preview__suffix";
    suffix.textContent = "-xxxxxx";
    suffix.title = "A short unique code is added when you publish.";
    slugOut.appendChild(suffix);
  }

  function renderTitle() {
    if (!titleOut || !titleInput) return;
    var v = titleInput.value.trim();
    titleOut.textContent = v || "Your story title";
  }

  function renderDesc() {
    if (!metaInput) return;
    var v = metaInput.value.trim();

    if (descOut) {
      descOut.textContent = v || DESC_PLACEHOLDER;
      descOut.classList.toggle("is-placeholder", !v);
    }

    if (counter) {
      var n = metaInput.value.length;
      counter.textContent = n + " / 160";
      // 160 is the hard cap (maxlength, and the model trims to it); 150 is where
      // a snippet starts being at risk of truncation in a real result.
      counter.classList.toggle("is-near", n >= 150 && n < 160);
      counter.classList.toggle("is-full", n >= 160);
    }
  }

  if (titleInput) {
    titleInput.addEventListener("input", function () { renderSlug(); renderTitle(); });
  }
  if (metaInput) {
    metaInput.addEventListener("input", renderDesc);
  }

  // Run once so a restored draft or an existing post shows its real values
  // rather than the placeholders.
  renderSlug();
  renderTitle();
  renderDesc();
})();
