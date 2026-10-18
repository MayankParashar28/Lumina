// Global client helpers that replace former inline on* handlers, so the CSP can
// drop script-src-attr 'unsafe-inline'. Loaded on every page via the footer.
// All delegation is on `document` and late-binds the target function, so it
// also works for dynamically-inserted elements.
(() => {
  // --- Image fallback (replaces onerror="this.src='...'") ---
  // DOMPurify strips on* attributes but keeps data-*, so injected <img>s keep
  // their data-fallback. Capture phase catches non-bubbling error events.
  document.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (
        el &&
        el.tagName === "IMG" &&
        el.dataset &&
        el.dataset.fallback &&
        el.getAttribute("src") !== el.dataset.fallback
      ) {
        const fb = el.dataset.fallback;
        el.removeAttribute("data-fallback"); // prevent loops
        el.src = fb;
      }
    },
    true
  );

  // Built-in actions that have no dedicated global function.
  const CLICK_BUILTINS = {
    goBack: () => history.back(),
    reload: () => location.reload(),
    scrollToComments: () =>
      document.getElementById("comments")?.scrollIntoView({ behavior: "smooth" }),
  };
  const ELEMENT_BUILTINS = {
    autoGrow: (el) => {
      el.style.height = "";
      el.style.height = el.scrollHeight + "px";
    },
  };

  // --- Generic click delegation: data-action -> builtin or window[name]() ---
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const name = el.dataset.action;
    const fn = CLICK_BUILTINS[name] || window[name];
    if (typeof fn === "function") fn();
  });

  // --- Change / input delegation: pass the element (replaces fn(this)) ---
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-change]");
    if (!el) return;
    const fn = ELEMENT_BUILTINS[el.dataset.change] || window[el.dataset.change];
    if (typeof fn === "function") fn(el);
  });
  document.addEventListener("input", (e) => {
    const el = e.target.closest("[data-input]");
    if (!el) return;
    const fn = ELEMENT_BUILTINS[el.dataset.input] || window[el.dataset.input];
    if (typeof fn === "function") fn(el);
  });

  // --- Confirm-on-submit: data-confirm="message" (replaces onsubmit=confirm) ---
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("form[data-confirm]");
    if (form && !window.confirm(form.dataset.confirm)) e.preventDefault();
  });

  // Run a callback once the DOM is ready (this file is deferred, so the DOM is
  // usually parsed already, but guard for safety).
  const onReady = (fn) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  };

  // ===================================================================
  // 🔔 Toast notifications  —  window.showToast(msg, type, opts) + [data-toast]
  // ===================================================================
  let toastWrap;
  const getToastWrap = () => {
    if (!toastWrap || !document.body.contains(toastWrap)) {
      toastWrap = document.createElement("div");
      toastWrap.className = "app-toast-wrap";
      document.body.appendChild(toastWrap);
    }
    return toastWrap;
  };
  const TOAST_ICONS = { success: "fa-circle-check", error: "fa-circle-xmark", warn: "fa-triangle-exclamation", info: "fa-circle-info" };
  // opts may be a number (timeout ms) or { timeout, action: { label, onClick } }.
  window.showToast = (message, type = "info", opts = {}) => {
    if (!message) return null;
    if (typeof opts === "number") opts = { timeout: opts };
    const timeout = opts.timeout != null ? opts.timeout : 3200;

    const t = document.createElement("div");
    t.className = `app-toast app-toast--${type}`;
    t.setAttribute("role", type === "error" ? "alert" : "status");

    const icon = document.createElement("i");
    icon.className = `fas ${TOAST_ICONS[type] || TOAST_ICONS.info} app-toast__icon`;
    const msg = document.createElement("span");
    msg.className = "app-toast__msg";
    msg.textContent = message; // textContent keeps it XSS-safe
    t.appendChild(icon);
    t.appendChild(msg);

    const dismiss = () => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 300);
    };

    if (opts.action && opts.action.label) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "app-toast__action";
      btn.textContent = opts.action.label;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        try { opts.action.onClick && opts.action.onClick(); } finally { dismiss(); }
      });
      t.appendChild(btn);
    } else {
      t.addEventListener("click", dismiss); // tap anywhere to dismiss
    }

    getToastWrap().appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    if (timeout > 0) setTimeout(dismiss, timeout);
    return t;
  };
  // Declarative trigger: <button data-toast="Saved!" data-toast-type="success">
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-toast]");
    if (!el) return;
    window.showToast(el.dataset.toast, el.dataset.toastType || "info");
  });

  // ===================================================================
  // 📋 Copy to clipboard  —  copyText() + [data-copy] / [data-copy-target]
  // ===================================================================
  const legacyCopy = (text) =>
    new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        ok ? resolve() : reject(new Error("copy command failed"));
      } catch (err) {
        reject(err);
      }
    });
  const copyText = (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      // Fall back to execCommand if the Clipboard API is permission-blocked.
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return legacyCopy(text);
  };
  window.copyText = copyText;

  const resolveCopyText = (el) => {
    const sel = el.dataset.copyTarget;
    if (sel) {
      const target = document.querySelector(sel);
      if (target) {
        return "value" in target && target.value != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
          ? target.value
          : target.textContent;
      }
    }
    if (el.dataset.copy) return el.dataset.copy;
    return el.textContent;
  };
  const flashCopied = (el) => {
    if (!el.matches("button, .copy-btn") || el.dataset._copying) return;
    const prev = el.innerHTML;
    el.dataset._copying = "1";
    el.classList.add("copied");
    el.innerHTML = '<i class="fas fa-check"></i> Copied!';
    setTimeout(() => {
      el.innerHTML = prev;
      el.classList.remove("copied");
      delete el.dataset._copying;
    }, 1600);
  };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-copy], [data-copy-target]");
    if (!el) return;
    const text = (resolveCopyText(el) || "").trim();
    if (!text) return;
    copyText(text)
      .then(() => { flashCopied(el); window.showToast("Copied to clipboard", "success", 1600); })
      .catch(() => window.showToast("Couldn't copy to clipboard", "error"));
  });

  // Auto-add a copy button to every <pre> code block inside article content.
  // Exposed so pages that inject content after load (e.g. the sanitized blog
  // body) can re-run it.
  window.addCodeCopyButtons = (root = document) => {
    root.querySelectorAll(".blog-content pre, article pre, .ql-editor pre").forEach((pre) => {
      if (pre.querySelector(".code-copy-btn") || pre.dataset._copyified) return;
      pre.dataset._copyified = "1";
      const code = pre.innerText;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "code-copy-btn copy-btn";
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = '<i class="fas fa-copy"></i>';
      btn.dataset.copy = code;
      pre.appendChild(btn);
    });
  };
  onReady(() => window.addCodeCopyButtons());

  // ===================================================================
  // 🔗 Native share  —  [data-share] with clipboard fallback
  // ===================================================================
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-share]");
    if (!el) return;
    e.preventDefault();
    const shareData = {
      title: el.dataset.shareTitle || document.title,
      url: el.dataset.shareUrl || location.href,
    };
    if (el.dataset.shareText) shareData.text = el.dataset.shareText;
    if (navigator.share) {
      navigator.share(shareData).catch(() => {}); // user-cancel is not an error
    } else {
      copyText(shareData.url)
        .then(() => window.showToast("Link copied — paste it anywhere to share!", "success"))
        .catch(() => window.showToast("Couldn't share this link", "error"));
    }
  });

  // ===================================================================
  // 📊 Reading progress bar  —  [data-reading-progress]
  // ===================================================================
  const updateProgress = () => {
    const bars = document.querySelectorAll("[data-reading-progress]");
    if (!bars.length) return;
    const doc = document.documentElement;
    const scrollable = doc.scrollHeight - doc.clientHeight;
    const pct = scrollable > 0 ? Math.min(100, Math.max(0, (doc.scrollTop / scrollable) * 100)) : 0;
    bars.forEach((b) => { b.style.width = pct.toFixed(2) + "%"; });
  };
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress, { passive: true });
  onReady(updateProgress);

  // ===================================================================
  // 💾 Local auto-save drafts  —  [data-autosave="<key>"]
  // ===================================================================
  const AUTOSAVE_PREFIX = "blogify:autosave:";
  // Save most fields, but never the CSRF token, files, or opted-out fields.
  // Hidden fields ARE saved (e.g. a Quill editor's synced hidden <input name="body">).
  const isSaveableField = (f) =>
    f &&
    f.name &&
    f.name !== "_csrf" &&
    !f.hasAttribute("data-noautosave") &&
    !/^(password|file|submit|button|reset)$/.test(f.type || "");
  const serializeForm = (form) => {
    const data = {};
    form.querySelectorAll("input[name], textarea[name], select[name]").forEach((f) => {
      if (!isSaveableField(f)) return;
      if ((f.type === "radio" || f.type === "checkbox") && !f.checked) return;
      data[f.name] = f.value;
    });
    return data;
  };
  const applyForm = (form, data) => {
    Object.entries(data).forEach(([name, val]) => {
      const f = form.querySelector(`[name="${(window.CSS && CSS.escape) ? CSS.escape(name) : name}"]`);
      if (!isSaveableField(f)) return;
      if (f.type === "radio") {
        const match = form.querySelector(`[name="${(window.CSS && CSS.escape) ? CSS.escape(name) : name}"][value="${(window.CSS && CSS.escape) ? CSS.escape(val) : val}"]`);
        if (match) match.checked = true;
      } else {
        f.value = val;
        f.dispatchEvent(new Event("input", { bubbles: true })); // refresh auto-grow etc.
      }
    });
    // Let the page sync non-input editors (e.g. Quill) from the restored fields.
    form.dispatchEvent(new CustomEvent("autosave:restored", { bubbles: true }));
  };
  onReady(() => {
    document.querySelectorAll("[data-autosave]").forEach((el) => {
      const key = AUTOSAVE_PREFIX + el.dataset.autosave;
      const isForm = el.tagName === "FORM";

      // 1) Offer to restore a previous draft.
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
      if (saved && saved.t) {
        const hasContent = isForm
          ? Object.values(saved.v || {}).some((v) => v && String(v).trim())
          : saved.v && String(saved.v).trim();
        if (hasContent) {
          const when = new Date(saved.t).toLocaleString();
          window.showToast(`Unsaved draft from ${when} found.`, "info", {
            timeout: 12000,
            action: {
              label: "Restore",
              onClick: () => {
                if (isForm) applyForm(el, saved.v);
                else { el.value = saved.v; el.dispatchEvent(new Event("input", { bubbles: true })); }
                window.showToast("Draft restored", "success", 1600);
              },
            },
          });
        }
      }

      // 2) Save (debounced) while typing, updating any [data-autosave-status] UI.
      const statusEl = document.querySelector("[data-autosave-status]");
      const setStatus = (text, saving) => {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle("is-saving", !!saving);
        statusEl.classList.toggle("is-saved", !saving);
      };
      let timer;
      const save = () => {
        clearTimeout(timer);
        setStatus("Saving…", true);
        timer = setTimeout(() => {
          try {
            const v = isForm ? serializeForm(el) : el.value;
            localStorage.setItem(key, JSON.stringify({ t: Date.now(), v }));
            setStatus("Saved ✓", false);
          } catch (_) {
            setStatus("", false);
          }
        }, 800);
      };
      el.addEventListener("input", save);

      // 3) Clear the draft once the form is submitted.
      const form = isForm ? el : el.closest("form");
      if (form) form.addEventListener("submit", () => { try { localStorage.removeItem(key); } catch (_) {} });
    });
  });
})();
