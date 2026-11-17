// ✍️ Writing assistant + tag suggestions + best time to publish, for the editor.
//
// - Assistant drawer (the "Assistant" button): headline score and readability
//   update live as you type (computed in the browser by writing-core.js);
//   "AI review" and "Check originality" ask the server.
// - Tags: the tag "Suggest" button now proposes tags (and a category) from
//   similar posts on Lumina plus AI, as chips to accept one by one.
// - Scheduling: the schedule panel suggests when your audience reads.
(function () {
  "use strict";
  var cfg = document.getElementById("writer-tools-config");
  var W = window.LuminaWriting;
  if (!cfg || !W) return;

  var csrf = cfg.dataset.csrf;
  var blogId = cfg.dataset.blogId || null;
  var titleEl = document.getElementById("title");
  var quill = function () { return (window.LuminaEditor && window.LuminaEditor.quill) || window.quill || null; };
  var bodyText = function () { var q = quill(); return q ? q.getText() : ""; };
  var bodyHtml = function () { var q = quill(); return q ? q.root.innerHTML : ""; };

  var post = function (url, data) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(data),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        return d;
      });
    });
  };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var toast = function (msg, type) { if (window.showToast) window.showToast(msg, type || "info"); };

  // =====================================================================
  // Assistant drawer
  // =====================================================================
  var drawer = null;
  var parts = {};

  function buildDrawer() {
    drawer = el("aside", "wa-drawer");
    drawer.id = "writing-assistant";
    drawer.setAttribute("aria-label", "Writing assistant");
    drawer.hidden = true;
    drawer.innerHTML =
      '<div class="wa-head"><h2 class="wa-title">Writing assistant</h2>' +
      '<button type="button" class="wa-close" aria-label="Close assistant" title="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>' +
      '<div class="wa-body">' +
      '<section class="wa-section"><h3 class="wa-h">Headline</h3><div class="wa-headline"></div></section>' +
      '<section class="wa-section"><h3 class="wa-h">Readability</h3><div class="wa-stats"></div></section>' +
      '<section class="wa-section"><h3 class="wa-h">Suggestions</h3><ul class="wa-issues"></ul></section>' +
      '<section class="wa-section"><h3 class="wa-h">AI review</h3>' +
      '<p class="wa-note">Grammar, clarity and tone, from an AI copy editor.</p>' +
      '<button type="button" class="wa-btn" data-wa="review"><i class="fas fa-spell-check" aria-hidden="true"></i> Review my post</button>' +
      '<div class="wa-review" aria-live="polite"></div></section>' +
      '<section class="wa-section"><h3 class="wa-h">Originality</h3>' +
      '<p class="wa-note">Compares your post with stories already on Lumina (not the wider web).</p>' +
      '<button type="button" class="wa-btn" data-wa="originality"><i class="fas fa-fingerprint" aria-hidden="true"></i> Check originality</button>' +
      '<div class="wa-orig" aria-live="polite"></div></section>' +
      "</div>";
    document.body.appendChild(drawer);
    parts.headline = drawer.querySelector(".wa-headline");
    parts.stats = drawer.querySelector(".wa-stats");
    parts.issues = drawer.querySelector(".wa-issues");
    parts.review = drawer.querySelector(".wa-review");
    parts.orig = drawer.querySelector(".wa-orig");
    drawer.querySelector(".wa-close").addEventListener("click", closeDrawer);
    drawer.querySelector('[data-wa="review"]').addEventListener("click", runReview);
    drawer.querySelector('[data-wa="originality"]').addEventListener("click", runOriginality);
    // On the document, not the drawer: a button that disables itself while
    // working drops focus out of the drawer, and Escape must still close it.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drawer && !drawer.hidden) closeDrawer();
    });
  }

  var opener = null;
  function openDrawer(btn) {
    if (!drawer) buildDrawer();
    opener = btn || null;
    drawer.hidden = false;
    if (opener) opener.setAttribute("aria-expanded", "true");
    refresh();
    drawer.querySelector(".wa-close").focus();
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.hidden = true;
    if (opener) { opener.setAttribute("aria-expanded", "false"); opener.focus(); }
  }

  function meter(score, label) {
    var wrap = el("div", "wa-meter");
    var bar = el("div", "wa-meter__bar");
    var fill = el("div", "wa-meter__fill");
    fill.style.width = score + "%";
    fill.dataset.level = score >= 80 ? "strong" : score >= 65 ? "good" : score >= 45 ? "ok" : "weak";
    bar.appendChild(fill);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(score));
    bar.setAttribute("aria-label", label);
    var num = el("span", "wa-meter__num", score + " · " + label);
    wrap.append(bar, num);
    return wrap;
  }

  function refresh() {
    if (!drawer || drawer.hidden) return;
    var h = W.headlineScore(titleEl ? titleEl.value : "");
    parts.headline.replaceChildren(meter(h.score, h.label));
    if (h.tips.length) {
      var ul = el("ul", "wa-tips");
      h.tips.forEach(function (t) { ul.appendChild(el("li", null, t)); });
      parts.headline.appendChild(ul);
    }
    var note = el("p", "wa-note", "An estimate from patterns that tend to work for articles.");
    parts.headline.appendChild(note);

    var a = W.analyze(bodyText());
    parts.stats.replaceChildren();
    if (!a.words) {
      parts.stats.appendChild(el("p", "wa-note", "Start writing to see readability."));
      parts.issues.replaceChildren();
      return;
    }
    var grid = el("dl", "wa-grid");
    [
      ["Reading level", a.readingLevel + " (" + a.readingEase + ")"],
      ["School grade", String(a.grade)],
      ["Words", a.words + " · " + a.readingMinutes + " min"],
      ["Avg sentence", a.avgSentenceLength + " words"],
    ].forEach(function (pair) {
      var d = el("div");
      d.append(el("dt", null, pair[0]), el("dd", null, pair[1]));
      grid.appendChild(d);
    });
    parts.stats.appendChild(grid);

    parts.issues.replaceChildren();
    if (!a.issues.length) {
      parts.issues.appendChild(el("li", "wa-ok", "Nothing to flag — reads cleanly."));
    } else {
      a.issues.slice(0, 12).forEach(function (i) {
        var li = el("li", "wa-issue wa-issue--" + i.severity);
        li.appendChild(el("span", "wa-issue__msg", i.message));
        if (i.quote) li.appendChild(el("span", "wa-issue__quote", "“" + i.quote + "”"));
        parts.issues.appendChild(li);
      });
    }
  }

  var refreshTimer = null;
  var scheduleRefresh = function () { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 600); };
  if (titleEl) titleEl.addEventListener("input", scheduleRefresh);
  var hookQuill = function () {
    var q = quill();
    if (q) q.on("text-change", scheduleRefresh);
    else setTimeout(hookQuill, 300);
  };
  hookQuill();

  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + label; }
    else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }

  function runReview(e) {
    var btn = e.currentTarget;
    busy(btn, true, "Reviewing…");
    parts.review.replaceChildren();
    post("/writer/review", { title: titleEl ? titleEl.value : "", body: bodyHtml() })
      .then(function (d) {
        if (d.summary) parts.review.appendChild(el("p", "wa-summary", d.summary + (d.tone ? " Tone: " + d.tone + "." : "")));
        var ul = el("ul", "wa-issues");
        if (!d.issues.length) ul.appendChild(el("li", "wa-ok", "No issues found."));
        d.issues.forEach(function (i) {
          var li = el("li", "wa-issue wa-issue--ai");
          li.appendChild(el("span", "wa-tag", i.type));
          li.appendChild(el("span", "wa-issue__quote", "“" + i.quote + "”"));
          li.appendChild(el("span", "wa-issue__msg", i.suggestion));
          ul.appendChild(li);
        });
        parts.review.appendChild(ul);
      })
      .catch(function (err) { parts.review.appendChild(el("p", "wa-error", err.message)); })
      .then(function () { busy(btn, false); });
  }

  function runOriginality(e) {
    var btn = e.currentTarget;
    busy(btn, true, "Checking…");
    parts.orig.replaceChildren();
    post("/writer/originality", { title: titleEl ? titleEl.value : "", body: bodyHtml(), blogId: blogId })
      .then(function (d) {
        var text = {
          original: "Looks original — nothing on Lumina is close to this.",
          similar: "Similar posts exist. That's fine if your angle is different.",
          copy: "Large parts of this match a post already on Lumina.",
        }[d.verdict];
        parts.orig.appendChild(el("p", "wa-verdict wa-verdict--" + d.verdict, text));
        if (d.matches.length) {
          var ul = el("ul", "wa-matches");
          d.matches.forEach(function (m) {
            var li = el("li");
            var a = el("a", null, m.title);
            a.href = m.url;
            a.target = "_blank";
            a.rel = "noopener";
            li.appendChild(a);
            li.appendChild(el("span", "wa-note", (m.isOwn ? "Your post · " : (m.author ? m.author + " · " : "")) + m.similarity + "% similar in meaning" + (m.overlap ? " · " + m.overlap + "% same wording" : "")));
            ul.appendChild(li);
          });
          parts.orig.appendChild(ul);
        }
      })
      .catch(function (err) { parts.orig.appendChild(el("p", "wa-error", err.message)); })
      .then(function () { busy(btn, false); });
  }

  var openBtn = document.getElementById("open-assistant");
  if (openBtn) {
    openBtn.addEventListener("click", function () {
      if (drawer && !drawer.hidden) closeDrawer();
      else openDrawer(openBtn);
    });
  }

  // =====================================================================
  // Tag + category suggestions (replaces the old title-only AI tags)
  // =====================================================================
  var tagsInput = document.getElementById("tags");
  var categorySelect = document.getElementById("category");
  var chipBox = null;

  var currentTags = function () {
    return tagsInput.value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
  };
  var addTag = function (tag) {
    var tags = currentTags();
    if (tags.some(function (t) { return t.replace(/^#/, "").toLowerCase() === tag.toLowerCase(); })) return;
    tags.push(tag);
    tagsInput.value = tags.join(", ");
    tagsInput.dispatchEvent(new Event("input", { bubbles: true }));
  };

  if (tagsInput) {
    window.generateTags = function () {
      var btn = document.querySelector('[data-action="generateTags"]');
      if (btn) busy(btn, true, "");
      post("/writer/suggest-tags", { title: titleEl ? titleEl.value : "", body: bodyHtml(), blogId: blogId })
        .then(function (d) {
          if (!chipBox) {
            chipBox = el("div", "wa-chips");
            chipBox.setAttribute("aria-label", "Suggested tags");
            tagsInput.closest(".tag-input-wrapper").insertAdjacentElement("afterend", chipBox);
          }
          chipBox.replaceChildren();
          if (!d.tags.length) chipBox.appendChild(el("span", "wa-note", "No suggestions yet — add a little more text."));
          d.tags.forEach(function (t) {
            var chip = el("button", "wa-chip");
            chip.type = "button";
            chip.textContent = "+ " + t.tag;
            chip.title = t.source === "both" ? "Similar posts use it, and the AI suggests it" : t.source === "ai" ? "Suggested by AI" : "Used by similar posts on Lumina";
            if (t.source === "both") chip.classList.add("wa-chip--strong");
            chip.addEventListener("click", function () { addTag(t.tag); chip.remove(); });
            chipBox.appendChild(chip);
          });
          if (d.tags.length > 1) {
            var all = el("button", "wa-chip wa-chip--ghost", "Add all");
            all.type = "button";
            all.addEventListener("click", function () { d.tags.forEach(function (t) { addTag(t.tag); }); chipBox.replaceChildren(); });
            chipBox.appendChild(all);
          }
          if (d.category && categorySelect && !categorySelect.value) {
            var match = Array.prototype.find.call(categorySelect.options, function (o) {
              return o.value.toLowerCase() === d.category.value.toLowerCase();
            });
            if (match) {
              categorySelect.value = match.value;
              categorySelect.dispatchEvent(new Event("change", { bubbles: true }));
              toast("Category set to " + match.value + " — change it if it's wrong.", "success");
            }
          }
        })
        .catch(function (err) { toast("Couldn't suggest tags: " + err.message, "error"); })
        .then(function () { if (btn) busy(btn, false); });
    };
  }

  // =====================================================================
  // Best time to publish (in the schedule panel of a new post)
  // =====================================================================
  var publishAt = document.getElementById("publishAt");
  var schedulePanel = document.getElementById("schedule-panel");
  var bestLoaded = false;

  function nextOccurrence(day, hour) {
    var d = new Date();
    d.setMinutes(0, 0, 0);
    var add = (day - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + add);
    d.setHours(hour);
    if (d.getTime() <= Date.now() + 15 * 60000) d.setDate(d.getDate() + 7);
    return d;
  }
  var toLocalInput = function (d) {
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  };

  function loadBestTime() {
    if (bestLoaded || !publishAt || !schedulePanel) return;
    bestLoaded = true;
    var box = el("div", "wa-best");
    box.appendChild(el("div", "wa-best__title", "Best times for your readers"));
    var list = el("div", "wa-best__list");
    list.appendChild(el("span", "wa-note", "Working it out…"));
    box.appendChild(list);
    schedulePanel.appendChild(box);

    fetch("/writer/best-time?tz=" + new Date().getTimezoneOffset(), { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        list.replaceChildren();
        if (!d.slots || !d.slots.length) {
          list.appendChild(el("span", "wa-note", "Not enough reading data yet — check back once people have read a few posts."));
          return;
        }
        d.slots.forEach(function (s) {
          var when = nextOccurrence(s.day, s.hour);
          var b = el("button", "wa-chip", when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ", " + when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
          b.type = "button";
          b.title = "Your readers are most active around " + s.label.replace(/^\w+ /, "") + " on " + s.label.split(" ")[0] + "s";
          b.addEventListener("click", function () {
            publishAt.value = toLocalInput(when);
            publishAt.dispatchEvent(new Event("input", { bubbles: true }));
            publishAt.dispatchEvent(new Event("change", { bubbles: true }));
          });
          list.appendChild(b);
        });
        box.appendChild(el("p", "wa-note", d.source === "audience"
          ? "From when your readers and followers read on Lumina."
          : "From when Lumina readers read in general — it gets personal as your audience grows."));
      })
      .catch(function () { list.replaceChildren(el("span", "wa-note", "Couldn't load suggestions.")); });
  }
  var toggle = document.getElementById("scheduleToggle");
  if (toggle) toggle.addEventListener("click", loadBestTime);
})();
