// ✨ The editor's AI buttons, shared by the new-post and edit-post pages.
//
//   generateTitles       "Suggest" next to the title: five titles from the story
//   generateWithAI       "Continue writing": picks up where the story ends, or
//                        drafts one from the title when the page is still empty
//   generateCoverWithAI  "Generate" in the cover strip: an image from the title
//
// These lived inline in addBlog.ejs and editBlog.ejs, twice, and each looked
// up its button by a class the button no longer had (.btn-toolbar-ai,
// .btn-ai-glass), so "Continue writing" and "Generate" threw before doing
// anything. Buttons are now found by their data-action, which is what wires
// them up in the first place (public/javascript/app.js).
//
// Tag suggestions live in writer-tools.js.
(function () {
  "use strict";

  var cfg = document.getElementById("writer-tools-config");
  var csrf = cfg ? cfg.dataset.csrf : "";
  var working = false; // one AI request at a time

  var $ = function (id) { return document.getElementById(id); };
  var quill = function () { return window.quill || null; };
  var toast = function (msg, type) {
    if (window.showToast) window.showToast(msg, type || "info");
    else window.alert(msg);
  };
  var buttonFor = function (action) { return document.querySelector('[data-action="' + action + '"]'); };

  function setBusy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.idleHtml = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> ' + label;
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
    } else {
      if (btn.dataset.idleHtml) btn.innerHTML = btn.dataset.idleHtml;
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  }

  function postJson(url, data) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(data),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var fallback = res.status === 401 ? "Sign in again to use AI." : "The AI service didn't answer (" + res.status + "). Try again.";
          throw new Error(body.error || fallback);
        }
        return body;
      });
    });
  }

  // Tells the autosave, the publish-readiness hint and the assistant that a
  // field changed, the same way typing would.
  function announce(el, type) {
    if (el) el.dispatchEvent(new Event(type || "input", { bubbles: true }));
  }

  // AI helpers that cost money per call unlock after a verified email and a
  // first post (services/unlockRules.js). The server enforces it; this just
  // says why up front instead of after a round trip.
  var aiLocked = cfg && cfg.dataset.aiLocked;
  if (aiLocked) {
    ["generateTitles", "generateWithAI"].forEach(function (action) {
      var btn = buttonFor(action);
      if (!btn) return;
      btn.classList.add("is-locked");
      btn.setAttribute("aria-disabled", "true");
      btn.title = aiLocked;
      btn.insertAdjacentHTML("afterbegin", '<i class="fas fa-lock" aria-hidden="true"></i> ');
    });
  }

  function guard(fn, needsUnlock) {
    return function () {
      if (needsUnlock && aiLocked) { toast(aiLocked); return; }
      if (working) { toast("One moment, the AI is still working on your last request."); return; }
      working = true;
      return Promise.resolve()
        .then(fn)
        .catch(function (err) { toast(err.message || "Something went wrong. Try again.", "error"); })
        .then(function () { working = false; });
    };
  }

  // ---------------------------------------------------------------------
  // Title suggestions
  // ---------------------------------------------------------------------
  window.generateTitles = guard(function () {
    var q = quill();
    var body = q ? q.getText().trim() : "";
    var titleEl = $("title");
    var box = $("title-suggestions");
    var btn = $("title-magic-btn") || buttonFor("generateTitles");
    var tone = $("toneSelector") ? $("toneSelector").value : "Professional";

    if (body.length < 50) {
      toast("Write a few sentences first, then I can suggest titles that fit them.");
      return;
    }

    setBusy(btn, true, "Thinking…");
    return postJson("/ai/generate-title", { body: body, tone: tone })
      .then(function (data) {
        var titles = Array.isArray(data.titles) ? data.titles.filter(Boolean) : [];
        if (!titles.length) throw new Error("No titles came back. Try again in a moment.");
        box.replaceChildren();
        box.classList.add("title-suggestions--open");
        box.style.display = "";
        titles.forEach(function (title) {
          var chip = document.createElement("button");
          chip.type = "button";
          chip.className = "wa-chip title-suggestion";
          chip.textContent = title;
          chip.addEventListener("click", function () {
            titleEl.value = title;
            if (typeof window.autoResize === "function") window.autoResize(titleEl);
            announce(titleEl);
            box.classList.remove("title-suggestions--open");
            box.replaceChildren();
            titleEl.focus();
          });
          box.appendChild(chip);
        });
        var dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "wa-chip wa-chip--ghost";
        dismiss.textContent = "Keep mine";
        dismiss.addEventListener("click", function () {
          box.classList.remove("title-suggestions--open");
          box.replaceChildren();
        });
        box.appendChild(dismiss);
      })
      .finally(function () { setBusy(btn, false); });
  }, true); // needs AI unlocked

  // ---------------------------------------------------------------------
  // Continue writing
  // ---------------------------------------------------------------------
  function htmlBlocks(html) {
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    var blocks = Array.prototype.map.call(tmp.children, function (el) { return el.outerHTML; });
    if (!blocks.length && tmp.textContent.trim()) {
      var p = document.createElement("p");
      p.textContent = tmp.textContent.trim();
      blocks.push(p.outerHTML);
    }
    return blocks;
  }

  window.generateWithAI = guard(function () {
    var q = quill();
    if (!q) return;
    var title = ($("title") ? $("title").value : "").trim();
    var story = q.getText().trim();
    var tone = $("toneSelector") ? $("toneSelector").value : "Professional";
    var btn = buttonFor("generateWithAI");

    if (!title && !story) {
      toast("Add a title or a first paragraph, then I can keep going.");
      return;
    }

    setBusy(btn, true, story ? "Writing…" : "Drafting…");
    return postJson("/ai/generate-blog", { title: title, tone: tone, body: story.slice(-6000) })
      .then(function (data) {
        var blocks = data.content ? htmlBlocks(data.content) : [];
        if (!blocks.length) throw new Error("The AI didn't write anything this time. Try again.");

        // Appended a block at a time so the writer can watch it arrive; the
        // button stays busy until the last block lands.
        return new Promise(function (resolve) {
          var i = 0;
          (function next() {
            if (i >= blocks.length) {
              q.setSelection(q.getLength(), 0, "silent");
              toast(story ? "Added " + blocks.length + " paragraph" + (blocks.length === 1 ? "" : "s") + ". Ctrl+Z undoes it." : "Draft ready. Make it yours.", "success");
              return resolve();
            }
            q.clipboard.dangerouslyPasteHTML(q.getLength(), blocks[i], "user");
            i += 1;
            setTimeout(next, 250);
          })();
        });
      })
      .finally(function () { setBusy(btn, false); });
  }, true); // needs AI unlocked

  // ---------------------------------------------------------------------
  // AI cover image
  // ---------------------------------------------------------------------
  var COVER_STYLE = {
    Professional: "minimalist, corporate, clean lines, high quality, business",
    Casual: "lifestyle, cozy, warm lighting, photorealistic",
    Funny: "cartoon, vibrant, colorful, playful, illustration",
    Inspirational: "majestic, sunrise, cinematic, motivational, dreamy",
    Technical: "blueprint, futuristic, tech, glowing, neon",
  };

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var timer = setTimeout(function () { reject(new Error("timeout")); }, 45000);
      img.onload = function () { clearTimeout(timer); resolve(url); };
      img.onerror = function () { clearTimeout(timer); reject(new Error("failed")); };
      img.src = url;
    });
  }

  function showCover(url) {
    var preview = $("coverPreview");
    var aiInput = $("aiCoverURL");
    preview.src = url;
    aiInput.value = url;
    preview.classList.remove("hidden");
    $("removeCover").classList.remove("hidden");
    $("coverControls").classList.add("hidden");
    $("coverContainer").style.border = "none";
    announce(aiInput, "change");
  }

  window.generateCoverWithAI = guard(function () {
    var title = ($("title") ? $("title").value : "").trim();
    if (!title) {
      toast("Add a title first so the image has something to be about.");
      return;
    }
    var tone = $("toneSelector") ? $("toneSelector").value : "Professional";
    var seed = Math.floor(Math.random() * 100000);
    var prompt = title + ", " + (COVER_STYLE[tone] || "minimalist, high quality") + ", detailed, aesthetically pleasing";
    var aiUrl = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
      "?width=1200&height=600&nologo=true&seed=" + seed + "&model=flux";
    var btn = buttonFor("generateCoverWithAI");

    setBusy(btn, true, "Generating…");
    return loadImage(aiUrl)
      .catch(function () {
        toast("The image generator is busy, so here's a photo instead. Generate again for another.");
        return loadImage("https://picsum.photos/seed/" + seed + "/1200/600");
      })
      .then(showCover)
      .catch(function () {
        throw new Error("Couldn't get a cover image right now. Try again, or upload one.");
      })
      .finally(function () { setBusy(btn, false); });
  });
})();
