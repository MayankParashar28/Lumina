// Table of contents + "minutes left" for a post.
//
// Built from the headings in the rendered body once blog.ejs has injected it
// (it fires `lumina:post-ready`). Short posts — fewer than three headings —
// get nothing: a contents list with one entry is noise.
//
// Wide screens: a sticky panel in the left gutter with the current section
// highlighted. Narrow screens: a collapsible "Contents" box above the body.
(function () {
  "use strict";

  const MIN_HEADINGS = 3;
  const WORDS_PER_MINUTE = 200;

  const slugify = (text) =>
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section";

  function build(root) {
    if (!root || root.dataset.tocBuilt) return;
    root.dataset.tocBuilt = "1";

    const headings = Array.from(root.querySelectorAll("h1, h2, h3")).filter(
      (h) => h.textContent.trim().length > 0
    );

    const totalWords = (root.innerText || "").split(/\s+/).filter(Boolean).length;
    const totalMinutes = Math.max(1, Math.round(totalWords / WORDS_PER_MINUTE));

    if (headings.length < MIN_HEADINGS) return;

    // Stable, unique ids so a section can be linked to (#why-this-matters).
    const used = new Set();
    headings.forEach((h) => {
      if (h.id) { used.add(h.id); return; }
      let id = slugify(h.textContent);
      let n = 2;
      while (used.has(id) || document.getElementById(id)) id = slugify(h.textContent) + "-" + n++;
      used.add(id);
      h.id = id;
    });

    // Indent relative to the top heading level actually used, so a post that
    // only uses h2/h3 doesn't render everything one level deep.
    const topLevel = Math.min(...headings.map((h) => Number(h.tagName[1])));

    const makeList = () => {
      const ol = document.createElement("ol");
      ol.className = "post-toc__list";
      headings.forEach((h) => {
        const li = document.createElement("li");
        li.className = "post-toc__item post-toc__item--l" + (Number(h.tagName[1]) - topLevel);
        const a = document.createElement("a");
        a.href = "#" + h.id;
        a.textContent = h.textContent.trim();
        a.dataset.target = h.id;
        li.appendChild(a);
        ol.appendChild(li);
      });
      return ol;
    };

    // Wide: sticky side panel.
    const aside = document.createElement("nav");
    aside.className = "post-toc post-toc--side";
    aside.setAttribute("aria-label", "Contents");
    const title = document.createElement("p");
    title.className = "post-toc__title";
    title.textContent = "Contents";
    const left = document.createElement("p");
    left.className = "post-toc__left";
    aside.append(title, makeList(), left);
    document.body.appendChild(aside);

    // Narrow: collapsible box above the body.
    const details = document.createElement("details");
    details.className = "post-toc post-toc--inline";
    const summary = document.createElement("summary");
    summary.textContent = "Contents";
    details.append(summary, makeList());
    root.parentNode.insertBefore(details, root);

    // Smooth-scroll and close the inline box after a pick.
    document.addEventListener("click", (e) => {
      const a = e.target.closest(".post-toc a[data-target]");
      if (!a) return;
      const target = document.getElementById(a.dataset.target);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      history.replaceState(null, "", "#" + a.dataset.target);
      if (details.open && a.closest(".post-toc--inline")) details.open = false;
    });

    // Highlight the section being read: the last heading above the top third.
    const links = Array.from(document.querySelectorAll(".post-toc a[data-target]"));
    const setActive = () => {
      const line = window.innerHeight / 3;
      let current = null;
      for (const h of headings) {
        if (h.getBoundingClientRect().top <= line) current = h.id;
        else break;
      }
      links.forEach((a) => {
        const on = a.dataset.target === current;
        a.classList.toggle("is-active", on);
        if (on) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      });
      // Only show the side panel once the reader is in the article.
      const rect = root.getBoundingClientRect();
      aside.classList.toggle("is-visible", rect.top < window.innerHeight * 0.6 && rect.bottom > 0);
    };

    mountMinutesLeft(root, totalMinutes, left, setActive);
  }

  // "N min left", recomputed as the reader scrolls through the body.
  function mountMinutesLeft(root, totalMinutes, el, extra) {
    let ticking = false;
    const update = () => {
      ticking = false;
      if (el) {
        const rect = root.getBoundingClientRect();
        const read = Math.min(1, Math.max(0, (window.innerHeight * 0.5 - rect.top) / rect.height));
        const minutes = Math.ceil(totalMinutes * (1 - read));
        el.textContent = read >= 1 || minutes <= 0 ? "Finished" : minutes + " min left";
      }
      if (extra) extra();
    };
    const onScroll = () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    update();
  }

  const root = document.getElementById("blog-content");
  if (root && root.dataset.ready) build(root);
  else document.addEventListener("lumina:post-ready", (e) => build(e.detail && e.detail.root));
})();
