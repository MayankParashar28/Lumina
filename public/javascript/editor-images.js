/**
 * Routes every image that enters the Quill editor through Cloudinary.
 *
 * Quill 1.3.6's default behaviour is to embed images as base64 data URIs inside
 * the document HTML. That HTML is what gets stored in `blog.body`, so a post
 * with a few screenshots carries several megabytes of base64 in a single
 * MongoDB document — close to the 16MB ceiling, impossible to cache separately,
 * and re-downloaded in full by every reader. The cover image already goes to
 * Cloudinary; this closes the same gap for images in the body.
 *
 * Three ways an image can arrive, all handled here: the toolbar button, paste,
 * and drag-and-drop. A fourth (pasting HTML that already contains a data URI)
 * is caught by a clipboard matcher.
 *
 * Usage:  LuminaEditorImages.attach(quill)
 */
(function () {
  "use strict";

  var ENDPOINT = "/blog/editor-image";
  var MAX_BYTES = 5 * 1024 * 1024; // matches the server's multer limit
  var ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  var PLACEHOLDER = "Uploading image…\n";

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute("content") : "";
  }

  function toast(message, type) {
    if (window.showToast) window.showToast(message, type);
  }

  function rejectReason(file) {
    if (!file) return "That file could not be read.";
    if (ALLOWED.indexOf(file.type) === -1) {
      return "Only JPEG, PNG, WEBP and GIF images can be added.";
    }
    if (file.size > MAX_BYTES) {
      return "That image is " + Math.ceil(file.size / 1024 / 1024) + "MB. The limit is 5MB.";
    }
    return null;
  }

  function upload(file) {
    var body = new FormData();
    body.append("image", file);

    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "x-csrf-token": csrfToken() },
      body: body,
      credentials: "same-origin"
    }).then(function (res) {
      return res
        .json()
        .catch(function () { return {}; })
        .then(function (data) {
          if (!res.ok || !data.url) {
            throw new Error(data.error || "Upload failed (HTTP " + res.status + ").");
          }
          return data.url;
        });
    });
  }

  // Insert a text placeholder first, then swap it for the image. This keeps the
  // caret stable so the writer can carry on typing during the upload, and means
  // a failed upload leaves nothing behind rather than a broken data URI.
  function insert(quill, file) {
    var problem = rejectReason(file);
    if (problem) {
      toast(problem, "error");
      return Promise.resolve();
    }

    var range = quill.getSelection(true) || { index: quill.getLength(), length: 0 };
    var at = range.index;

    quill.insertText(at, PLACEHOLDER, { italic: true }, "user");
    quill.setSelection(at + PLACEHOLDER.length, 0, "silent");

    return upload(file)
      .then(function (url) {
        quill.deleteText(at, PLACEHOLDER.length, "user");
        quill.insertEmbed(at, "image", url, "user");
        quill.setSelection(at + 1, 0, "silent");
      })
      .catch(function (err) {
        quill.deleteText(at, PLACEHOLDER.length, "user");
        toast(err.message || "That image could not be uploaded.", "error");
      });
  }

  function imageFilesFrom(list) {
    var files = [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var file = item && item.getAsFile ? item.getAsFile() : item;
      if (file && file.type && file.type.indexOf("image/") === 0) files.push(file);
    }
    return files;
  }

  function attach(quill) {
    if (!quill || quill.__luminaImagesAttached) return;
    quill.__luminaImagesAttached = true;

    // 1. Toolbar button, replacing Quill's built-in base64 insert.
    var toolbar = quill.getModule("toolbar");
    if (toolbar) {
      toolbar.addHandler("image", function () {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ALLOWED.join(",");
        input.addEventListener("change", function () {
          if (input.files && input.files[0]) insert(quill, input.files[0]);
        });
        input.click();
      });
    }

    var root = quill.root;

    // 2. Paste. Captured before Quill's clipboard runs, otherwise the image has
    //    already become a data URI by the time we could intervene.
    root.addEventListener("paste", function (e) {
      var data = e.clipboardData;
      if (!data) return;
      var files = imageFilesFrom(data.items || []);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      files.forEach(function (file) { insert(quill, file); });
    }, true);

    // 3. Drag and drop from the desktop.
    root.addEventListener("dragover", function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      if (types && Array.prototype.indexOf.call(types, "Files") !== -1) e.preventDefault();
    });

    root.addEventListener("drop", function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      var files = imageFilesFrom(e.dataTransfer.files);
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();

      // Drop point, not caret point: the writer aimed at somewhere specific.
      if (document.caretRangeFromPoint && window.Quill) {
        var caret = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (caret) {
          var blot = window.Quill.find(caret.startContainer, true);
          if (blot) quill.setSelection(quill.getIndex(blot) + caret.startOffset, 0, "silent");
        }
      }

      files.forEach(function (file) { insert(quill, file); });
    }, true);

    // 4. Safety net: rich HTML pasted from another page can carry
    //    <img src="data:...">, which arrives as markup rather than as a file and
    //    so misses the handlers above. Drop it instead of storing it.
    if (quill.clipboard && quill.clipboard.addMatcher) {
      quill.clipboard.addMatcher("IMG", function (node, delta) {
        var src = (node && node.getAttribute("src")) || "";
        if (src.indexOf("data:") === 0) {
          toast("Inline pasted image skipped — use the image button or drop the file in.", "info");
          return { ops: [] };
        }
        return delta;
      });
    }
  }

  window.LuminaEditorImages = { attach: attach };
})();
