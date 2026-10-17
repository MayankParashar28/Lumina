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
})();
