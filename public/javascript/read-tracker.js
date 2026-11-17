// Reading signal: active reading time and how far into the article the reader
// got — checkpointed while reading and sent once more when they leave (the
// server keeps the best values for the session).
//
// "Active" means the tab is visible and the reader scrolled, moved, clicked or
// pressed a key in the last 30 seconds, so a tab left open overnight doesn't
// count as eight hours of reading.
(function () {
  "use strict";
  var el = document.getElementById("read-signal");
  var article = document.getElementById("blog-content");
  if (!el || !article || !navigator.sendBeacon) return;

  var blogId = el.dataset.blogId;
  var IDLE_MS = 30000;
  var lastActivity = Date.now();
  var activeMs = 0;
  var lastTick = Date.now();
  var maxDepth = 0;
  var sentSeconds = -1;
  var sentDepth = -1;

  var bump = function () { lastActivity = Date.now(); };
  ["scroll", "mousemove", "keydown", "click", "touchstart"].forEach(function (e) {
    window.addEventListener(e, bump, { passive: true });
  });

  var measureDepth = function () {
    var r = article.getBoundingClientRect();
    if (r.height <= 0) return;
    var seen = (window.innerHeight - r.top) / r.height;
    maxDepth = Math.max(maxDepth, Math.min(1, Math.max(0, seen)));
  };
  window.addEventListener("scroll", measureDepth, { passive: true });

  // Checkpoints while reading, not only on leaving: a beacon sent while the
  // page unloads is sometimes dropped (seen in testing after a reload, and
  // common on mobile when a tab is killed). The server keeps the best values
  // for the session, so repeats are harmless; this costs a few tiny requests
  // per post, only while someone is actively reading.
  var CHECKPOINT_MS = 15000;
  var lastCheckpoint = 0;
  setInterval(function () {
    var now = Date.now();
    if (document.visibilityState === "visible" && now - lastActivity < IDLE_MS) activeMs += now - lastTick;
    lastTick = now;
    if (activeMs - lastCheckpoint >= CHECKPOINT_MS) {
      lastCheckpoint = activeMs;
      send();
    }
  }, 1000);

  var send = function () {
    measureDepth();
    var seconds = Math.round(activeMs / 1000);
    var depth = Math.round(maxDepth * 100) / 100;
    if (seconds === sentSeconds && depth === sentDepth) return;
    sentSeconds = seconds;
    sentDepth = depth;
    navigator.sendBeacon("/signals/read", JSON.stringify({ blogId: blogId, seconds: seconds, depth: depth }));
  };

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") send();
  });
  window.addEventListener("pagehide", send);

  var start = function () { measureDepth(); };
  if (article.dataset.ready) start();
  else document.addEventListener("lumina:post-ready", start);
})();
