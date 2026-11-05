// Floating format toolbar for the post editor.
//
// Select some text and the controls you actually reach for appear next to it,
// the way they do in Medium, Notion and Substack — instead of making the author
// travel to a fixed toolbar at the top of the page on every formatting change.
//
// This augments Quill's snow toolbar rather than replacing it. Quill 1.x cannot
// run two theme toolbars at once, and the snow toolbar is still the only place
// with the image button, the colour pickers and "clean"; dropping it to get the
// bubble (theme: 'bubble') would be a net loss. So: snow stays, and this adds
// the inline layer on top of the same Quill instance via its public API.
//
//   window.LuminaEditorBubble.attach(quill)
(function () {
  "use strict";

  // Inline formats only, plus the three block formats worth reaching for
  // mid-sentence. Anything that needs a dialog or a palette stays on the snow
  // toolbar, which is still right there.
  var BUTTONS = [
    { name: "bold",       icon: "fa-bold",       label: "Bold",        type: "inline" },
    { name: "italic",     icon: "fa-italic",     label: "Italic",      type: "inline" },
    { name: "underline",  icon: "fa-underline",  label: "Underline",   type: "inline" },
    { name: "strike",     icon: "fa-strikethrough", label: "Strikethrough", type: "inline" },
    { sep: true },
    { name: "header",     icon: "fa-heading",    label: "Heading",     type: "value", value: 2, text: "2" },
    { name: "header",     icon: "fa-heading",    label: "Subheading",  type: "value", value: 3, text: "3" },
    { name: "blockquote", icon: "fa-quote-left", label: "Quote",       type: "block" },
    { name: "code-block", icon: "fa-code",       label: "Code block",  type: "block" },
    { sep: true },
    { name: "link",       icon: "fa-link",       label: "Link",        type: "link" }
  ];

  function attach(quill) {
    if (!quill || !quill.root) return;
    // The editor's offsetParent is what getBounds() is measured against, so the
    // bubble has to be positioned inside the same containing block.
    var container = quill.container;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    var bar = document.createElement("div");
    bar.className = "lumina-bubble";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Text formatting");

    var main = document.createElement("div");
    main.className = "lumina-bubble__row";

    var buttons = [];

    BUTTONS.forEach(function (spec) {
      if (spec.sep) {
        var sep = document.createElement("span");
        sep.className = "lumina-bubble__sep";
        main.appendChild(sep);
        return;
      }

      var b = document.createElement("button");
      b.type = "button";
      b.className = "lumina-bubble__btn";
      b.title = spec.label;
      b.setAttribute("aria-label", spec.label);
      b.innerHTML = spec.text
        ? '<i class="fas ' + spec.icon + '"></i><span class="lumina-bubble__sub">' + spec.text + "</span>"
        : '<i class="fas ' + spec.icon + '"></i>';

      // mousedown, not click: by the time click fires the editor has already
      // lost focus and Quill's selection is gone, so format() would no-op.
      b.addEventListener("mousedown", function (e) {
        e.preventDefault();
        apply(spec);
      });

      b.dataset.fmt = spec.name;
      if (spec.value != null) b.dataset.val = String(spec.value);
      buttons.push(b);
      main.appendChild(b);
    });

    // --- link editor -----------------------------------------------------
    //
    // A window.prompt would work, but it drops the author out of the page and
    // cannot show the URL already on the selection. This is an inline row that
    // replaces the buttons while it is open.
    var linkRow = document.createElement("div");
    linkRow.className = "lumina-bubble__row lumina-bubble__link is-hidden";

    var linkInput = document.createElement("input");
    linkInput.type = "url";
    linkInput.className = "lumina-bubble__input";
    linkInput.placeholder = "Paste or type a link, then press Enter";
    linkInput.setAttribute("aria-label", "Link address");

    var linkApply = document.createElement("button");
    linkApply.type = "button";
    linkApply.className = "lumina-bubble__btn";
    linkApply.title = "Apply link";
    linkApply.setAttribute("aria-label", "Apply link");
    linkApply.innerHTML = '<i class="fas fa-check"></i>';

    var linkRemove = document.createElement("button");
    linkRemove.type = "button";
    linkRemove.className = "lumina-bubble__btn";
    linkRemove.title = "Remove link";
    linkRemove.setAttribute("aria-label", "Remove link");
    linkRemove.innerHTML = '<i class="fas fa-unlink"></i>';

    linkRow.appendChild(linkInput);
    linkRow.appendChild(linkApply);
    linkRow.appendChild(linkRemove);

    bar.appendChild(main);
    bar.appendChild(linkRow);
    container.appendChild(bar);

    // The range the bubble was opened for. The link input steals focus, which
    // clears Quill's selection, so it has to be remembered.
    var savedRange = null;

    function openLinkEditor() {
      savedRange = quill.getSelection();
      if (!savedRange) return;
      var existing = quill.getFormat(savedRange).link;
      linkInput.value = existing || "";
      main.classList.add("is-hidden");
      linkRow.classList.remove("is-hidden");
      linkInput.focus();
      linkInput.select();
    }

    function closeLinkEditor() {
      linkRow.classList.add("is-hidden");
      main.classList.remove("is-hidden");
    }

    // Only http(s) and mailto. Quill will happily store "javascript:..." as a
    // link; the server's sanitiser strips it on the way into the database, but
    // rejecting it here means the author finds out immediately instead of
    // discovering the link silently vanished after publishing.
    function normaliseUrl(raw) {
      var v = String(raw || "").trim();
      if (!v) return null;
      if (/^(https?:|mailto:)/i.test(v)) return v;
      // A bare "example.com/x" is a URL the author means as http(s).
      if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(v)) return "https://" + v;
      if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return "mailto:" + v;
      return null;
    }

    function commitLink() {
      var url = normaliseUrl(linkInput.value);
      if (savedRange) {
        if (url === null && linkInput.value.trim()) {
          linkInput.classList.add("is-invalid");
          setTimeout(function () { linkInput.classList.remove("is-invalid"); }, 1200);
          return;
        }
        quill.setSelection(savedRange);
        quill.format("link", url || false, "user");
      }
      closeLinkEditor();
      hide();
    }

    linkApply.addEventListener("mousedown", function (e) { e.preventDefault(); commitLink(); });
    linkRemove.addEventListener("mousedown", function (e) {
      e.preventDefault();
      if (savedRange) {
        quill.setSelection(savedRange);
        quill.format("link", false, "user");
      }
      closeLinkEditor();
      hide();
    });
    linkInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commitLink(); }
      if (e.key === "Escape") {
        e.preventDefault();
        closeLinkEditor();
        if (savedRange) quill.setSelection(savedRange);
      }
    });

    // --- formatting ------------------------------------------------------

    function apply(spec) {
      if (spec.type === "link") { openLinkEditor(); return; }

      var range = quill.getSelection();
      if (!range) return;
      var current = quill.getFormat(range);

      if (spec.type === "value") {
        // Toggle: pressing H2 on an H2 returns it to body text.
        var on = String(current[spec.name]) === String(spec.value);
        quill.format(spec.name, on ? false : spec.value, "user");
      } else {
        quill.format(spec.name, !current[spec.name], "user");
      }
      syncActive();
    }

    function syncActive() {
      var range = quill.getSelection();
      if (!range) return;
      var fmt = quill.getFormat(range);
      buttons.forEach(function (b) {
        var name = b.dataset.fmt;
        var val = b.dataset.val;
        var on = val != null
          ? String(fmt[name]) === val
          : !!fmt[name];
        b.classList.toggle("is-active", on);
      });
    }

    // --- show / hide / position ------------------------------------------

    function hide() {
      bar.classList.remove("is-visible");
      closeLinkEditor();
    }

    function position(range) {
      var bounds = quill.getBounds(range);
      // Measure after making it visible, or offsetWidth is 0 and the bubble
      // lands hard against the left edge on first use.
      bar.classList.add("is-visible");

      var barW = bar.offsetWidth;
      var barH = bar.offsetHeight;
      var GAP = 10;

      var left = bounds.left + bounds.width / 2 - barW / 2;
      // Keep it inside the editor rather than letting it hang off either side.
      var maxLeft = container.clientWidth - barW - 4;
      left = Math.max(4, Math.min(left, Math.max(4, maxLeft)));

      var top = bounds.top - barH - GAP;
      // A selection on the first line has no room above it; flip below.
      if (top < 4) top = bounds.top + bounds.height + GAP;

      bar.style.left = left + "px";
      bar.style.top = top + "px";
    }

    quill.on("selection-change", function (range) {
      // While the link input has focus Quill reports no selection. Leaving the
      // bubble up is deliberate — it is the thing being typed into.
      if (document.activeElement === linkInput) return;

      if (!range || range.length === 0) { hide(); return; }
      position(range);
      syncActive();
    });

    // Typing changes what is selected and what formats apply under it.
    quill.on("text-change", function () {
      if (!bar.classList.contains("is-visible")) return;
      var range = quill.getSelection();
      if (!range || range.length === 0) { hide(); return; }
      position(range);
      syncActive();
    });

    // A scroll moves the text out from under the bubble; getBounds is relative
    // to the editor, so reposition rather than hide.
    window.addEventListener("scroll", function () {
      if (!bar.classList.contains("is-visible")) return;
      var range = quill.getSelection();
      if (range && range.length > 0) position(range);
    }, { passive: true });

    window.addEventListener("resize", function () {
      if (!bar.classList.contains("is-visible")) return;
      var range = quill.getSelection();
      if (range && range.length > 0) position(range);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && bar.classList.contains("is-visible")) hide();
    });
  }

  window.LuminaEditorBubble = { attach: attach };
})();
