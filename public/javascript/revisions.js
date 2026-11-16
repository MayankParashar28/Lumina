// 🕘 Server autosave + version history for the post editor.
//
// - Autosave: a few seconds after you stop typing, the title and body are sent
//   to the server as a version. The post itself is not changed until you press
//   Save Draft / Update, so a published post never shows half-finished edits.
// - Unsaved work: reopening the editor when the newest autosave is more recent
//   than the last real save offers to bring that work back.
// - History: the clock button lists recent versions; pick one to preview it and
//   restore it into the editor. What was in the editor is kept as a version
//   first, so a restore can itself be undone.
(function () {
  "use strict";

  const cfg = document.getElementById("revision-config");
  const editor = window.LuminaEditor;
  if (!cfg || !editor || !editor.quill) return;

  const quill = editor.quill;
  const titleEl = document.getElementById("title");
  const statusEl = document.getElementById("cloud-save-status");
  const base = "/blog/edit/" + cfg.dataset.blogId;
  const csrf = cfg.dataset.csrf;
  const savedAt = new Date(cfg.dataset.savedAt);
  const DEBOUNCE_MS = 3000;

  const api = (url, opts = {}) =>
    fetch(url, {
      credentials: "same-origin",
      ...opts,
      headers: { Accept: "application/json", "Content-Type": "application/json", "x-csrf-token": csrf },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || "HTTP " + res.status);
      return data;
    });

  const timeOf = (d) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const whenOf = (d) => {
    const date = new Date(d);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? "Today, " + timeOf(date)
      : date.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + timeOf(date);
  };
  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };

  const current = () => ({ title: titleEl ? titleEl.value : "", body: quill.root.innerHTML });

  // ---------- autosave ----------
  let timer = null;
  let inFlight = null;
  let lastSent = JSON.stringify(current());
  let dirty = false;

  const save = async (kind) => {
    const snapshot = current();
    const key = JSON.stringify(snapshot);
    if (kind !== "restore" && key === lastSent) { dirty = false; return; }
    setStatus("Saving…");
    inFlight = api(base + "/autosave", { method: "POST", body: JSON.stringify({ ...snapshot, kind }) });
    try {
      const { revision } = await inFlight;
      if (kind !== "restore") lastSent = key;
      dirty = JSON.stringify(current()) !== lastSent;
      setStatus("Version saved " + timeOf(revision.updatedAt));
    } catch (err) {
      setStatus("Couldn't save a version — your text is still here");
    } finally {
      inFlight = null;
    }
  };

  const schedule = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => save("autosave"), DEBOUNCE_MS);
  };

  quill.on("text-change", (delta, old, source) => { if (source === "user") schedule(); });
  if (titleEl) titleEl.addEventListener("input", schedule);

  // Leaving with unsaved typing: send it without waiting.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && dirty) {
      clearTimeout(timer);
      const snapshot = current();
      fetch(base + "/autosave", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({ ...snapshot, kind: "autosave" }),
      }).catch(() => {});
      lastSent = JSON.stringify(snapshot);
      dirty = false;
    }
  });

  // Real save via the form: no need for a pending autosave.
  const form = document.getElementById("publishForm");
  if (form) form.addEventListener("submit", () => { clearTimeout(timer); dirty = false; });

  // ---------- load into editor ----------
  const loadInto = (rev) => {
    if (titleEl) {
      titleEl.value = rev.title || "";
      titleEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    quill.setContents([]);
    quill.clipboard.dangerouslyPasteHTML(0, rev.body || "", "api");
    // Keep the hidden body field (what the form submits) in step.
    const bodyInput = document.getElementById("body");
    if (bodyInput) {
      bodyInput.value = quill.root.innerHTML;
      bodyInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    lastSent = JSON.stringify(current());
    dirty = false;
  };

  const restore = async (revId) => {
    const { revision } = await api(base + "/revisions/" + revId);
    await save("restore"); // keep what was in the editor
    loadInto(revision);
    setStatus("Restored the version from " + whenOf(revision.updatedAt) + " — press Save to keep it");
  };

  // ---------- "you have unsaved work" ----------
  const KIND_LABEL = {
    original: "Original",
    autosave: "Autosaved",
    saved: "Saved",
    restore: "Before restore",
  };

  const offerUnsaved = (rev) => {
    const bar = document.createElement("div");
    bar.className = "rev-banner";
    bar.setAttribute("role", "status");
    const msg = document.createElement("span");
    msg.textContent = "You have unsaved changes from " + whenOf(rev.updatedAt) + ".";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "rev-btn rev-btn--primary";
    yes.textContent = "Restore them";
    const no = document.createElement("button");
    no.type = "button";
    no.className = "rev-btn";
    no.textContent = "Dismiss";
    bar.append(msg, yes, no);
    const anchor = document.querySelector(".editor-container, #publishForm");
    anchor.parentNode.insertBefore(bar, anchor);
    yes.addEventListener("click", async () => {
      yes.disabled = true;
      try {
        const { revision } = await api(base + "/revisions/" + rev._id);
        loadInto(revision);
        setStatus("Unsaved changes restored — press Save to keep them");
        bar.remove();
      } catch (err) {
        msg.textContent = "Couldn't restore them: " + err.message;
        yes.disabled = false;
      }
    });
    no.addEventListener("click", () => bar.remove());
  };

  // ---------- history dialog ----------
  let dialog = null;
  let listEl = null;
  let previewEl = null;

  const buildDialog = () => {
    dialog = document.createElement("dialog");
    dialog.className = "rev-dialog";
    dialog.setAttribute("aria-labelledby", "rev-title");
    dialog.innerHTML =
      '<div class="rev-head"><h2 id="rev-title">Version history</h2>' +
      '<button type="button" class="rev-close" aria-label="Close" title="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button></div>' +
      '<div class="rev-body"><ol class="rev-list" aria-label="Versions"></ol>' +
      '<div class="rev-preview" aria-live="polite"><p class="rev-empty">Pick a version to preview it.</p></div></div>';
    document.body.appendChild(dialog);
    listEl = dialog.querySelector(".rev-list");
    previewEl = dialog.querySelector(".rev-preview");
    dialog.querySelector(".rev-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  };

  const plainText = (html) => {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  };

  const showPreview = async (rev, btn) => {
    listEl.querySelectorAll("button[aria-current]").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "true");
    previewEl.textContent = "Loading…";
    try {
      const { revision } = await api(base + "/revisions/" + rev._id);
      previewEl.replaceChildren();
      const h = document.createElement("h3");
      h.className = "rev-preview__title";
      h.textContent = revision.title || "(untitled)";
      const meta = document.createElement("p");
      meta.className = "rev-preview__meta";
      meta.textContent = KIND_LABEL[revision.kind] + " · " + whenOf(revision.updatedAt) + " · " + revision.wordCount + " words";
      const text = document.createElement("p");
      text.className = "rev-preview__text";
      const full = plainText(revision.body);
      text.textContent = full.length > 1200 ? full.slice(0, 1200) + "…" : full || "(empty)";
      const go = document.createElement("button");
      go.type = "button";
      go.className = "rev-btn rev-btn--primary";
      go.textContent = "Restore this version";
      go.addEventListener("click", async () => {
        go.disabled = true;
        try {
          await restore(revision._id);
          dialog.close();
        } catch (err) {
          go.disabled = false;
          meta.textContent = "Couldn't restore: " + err.message;
        }
      });
      previewEl.append(h, meta, go, text);
    } catch (err) {
      previewEl.textContent = "Couldn't load this version.";
    }
  };

  const openHistory = async () => {
    if (!dialog) buildDialog();
    listEl.replaceChildren();
    previewEl.innerHTML = '<p class="rev-empty">Pick a version to preview it.</p>';
    dialog.showModal();
    // Make sure the newest work is in the list.
    if (dirty) { clearTimeout(timer); await save("autosave"); }
    try {
      const { revisions } = await api(base + "/revisions");
      if (!revisions.length) {
        listEl.innerHTML = '<li class="rev-empty">No versions yet. They appear as you write and save.</li>';
        return;
      }
      revisions.forEach((r) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.className = "rev-item";
        const when = document.createElement("span");
        when.className = "rev-item__when";
        when.textContent = whenOf(r.updatedAt);
        const meta = document.createElement("span");
        meta.className = "rev-item__meta";
        meta.textContent = KIND_LABEL[r.kind] + " · " + r.wordCount + " words";
        b.append(when, meta);
        b.addEventListener("click", () => showPreview(r, b));
        li.appendChild(b);
        listEl.appendChild(li);
      });
      listEl.querySelector("button").focus();
    } catch (err) {
      listEl.innerHTML = '<li class="rev-empty">Couldn\'t load versions.</li>';
    }
  };

  const openBtn = document.getElementById("open-history");
  if (openBtn) openBtn.addEventListener("click", openHistory);

  // On load: newer autosaved work than the last real save?
  api(base + "/revisions")
    .then(({ revisions }) => {
      const newest = revisions[0];
      if (newest && newest.kind === "autosave" && new Date(newest.updatedAt) > savedAt) offerUnsaved(newest);
    })
    .catch(() => {});
})();
