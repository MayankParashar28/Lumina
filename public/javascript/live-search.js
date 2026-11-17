// Live search results under any <input data-live-search> inside a search form.
//
// Results come from /blog/api/search (meaning + keywords + title). ↑/↓ move,
// Enter opens the highlighted story (or runs the full search), Escape closes.
// Requests are debounced, and a slower earlier response can never overwrite a
// newer one.
(function () {
  "use strict";
  var DEBOUNCE_MS = 250;
  var uid = 0;

  function attach(input) {
    if (input.dataset.liveSearchReady) return;
    input.dataset.liveSearchReady = "1";
    var form = input.form;
    var id = "live-search-" + ++uid;
    var list = document.createElement("ul");
    list.id = id;
    list.className = "live-search";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    document.body.appendChild(list);

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);

    var timer = null;
    var seq = 0;
    var items = [];
    var active = -1;
    var controller = null;

    function position() {
      var r = input.getBoundingClientRect();
      var width = Math.max(r.width, Math.min(380, document.documentElement.clientWidth - 16));
      var left = Math.min(r.left, document.documentElement.clientWidth - width - 8);
      list.style.width = width + "px";
      list.style.left = Math.max(8, left) + window.scrollX + "px";
      list.style.top = r.bottom + window.scrollY + 6 + "px";
    }

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function setActive(i) {
      active = i;
      Array.prototype.forEach.call(list.querySelectorAll("[role=option]"), function (li, j) {
        li.setAttribute("aria-selected", String(j === i));
        li.classList.toggle("is-active", j === i);
      });
      if (i >= 0) input.setAttribute("aria-activedescendant", id + "-opt-" + i);
      else input.removeAttribute("aria-activedescendant");
    }

    function option(i, href, title, meta, image) {
      var li = document.createElement("li");
      li.id = id + "-opt-" + i;
      li.setAttribute("role", "option");
      li.className = "live-search__item";
      var a = document.createElement("a");
      a.href = href;
      a.tabIndex = -1;
      if (image) {
        var img = document.createElement("img");
        img.src = image;
        img.alt = "";
        img.width = 40;
        img.height = 40;
        img.loading = "lazy";
        a.appendChild(img);
      }
      var text = document.createElement("span");
      text.className = "live-search__text";
      var t = document.createElement("span");
      t.className = "live-search__title";
      t.textContent = title;
      text.appendChild(t);
      if (meta) {
        var m = document.createElement("span");
        m.className = "live-search__meta";
        m.textContent = meta;
        text.appendChild(m);
      }
      a.appendChild(text);
      li.appendChild(a);
      li.addEventListener("mousedown", function (e) { e.preventDefault(); });
      li.addEventListener("mousemove", function () { if (active !== i) setActive(i); });
      return li;
    }

    function render(q, results) {
      list.replaceChildren();
      items = [];
      results.forEach(function (r, i) {
        var how = (r.matchedBy || []).indexOf("meaning") !== -1 ? "similar meaning" : "";
        var meta = [r.author, r.readTime ? r.readTime + " min" : "", how].filter(Boolean).join(" · ");
        list.appendChild(option(i, r.url, r.title, meta, r.image));
        items.push(r.url);
      });
      var allUrl = "/blog/search?q=" + encodeURIComponent(q);
      var all = option(results.length, allUrl, results.length ? "See all results for “" + q + "”" : "No quick matches — search for “" + q + "”", "", null);
      all.classList.add("live-search__all");
      list.appendChild(all);
      items.push(allUrl);
      position();
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      setActive(-1);
    }

    function search() {
      var q = input.value.trim();
      if (q.length < 2) { close(); return; }
      var mine = ++seq;
      if (controller) controller.abort();
      controller = window.AbortController ? new AbortController() : null;
      fetch("/blog/api/search?q=" + encodeURIComponent(q), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: controller ? controller.signal : undefined,
      })
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (d) {
          if (mine !== seq || document.activeElement !== input) return; // a newer search, or the reader moved on
          render(q, d.results || []);
        })
        .catch(function () {});
    }

    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(search, DEBOUNCE_MS);
    });
    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((active + 1) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive((active - 1 + items.length) % items.length); }
      else if (e.key === "Enter" && active >= 0) { e.preventDefault(); window.location.href = items[active]; }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    input.addEventListener("blur", function () { setTimeout(close, 150); });
    input.addEventListener("focus", function () { if (input.value.trim().length >= 2) search(); });
    window.addEventListener("resize", close);
    if (form) form.addEventListener("submit", close);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("input[data-live-search]"), attach);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
