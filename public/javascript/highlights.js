// 🖍️ Highlights and private notes on a post.
//
// Select text in the article → a small popover offers "Highlight" and "Note".
// Saved highlights are restored on every visit and are only visible to the
// reader who made them. Click a highlight to edit its note or remove it.
//
// A highlight is stored as its text plus ~32 characters of context either
// side, and found again by searching the article's text — so it survives the
// author editing other parts of the post.
(function () {
  "use strict";

  const tools = document.getElementById("reader-tools");
  if (!tools) return;
  const blogId = tools.dataset.blogId;
  const csrf = tools.dataset.csrf;
  const CONTEXT = 32;

  let root = null;
  let popover = null;
  let pendingRange = null; // the selection being turned into a highlight
  let activeId = null; // the highlight whose popover is open
  const notes = new Map(); // id -> note

  const api = (url, opts = {}) =>
    fetch(url, {
      credentials: "same-origin",
      ...opts,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-csrf-token": csrf,
        ...(opts.headers || {}),
      },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || "HTTP " + res.status);
      return data;
    });

  // ---------- text offsets ----------

  // Offset of a DOM boundary point within root's text.
  const offsetOf = (node, offset) => {
    const r = document.createRange();
    r.selectNodeContents(root);
    r.setEnd(node, offset);
    return r.toString().length;
  };

  // Text nodes of root with their start offsets.
  const textNodes = () => {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let pos = 0;
    let n;
    while ((n = walker.nextNode())) {
      out.push({ node: n, start: pos, end: pos + n.nodeValue.length });
      pos += n.nodeValue.length;
    }
    return out;
  };

  // Find a stored highlight in the current text: exact context first, then
  // the passage alone.
  const locate = (h) => {
    const full = root.textContent;
    const withContext = h.prefix + h.text + h.suffix;
    let i = withContext.length > h.text.length ? full.indexOf(withContext) : -1;
    if (i !== -1) return [i + h.prefix.length, i + h.prefix.length + h.text.length];
    i = full.indexOf(h.text);
    return i === -1 ? null : [i, i + h.text.length];
  };

  // Wrap [start, end) of root's text in <mark>s (one per text node touched).
  const wrap = (start, end, id) => {
    const marks = [];
    for (const t of textNodes()) {
      if (t.end <= start || t.start >= end) continue;
      if (!t.node.nodeValue.trim()) continue; // whitespace between blocks
      const parentTag = t.node.parentNode && t.node.parentNode.nodeName;
      if (/^(UL|OL|TABLE|TBODY|THEAD|TR)$/.test(parentTag)) continue;

      let node = t.node;
      const from = Math.max(0, start - t.start);
      const to = Math.min(node.nodeValue.length, end - t.start);
      if (to < node.nodeValue.length) node.splitText(to);
      if (from > 0) node = node.splitText(from);

      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.dataset.hlId = id;
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      node.parentNode.insertBefore(mark, node);
      mark.appendChild(node);
      marks.push(mark);
    }
    if (marks.length) {
      marks[0].id = "hl-" + id;
      syncNoteFlag(id);
    }
    return marks;
  };

  const marksFor = (id) => Array.from(root.querySelectorAll('mark.hl[data-hl-id="' + id + '"]'));

  const unwrap = (id) => {
    marksFor(id).forEach((m) => {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    });
  };

  const syncNoteFlag = (id) => {
    const has = !!(notes.get(id) || "").trim();
    marksFor(id).forEach((m, i) => {
      m.classList.toggle("hl--note", has);
      m.setAttribute("aria-label", has ? "Highlight with note" : "Highlight");
      m.classList.toggle("hl--last", i === marksFor(id).length - 1);
    });
  };

  // ---------- popover ----------

  const buildPopover = () => {
    popover = document.createElement("div");
    popover.className = "hl-pop";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Highlight");
    popover.hidden = true;
    popover.innerHTML =
      '<div class="hl-pop__actions">' +
      '<button type="button" class="hl-pop__btn" data-act="highlight"><i class="fas fa-highlighter" aria-hidden="true"></i> Highlight</button>' +
      '<button type="button" class="hl-pop__btn" data-act="note"><i class="far fa-sticky-note" aria-hidden="true"></i> Note</button>' +
      '<button type="button" class="hl-pop__btn hl-pop__btn--danger" data-act="remove"><i class="far fa-trash-alt" aria-hidden="true"></i> Remove</button>' +
      "</div>" +
      '<form class="hl-pop__note" hidden>' +
      '<label class="hl-pop__label" for="hl-note-text">Private note</label>' +
      '<textarea id="hl-note-text" rows="3" maxlength="2000" placeholder="Only you can see this"></textarea>' +
      '<div class="hl-pop__row">' +
      '<span class="hl-pop__status" aria-live="polite"></span>' +
      '<button type="submit" class="hl-pop__btn hl-pop__btn--primary">Save note</button>' +
      "</div></form>";
    document.body.appendChild(popover);

    popover.addEventListener("mousedown", (e) => {
      // Keep the text selection alive while clicking popover buttons.
      if (e.target.closest("button")) e.preventDefault();
    });
    popover.addEventListener("click", onPopoverClick);
    popover.querySelector("form").addEventListener("submit", onSaveNote);
    popover.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hidePopover(true);
    });
  };

  const show = (rect, mode) => {
    const form = popover.querySelector("form");
    const status = popover.querySelector(".hl-pop__status");
    status.textContent = "";
    popover.querySelector('[data-act="highlight"]').hidden = mode !== "new";
    popover.querySelector('[data-act="remove"]').hidden = mode !== "existing";
    popover.querySelector('[data-act="note"]').hidden = mode === "note-open";
    form.hidden = mode !== "note-open";

    popover.hidden = false;
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    const margin = 8;
    let left = rect.left + rect.width / 2 - pw / 2 + window.scrollX;
    left = Math.max(window.scrollX + margin, Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - margin));
    let top = rect.top + window.scrollY - ph - margin;
    if (rect.top - ph - margin < 70) top = rect.bottom + window.scrollY + margin; // below if no room above (fixed nav)
    popover.style.left = left + "px";
    popover.style.top = top + "px";
  };

  let lastFocus = null;
  const hidePopover = (restoreFocus) => {
    if (!popover || popover.hidden) return;
    popover.hidden = true;
    pendingRange = null;
    activeId = null;
    if (restoreFocus && lastFocus && document.contains(lastFocus)) lastFocus.focus();
  };

  const openNoteEditor = (rect) => {
    const ta = popover.querySelector("textarea");
    ta.value = activeId ? notes.get(activeId) || "" : "";
    show(rect, "note-open");
    ta.focus();
  };

  // ---------- create / edit / delete ----------

  const createFromRange = async (range, note) => {
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    const full = root.textContent;
    const raw = full.slice(start, end);
    // Trim the selection to its visible text so a stray space isn't saved.
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const s = start + lead;
    const e = end - trail;
    if (e <= s) return null;

    const body = {
      blogId,
      text: full.slice(s, e).slice(0, 1000),
      prefix: full.slice(Math.max(0, s - CONTEXT), s),
      suffix: full.slice(e, e + CONTEXT),
      note: note || "",
    };
    // Optimistic: draw it now under a temporary id, swap in the real one.
    const tempId = "tmp" + Date.now();
    notes.set(tempId, body.note);
    wrap(s, s + body.text.length, tempId);
    window.getSelection().removeAllRanges();
    try {
      const { highlight } = await api("/highlights", { method: "POST", body: JSON.stringify(body) });
      marksFor(tempId).forEach((m, i) => {
        m.dataset.hlId = highlight._id;
        if (i === 0) m.id = "hl-" + highlight._id;
      });
      notes.delete(tempId);
      notes.set(highlight._id, highlight.note);
      syncNoteFlag(highlight._id);
      return highlight._id;
    } catch (err) {
      unwrap(tempId);
      notes.delete(tempId);
      flash("Couldn't save the highlight: " + err.message);
      return null;
    }
  };

  async function onPopoverClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const rect = popover.getBoundingClientRect();
    const anchor = { left: rect.left, width: rect.width, top: rect.bottom + 8, bottom: rect.bottom + 8 };

    if (act === "highlight" && pendingRange) {
      const range = pendingRange;
      hidePopover();
      await createFromRange(range, "");
    } else if (act === "note") {
      if (pendingRange && !activeId) {
        // New highlight with a note: create it first, then open the editor.
        const range = pendingRange;
        const selRect = range.getBoundingClientRect();
        hidePopover();
        const id = await createFromRange(range, "");
        if (!id) return;
        activeId = id;
        openNoteEditor(selRect);
      } else if (activeId) {
        const first = marksFor(activeId)[0];
        openNoteEditor(first ? first.getBoundingClientRect() : anchor);
      }
    } else if (act === "remove" && activeId) {
      const id = activeId;
      const note = notes.get(id);
      const marks = marksFor(id);
      const ranges = marks.length ? [offsetOf(marks[0], 0), offsetOf(marks[marks.length - 1], marks[marks.length - 1].childNodes.length)] : null;
      hidePopover(true);
      unwrap(id);
      notes.delete(id);
      try {
        await api("/highlights/" + id, { method: "DELETE" });
      } catch (err) {
        if (ranges) { notes.set(id, note); wrap(ranges[0], ranges[1], id); }
        flash("Couldn't remove the highlight: " + err.message);
      }
    }
  }

  async function onSaveNote(e) {
    e.preventDefault();
    if (!activeId) return;
    const id = activeId;
    const ta = popover.querySelector("textarea");
    const status = popover.querySelector(".hl-pop__status");
    const btn = popover.querySelector('button[type="submit"]');
    btn.disabled = true;
    status.textContent = "Saving…";
    try {
      const { highlight } = await api("/highlights/" + id, {
        method: "PATCH",
        body: JSON.stringify({ note: ta.value }),
      });
      notes.set(id, highlight.note);
      syncNoteFlag(id);
      status.textContent = "Saved";
      setTimeout(() => hidePopover(true), 400);
    } catch (err) {
      status.textContent = "Couldn't save — try again";
    } finally {
      btn.disabled = false;
    }
  }

  // A small transient message for failures.
  const flash = (msg) => {
    const el = document.createElement("div");
    el.className = "hl-toast";
    el.setAttribute("role", "status");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  };

  // ---------- events ----------

  const selectionInRoot = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    if (!range.toString().trim()) return null;
    return range;
  };

  const onSelectEnd = () => {
    // Let the browser finish updating the selection first.
    setTimeout(() => {
      const range = selectionInRoot();
      if (!range) return;
      pendingRange = range.cloneRange();
      activeId = null;
      lastFocus = document.activeElement;
      show(range.getBoundingClientRect(), "new");
    }, 0);
  };

  const openExisting = (mark) => {
    activeId = mark.dataset.hlId;
    if (activeId.startsWith("tmp")) return; // still saving
    pendingRange = null;
    lastFocus = mark;
    const note = (notes.get(activeId) || "").trim();
    if (note) {
      // Show the note straight away, ready to edit.
      openNoteEditor(mark.getBoundingClientRect());
      popover.querySelector('[data-act="remove"]').hidden = false;
      popover.querySelector(".hl-pop__actions").hidden = false;
    } else {
      show(mark.getBoundingClientRect(), "existing");
    }
  };

  function init(r) {
    if (!r || root) return;
    root = r;
    buildPopover();

    root.addEventListener("mouseup", onSelectEnd);
    root.addEventListener("touchend", onSelectEnd);
    root.addEventListener("keyup", (e) => {
      if (e.shiftKey) onSelectEnd();
    });
    root.addEventListener("click", (e) => {
      const mark = e.target.closest("mark.hl");
      if (mark && window.getSelection().isCollapsed) openExisting(mark);
    });
    root.addEventListener("keydown", (e) => {
      const mark = e.target.closest && e.target.closest("mark.hl");
      if (mark && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openExisting(mark);
      }
    });
    document.addEventListener("mousedown", (e) => {
      if (popover.hidden || popover.contains(e.target) || e.target.closest("mark.hl")) return;
      hidePopover();
    });
    window.addEventListener("resize", () => hidePopover());

    api("/highlights/blog/" + blogId)
      .then(({ highlights }) => {
        highlights.forEach((h) => {
          const at = locate(h);
          if (!at) return; // passage edited away; still on the Highlights page
          notes.set(h._id, h.note);
          wrap(at[0], at[1], h._id);
        });
        // Arrived from the Highlights page: jump to the one clicked.
        if (location.hash.startsWith("#hl-")) {
          const target = document.getElementById(location.hash.slice(1));
          if (target) {
            target.scrollIntoView({ block: "center" });
            target.classList.add("hl--flash");
            setTimeout(() => target.classList.remove("hl--flash"), 1600);
          }
        }
      })
      .catch((err) => console.error("Couldn't load highlights:", err));
  }

  const content = document.getElementById("blog-content");
  if (content && content.dataset.ready) init(content);
  else document.addEventListener("lumina:post-ready", (e) => init(e.detail && e.detail.root));
})();
