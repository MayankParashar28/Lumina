/*!
 * Lumina author card — show a writer's latest Lumina posts on any website.
 *
 *   <div class="lumina-author" data-author="AUTHOR_ID"></div>
 *   <script async src="https://YOUR-LUMINA-HOST/embed/author.js"></script>
 *
 * Options (data attributes on the div):
 *   data-limit="3"          number of posts, 1–10 (default 3)
 *   data-theme="auto"       light | dark | auto (follows the visitor's setting)
 *   data-images="true"      show cover images (default true)
 *
 * Renders inside a shadow root, so the host page's CSS can't break the card
 * and the card's CSS can't leak into the page.
 */
(function () {
  "use strict";

  var script =
    document.currentScript ||
    document.querySelector('script[src*="/embed/author.js"]');
  if (!script) return;
  var ORIGIN = new URL(script.src, location.href).origin;

  var STYLE =
    ":host{all:initial;display:block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
    "--bg:#fff;--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--hover:#f9fafb}" +
    ":host([data-resolved-theme=dark]){--bg:#111827;--fg:#f9fafb;--muted:#9ca3af;--line:#374151;--hover:#1f2937}" +
    ".card{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:16px;max-width:560px;box-sizing:border-box}" +
    ".head{display:flex;align-items:center;gap:12px;margin-bottom:12px}" +
    ".avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--line)}" +
    ".name{font-weight:700;font-size:16px;color:var(--fg);text-decoration:none}" +
    ".name:hover{text-decoration:underline}" +
    ".sub{font-size:12px;color:var(--muted);margin-top:2px}" +
    ".follow{margin-left:auto;font-size:13px;font-weight:600;color:var(--bg);background:var(--fg);border-radius:999px;padding:8px 14px;text-decoration:none;white-space:nowrap}" +
    ".list{list-style:none;margin:0;padding:0}" +
    ".post{border-top:1px solid var(--line)}" +
    ".post a{display:flex;gap:12px;padding:12px 4px;color:inherit;text-decoration:none;border-radius:8px}" +
    ".post a:hover{background:var(--hover)}" +
    ".post a:focus-visible,.name:focus-visible,.follow:focus-visible{outline:2px solid #6366f1;outline-offset:2px}" +
    ".thumb{width:72px;height:56px;border-radius:6px;object-fit:cover;flex-shrink:0;background:var(--line)}" +
    ".title{font-weight:600;font-size:15px;line-height:1.35;margin:0 0 4px}" +
    ".excerpt{font-size:13px;line-height:1.5;color:var(--muted);margin:0 0 4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
    ".meta{font-size:12px;color:var(--muted)}" +
    ".empty,.error{font-size:14px;color:var(--muted);padding:8px 4px}" +
    ".foot{margin-top:8px;font-size:12px;color:var(--muted);text-align:right}" +
    ".foot a{color:inherit}" +
    "@media (max-width:420px){.thumb{display:none}.follow{padding:6px 10px}}";

  var safeUrl = function (u) {
    if (!u || typeof u !== "string") return null;
    try {
      var url = new URL(u, ORIGIN);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch (e) {
      return null;
    }
  };

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  var fmtDate = function (d) {
    try {
      return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "";
    }
  };

  function render(host) {
    if (host.__luminaRendered) return;
    host.__luminaRendered = true;

    var id = (host.getAttribute("data-author") || "").trim();
    var limit = Math.min(10, Math.max(1, parseInt(host.getAttribute("data-limit"), 10) || 3));
    var showImages = host.getAttribute("data-images") !== "false";
    var theme = host.getAttribute("data-theme") || "auto";

    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = el("style");
    style.textContent = STYLE;
    var card = el("div", "card");
    card.appendChild(el("div", "empty", "Loading…"));
    root.appendChild(style);
    root.appendChild(card);

    var setTheme = function () {
      var dark = theme === "dark" || (theme === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
      host.setAttribute("data-resolved-theme", dark ? "dark" : "light");
    };
    setTheme();
    if (theme === "auto" && window.matchMedia) {
      var mq = matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", setTheme);
    }

    if (!/^[a-f\d]{24}$/i.test(id)) {
      card.replaceChildren(el("div", "error", "Lumina: set data-author to an author id."));
      return;
    }

    fetch(ORIGIN + "/api/author/" + id + "/latest.json?limit=" + limit, { credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var a = data.author || {};
        card.replaceChildren();

        var head = el("div", "head");
        var avatar = el("img", "avatar");
        avatar.alt = "";
        avatar.width = 44;
        avatar.height = 44;
        avatar.loading = "lazy";
        var av = safeUrl(a.avatar);
        if (av) avatar.src = av;
        var who = el("div");
        var name = el("a", "name", a.name || "Lumina author");
        var profile = safeUrl(a.url);
        if (profile) {
          name.href = profile;
          name.target = "_blank";
          name.rel = "noopener";
        }
        who.appendChild(name);
        who.appendChild(el("div", "sub", "Writing on Lumina"));
        head.appendChild(avatar);
        head.appendChild(who);
        if (profile) {
          var follow = el("a", "follow", "Follow");
          follow.href = profile;
          follow.target = "_blank";
          follow.rel = "noopener";
          follow.setAttribute("aria-label", "Follow " + (a.name || "this author") + " on Lumina");
          head.appendChild(follow);
        }
        card.appendChild(head);

        var posts = data.posts || [];
        if (!posts.length) {
          card.appendChild(el("div", "empty", "No posts yet."));
          return;
        }

        var list = el("ul", "list");
        posts.forEach(function (p) {
          var href = safeUrl(p.url);
          if (!href) return;
          var li = el("li", "post");
          var link = el("a");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener";
          var img = showImages && safeUrl(p.coverImage);
          if (img) {
            var t = el("img", "thumb");
            t.src = img;
            t.alt = "";
            t.loading = "lazy";
            t.width = 72;
            t.height = 56;
            link.appendChild(t);
          }
          var text = el("div");
          text.appendChild(el("p", "title", p.title || "Untitled"));
          if (p.excerpt) text.appendChild(el("p", "excerpt", p.excerpt));
          var bits = [fmtDate(p.publishedAt)];
          if (p.readTime) bits.push(p.readTime + " min read");
          text.appendChild(el("div", "meta", bits.filter(Boolean).join(" · ")));
          link.appendChild(text);
          li.appendChild(link);
          list.appendChild(li);
        });
        card.appendChild(list);

        var foot = el("div", "foot");
        var site = el("a", null, "Lumina");
        site.href = ORIGIN;
        site.target = "_blank";
        site.rel = "noopener";
        foot.appendChild(document.createTextNode("Powered by "));
        foot.appendChild(site);
        card.appendChild(foot);
      })
      .catch(function () {
        card.replaceChildren(el("div", "error", "Couldn't load posts from Lumina right now."));
      });
  }

  function scan() {
    var nodes = document.querySelectorAll(".lumina-author[data-author]");
    for (var i = 0; i < nodes.length; i++) render(nodes[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();
