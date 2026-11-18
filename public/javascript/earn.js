// Earn page: remember where the visitor came from (?src=nav|home|publish|…)
// so the waitlist can tell which entry point works.
(function () {
  "use strict";
  var src = new URLSearchParams(location.search).get("src");
  if (!src || !/^[a-z]{2,12}$/.test(src)) return;
  Array.prototype.forEach.call(document.querySelectorAll("[data-earn-src]"), function (input) {
    input.value = src;
  });
})();
