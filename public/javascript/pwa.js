// Register the service worker (installable app + offline reading of recently
// read posts). After page load, so it never competes with the page itself.
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  // Only over HTTPS (or localhost) — browsers refuse otherwise anyway.
  if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(function (err) {
      console.warn("Service worker registration failed:", err);
    });
  });
})();
