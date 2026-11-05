// Post-publish share panel.
//
// Driven entirely by a <div id="publish-share" data-url data-title> that
// views/blog.ejs renders only when the publish redirect carried ?published=1.
// No inline script, so nothing here needs a CSP nonce.
(function () {
  "use strict";

  var mount = document.getElementById("publish-share");
  if (!mount) return;

  var postUrl = mount.dataset.url || window.location.origin + window.location.pathname;
  var postTitle = mount.dataset.title || document.title;

  // Built from the post's own title and URL only; both are escaped for use in a
  // query string. Nothing here is interpolated into HTML.
  var shareText = encodeURIComponent(postTitle);
  var shareUrl = encodeURIComponent(postUrl);

  var NETWORKS = [
    { net: "x", label: "Share on X", icon: "fa-brands fa-x-twitter",
      href: "https://twitter.com/intent/tweet?text=" + shareText + "&url=" + shareUrl },
    { net: "linkedin", label: "Share on LinkedIn", icon: "fa-brands fa-linkedin-in",
      href: "https://www.linkedin.com/sharing/share-offsite/?url=" + shareUrl },
    { net: "whatsapp", label: "Share on WhatsApp", icon: "fa-brands fa-whatsapp",
      href: "https://api.whatsapp.com/send?text=" + shareText + "%20" + shareUrl },
    { net: "facebook", label: "Share on Facebook", icon: "fa-brands fa-facebook-f",
      href: "https://www.facebook.com/sharer/sharer.php?u=" + shareUrl },
    { net: "reddit", label: "Share on Reddit", icon: "fa-brands fa-reddit-alien",
      href: "https://www.reddit.com/submit?url=" + shareUrl + "&title=" + shareText }
  ];

  // --- build -------------------------------------------------------------

  var overlay = document.createElement("div");
  overlay.className = "share-panel-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "share-panel-title");

  var panel = document.createElement("div");
  panel.className = "share-panel";

  var check = document.createElement("div");
  check.className = "share-panel__check";
  check.setAttribute("aria-hidden", "true");
  check.innerHTML = '<i class="fas fa-check"></i>';

  var heading = document.createElement("h2");
  heading.className = "share-panel__title";
  heading.id = "share-panel-title";
  heading.textContent = "Your story is live";

  var sub = document.createElement("p");
  sub.className = "share-panel__subtitle";
  sub.textContent = "Share it while it's fresh — most of a post's readers arrive in the first day.";
  var titleEl = document.createElement("span");
  titleEl.className = "share-panel__post-title";
  // textContent, not innerHTML: the title is author-supplied.
  titleEl.textContent = postTitle;
  sub.appendChild(titleEl);

  // link + copy
  var linkRow = document.createElement("div");
  linkRow.className = "share-panel__link-row";

  var linkInput = document.createElement("input");
  linkInput.className = "share-panel__link";
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = postUrl;
  linkInput.setAttribute("aria-label", "Link to your story");
  linkInput.addEventListener("focus", function () { linkInput.select(); });

  var copyBtn = document.createElement("button");
  copyBtn.className = "share-panel__copy";
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";

  linkRow.appendChild(linkInput);
  linkRow.appendChild(copyBtn);

  // targets
  var targets = document.createElement("div");
  targets.className = "share-panel__targets";

  NETWORKS.forEach(function (n) {
    var a = document.createElement("a");
    a.className = "share-panel__target";
    a.dataset.net = n.net;
    a.href = n.href;
    a.target = "_blank";
    // noopener matters here: without it the opened tab can reach back through
    // window.opener and navigate this page.
    a.rel = "noopener noreferrer";
    a.title = n.label;
    a.setAttribute("aria-label", n.label);
    a.innerHTML = '<i class="' + n.icon + '"></i>';
    targets.appendChild(a);
  });

  // The OS share sheet, where there is one. Worth its own button on a phone:
  // it reaches the apps the author actually uses, which the fixed list cannot.
  if (navigator.share) {
    var nativeBtn = document.createElement("button");
    nativeBtn.className = "share-panel__target";
    nativeBtn.type = "button";
    nativeBtn.dataset.net = "native";
    nativeBtn.title = "More sharing options";
    nativeBtn.setAttribute("aria-label", "More sharing options");
    nativeBtn.innerHTML = '<i class="fas fa-ellipsis"></i>';
    nativeBtn.addEventListener("click", function () {
      navigator.share({ title: postTitle, url: postUrl }).catch(function () {});
    });
    targets.appendChild(nativeBtn);
  }

  var done = document.createElement("button");
  done.className = "share-panel__done";
  done.type = "button";
  done.textContent = "View your story";

  panel.appendChild(check);
  panel.appendChild(heading);
  panel.appendChild(sub);
  panel.appendChild(linkRow);
  panel.appendChild(targets);
  panel.appendChild(done);
  overlay.appendChild(panel);

  // --- behaviour ---------------------------------------------------------

  function copy() {
    var fallback = function () {
      // execCommand is deprecated but is the only path that works without
      // clipboard permission, and on a page served over plain http where
      // navigator.clipboard is undefined.
      linkInput.select();
      try { document.execCommand("copy"); return true; } catch (e) { return false; }
    };

    var done_ = function (ok) {
      copyBtn.textContent = ok ? "Copied" : "Press Ctrl+C";
      copyBtn.classList.toggle("is-copied", ok);
      setTimeout(function () {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("is-copied");
      }, 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(postUrl).then(
        function () { done_(true); },
        function () { done_(fallback()); }
      );
    } else {
      done_(fallback());
    }
  }

  copyBtn.addEventListener("click", copy);

  var lastFocus = document.activeElement;

  function close() {
    overlay.classList.remove("is-open");
    document.removeEventListener("keydown", onKeydown);
    document.body.style.overflow = "";

    // Drop ?published=1 so a reload — or the back button — does not reopen the
    // panel over a post the author has already shared.
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, "", window.location.pathname + window.location.hash);
    }

    var remove = function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
    // Let the fade finish, but never leave the overlay stranded if the
    // transition never fires (reduced motion, background tab).
    overlay.addEventListener("transitionend", remove, { once: true });
    setTimeout(remove, 400);

    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKeydown(e) {
    if (e.key === "Escape") { close(); return; }
    if (e.key !== "Tab") return;

    // Keep Tab inside the dialog: behind it is a whole article of links, and
    // tabbing into content the author cannot see is disorienting.
    var focusable = panel.querySelectorAll("a[href], button, input");
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  done.addEventListener("click", close);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKeydown);

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";

  // Next frame, so the opening transition has a start state to animate from.
  requestAnimationFrame(function () {
    overlay.classList.add("is-open");
    copyBtn.focus();
  });
})();
