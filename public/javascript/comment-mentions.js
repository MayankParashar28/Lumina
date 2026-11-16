// 💬 @mention autocomplete in comment and reply boxes.
//
// Type "@" followed by a few letters and a list of people on this post — its
// author and everyone who has commented — appears. ↑/↓ to move, Enter or Tab
// to insert, Escape to dismiss. The server notifies whoever is mentioned.
//
// The list is fetched once, on first use, from /blog/api/mentions/:blogId.
(function () {
  "use strict";

  const host = document.getElementById("mention-source");
  if (!host) return;
  const blogId = host.dataset.blogId;

  let people = null; // loaded lazily
  let loading = null;
  let menu = null;
  let field = null; // the textarea the menu belongs to
  let matches = [];
  let active = 0;
  let tokenStart = -1; // index of the "@" being completed

  const load = () => {
    if (people) return Promise.resolve(people);
    if (!loading) {
      loading = fetch("/blog/api/mentions/" + blogId, { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { people: [] }))
        .then((d) => (people = d.people || []))
        .catch(() => (people = []));
    }
    return loading;
  };

  const isCommentBox = (el) =>
    el instanceof HTMLTextAreaElement && !!el.closest(".comment-form, .reply-form");

  // The "@word" immediately before the caret, if any.
  const currentToken = (ta) => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_]{0,30})$/.exec(upto);
    if (!m) return null;
    return { start: upto.length - m[2].length - 1, query: m[2].toLowerCase() };
  };

  const ensureMenu = () => {
    if (menu) return menu;
    menu = document.createElement("ul");
    menu.className = "mention-menu";
    menu.id = "mention-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "People you can mention");
    menu.hidden = true;
    document.body.appendChild(menu);
    menu.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-index]");
      if (!li) return;
      e.preventDefault(); // keep focus in the textarea
      choose(Number(li.dataset.index));
    });
    return menu;
  };

  const close = () => {
    if (menu) menu.hidden = true;
    if (field) {
      field.removeAttribute("aria-activedescendant");
      field.setAttribute("aria-expanded", "false");
    }
    matches = [];
    tokenStart = -1;
  };

  const render = () => {
    const m = ensureMenu();
    m.replaceChildren();
    matches.forEach((p, i) => {
      const li = document.createElement("li");
      li.id = "mention-opt-" + i;
      li.dataset.index = i;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === active));
      li.className = "mention-menu__item" + (i === active ? " is-active" : "");
      const img = document.createElement("img");
      img.src = p.avatar;
      img.alt = "";
      img.width = 24;
      img.height = 24;
      img.loading = "lazy";
      const name = document.createElement("span");
      name.className = "mention-menu__name";
      name.textContent = p.name;
      const handle = document.createElement("span");
      handle.className = "mention-menu__handle";
      handle.textContent = "@" + p.handle + (p.isAuthor ? " · author" : "");
      li.append(img, name, handle);
      m.appendChild(li);
    });
    field.setAttribute("aria-activedescendant", "mention-opt-" + active);

    // Position under the textarea.
    const r = field.getBoundingClientRect();
    m.hidden = false;
    const width = Math.min(320, document.documentElement.clientWidth - 16);
    m.style.width = width + "px";
    let left = r.left + window.scrollX;
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - width - 8);
    m.style.left = Math.max(8, left) + "px";
    m.style.top = r.bottom + window.scrollY + 4 + "px";
  };

  const update = async (ta) => {
    const tok = currentToken(ta);
    if (!tok) return close();
    field = ta;
    field.setAttribute("aria-controls", "mention-menu");
    field.setAttribute("aria-autocomplete", "list");
    const list = await load();
    // The caret may have moved while loading.
    const again = currentToken(ta);
    if (!again || document.activeElement !== ta) return close();
    tokenStart = again.start;
    const q = again.query;
    matches = list
      .filter((p) => !q || p.handle.toLowerCase().startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
      .sort((a, b) => Number(b.isAuthor) - Number(a.isAuthor) || a.name.localeCompare(b.name))
      .slice(0, 6);
    if (!matches.length) return close();
    active = 0;
    field.setAttribute("aria-expanded", "true");
    render();
  };

  const choose = (i) => {
    const p = matches[i];
    if (!p || !field || tokenStart < 0) return close();
    const before = field.value.slice(0, tokenStart);
    const after = field.value.slice(field.selectionStart);
    const insert = "@" + p.handle + " ";
    field.value = before + insert + after.replace(/^[a-zA-Z0-9_]*/, "");
    const caret = before.length + insert.length;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true })); // auto-grow etc.
    close();
    field.focus();
  };

  document.addEventListener("input", (e) => {
    if (isCommentBox(e.target)) update(e.target);
  });

  // Capture phase so Enter picks a person instead of submitting the form.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!menu || menu.hidden || e.target !== field) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        render();
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        choose(active);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    true
  );

  document.addEventListener("focusout", (e) => {
    if (e.target === field) setTimeout(close, 120);
  });
  window.addEventListener("resize", close);
})();
