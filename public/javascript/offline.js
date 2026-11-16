// Offline page: list the posts the service worker saved, newest first.
(function () {
  "use strict";
  var list = document.getElementById("saved");
  var none = document.getElementById("none");

  document.getElementById("retry").addEventListener("click", function () {
    location.reload();
  });

  // Opened as "Saved for offline" while online: say so.
  if (navigator.onLine) {
    document.getElementById("heading").textContent = "Saved for offline";
    document.getElementById("lead").textContent =
      "Stories you've read recently, kept on this device so you can read them without a connection.";
    document.getElementById("retry").hidden = true;
  }

  if (!("caches" in window)) {
    none.hidden = false;
    return;
  }

  caches
    .open("lumina-posts")
    .then(function (cache) {
      return cache.keys().then(function (keys) {
        return Promise.all(
          keys.reverse().map(function (req) {
            return cache.match(req).then(function (res) {
              return res ? res.text() : "";
            }).then(function (html) {
              var doc = new DOMParser().parseFromString(html, "text/html");
              var title = (doc.querySelector("title") || {}).textContent || req.url;
              return { url: req.url, title: title.replace(/\s*[-|]\s*Lumina\s*$/i, "").trim() };
            });
          })
        );
      });
    })
    .then(function (posts) {
      if (!posts.length) {
        none.hidden = false;
        return;
      }
      posts.forEach(function (p) {
        var li = document.createElement("li");
        var a = document.createElement("a");
        a.href = p.url;
        a.textContent = p.title;
        li.appendChild(a);
        list.appendChild(li);
      });
    })
    .catch(function () {
      none.hidden = false;
    });
})();
