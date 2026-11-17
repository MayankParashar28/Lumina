// Analytics: a 7×24 heatmap of when this writer's audience reads, in the
// viewer's own time zone, plus the best times to publish (/writer/best-time).
(function () {
  "use strict";
  var box = document.getElementById("audience-heatmap");
  if (!box) return;
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var hourLabel = function (h) { return h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : h - 12 + "p"; };

  fetch("/writer/best-time?tz=" + new Date().getTimezoneOffset(), { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      box.replaceChildren();
      if (!d.grid || !d.slots || !d.slots.length) {
        box.appendChild(el("p", "hm-note", "Not enough reading data yet. This fills in as people read your posts."));
        return;
      }
      var grid = el("div", "hm-grid");
      grid.setAttribute("role", "img");
      grid.setAttribute("aria-label", "Reading activity by day and hour. Busiest: " + d.slots.map(function (s) { return s.label; }).join(", "));
      grid.appendChild(el("span"));
      for (var h = 0; h < 24; h++) grid.appendChild(el("span", "hm-hours", h % 3 === 0 ? hourLabel(h) : ""));
      d.grid.forEach(function (row, day) {
        grid.appendChild(el("span", "hm-day", DAYS[day]));
        row.forEach(function (v, hour) {
          var c = el("span", "hm-cell");
          c.style.background = "rgba(79, 70, 229, " + (0.06 + v * 0.94).toFixed(2) + ")";
          c.title = DAYS[day] + " " + hourLabel(hour) + " — " + Math.round(v * 100) + "% of peak";
          grid.appendChild(c);
        });
      });
      box.appendChild(grid);
      var best = el("p", "hm-best");
      best.appendChild(el("strong", null, "Best times to publish: "));
      best.appendChild(document.createTextNode(d.slots.map(function (s) { return s.label; }).join(" · ")));
      box.appendChild(best);
      box.appendChild(el("p", "hm-note", (d.source === "audience"
        ? "Based on " + d.sample + " reads by your readers and followers."
        : "Based on when Lumina readers read in general (" + d.sample + " reads) — it becomes yours as your audience grows.") +
        " Times are in your time zone; each suggestion is an hour before the peak."));
    })
    .catch(function () { box.replaceChildren(el("p", "hm-note", "Couldn't load this right now.")); });
})();
