// Client-side navigation for the docs pages (About / Mission / Privacy / Terms).
// Swaps only the center content + table of contents instead of doing a full page
// reload, so moving between docs pages feels instant (progressive enhancement:
// if anything fails, it falls back to a normal navigation).
(() => {
  const DOCS_ROUTES = ["/about", "/mission", "/privacy", "/terms"];

  // Only run on the docs layout.
  if (!document.querySelector(".docs-wrapper")) return;

  const isDocsHref = (href) =>
    DOCS_ROUTES.includes((href || "").replace(/[?#].*$/, ""));

  async function loadDocs(href, push) {
    const main = document.querySelector(".docs-main");
    const rightNav = document.querySelector(".docs-sidebar-right");
    const leftLinks = document.querySelectorAll(".docs-sidebar-left a.docs-nav-link");
    if (!main) { window.location.href = href; return; }

    main.style.transition = "opacity 0.15s ease";
    main.style.opacity = "0.35";

    try {
      const res = await fetch(href, { headers: { "X-Requested-With": "fetch" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");

      const newMain = doc.querySelector(".docs-main");
      const newRight = doc.querySelector(".docs-sidebar-right");
      const newLeft = doc.querySelectorAll(".docs-sidebar-left a.docs-nav-link");
      const newTitle = doc.querySelector("title");

      if (!newMain) throw new Error("No .docs-main in response");

      main.innerHTML = newMain.innerHTML;
      if (newRight && rightNav) rightNav.innerHTML = newRight.innerHTML;
      if (newTitle) document.title = newTitle.textContent;

      // Sync active state from the freshly-rendered (path-aware) sidebar.
      leftLinks.forEach((a, i) => {
        a.classList.toggle("active", !!newLeft[i] && newLeft[i].classList.contains("active"));
      });

      if (push) history.pushState({ docs: true }, "", href);
      window.scrollTo({ top: 0, behavior: "instant" in document.documentElement.style ? "instant" : "auto" });
    } catch (err) {
      console.warn("Docs client-nav failed, falling back to full load:", err);
      window.location.href = href;
      return;
    } finally {
      main.style.opacity = "";
    }
  }

  // Intercept clicks on any internal docs link (sidebar, nav, footer).
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest("a[href]");
    if (!link) return;
    const href = link.getAttribute("href");
    if (!href || link.target === "_blank" || href.startsWith("mailto:")) return;
    if (!isDocsHref(href)) return;
    if (href.replace(/[?#].*$/, "") === location.pathname) { e.preventDefault(); return; }
    e.preventDefault();
    loadDocs(href, true);
  });

  // Back / forward buttons.
  window.addEventListener("popstate", () => {
    if (isDocsHref(location.pathname)) loadDocs(location.pathname, false);
  });
})();
