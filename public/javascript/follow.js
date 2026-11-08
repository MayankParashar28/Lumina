// Instant Follow / Unfollow.
//
// Follow buttons are ordinary forms (so they still work without JavaScript),
// but submitting one used to reload the entire page. This intercepts the
// submit, flips every button for that author immediately, and sends the
// request in the background. If the server says no, the buttons flip back.
//
// A button opts in with data attributes describing its two states:
//   data-follow-btn data-following="true|false"
//   data-on-text / data-off-text      label when following / not following
//   data-on-class / data-off-class    class when following / not following
// A follower count opts in with data-follower-count="<authorId>" and
// data-singular / data-plural suffixes.
(function () {
  "use strict";

  const pending = new Set();

  function setButton(btn, following) {
    btn.dataset.following = String(following);
    const on = btn.dataset.onClass;
    const off = btn.dataset.offClass;
    if (on) btn.classList.toggle(on, following);
    if (off) btn.classList.toggle(off, !following);
    btn.textContent = following ? btn.dataset.onText : btn.dataset.offText;
    btn.setAttribute("aria-pressed", String(following));
  }

  function setCount(authorId, count) {
    document.querySelectorAll('[data-follower-count="' + authorId + '"]').forEach((el) => {
      const n = Math.max(0, count);
      el.dataset.count = String(n);
      el.textContent = n + (n === 1 ? el.dataset.singular : el.dataset.plural);
    });
  }

  function buttonsFor(action) {
    return Array.from(document.querySelectorAll('form[action="' + action + '"] [data-follow-btn]'));
  }

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const action = form.getAttribute("action") || "";
    const match = action.match(/^\/user\/follow\/([a-f\d]{24})$/i);
    if (!match || !form.querySelector("[data-follow-btn]") || !window.fetch) return;

    e.preventDefault();
    if (pending.has(action)) return; // a request for this author is already in flight
    pending.add(action);

    const authorId = match[1];
    const buttons = buttonsFor(action);
    const wasFollowing = buttons[0].dataset.following === "true";
    const countEl = document.querySelector('[data-follower-count="' + authorId + '"]');
    const prevCount = countEl ? Number(countEl.dataset.count) : null;

    // Optimistic: update now, confirm later.
    buttons.forEach((b) => setButton(b, !wasFollowing));
    if (prevCount !== null) setCount(authorId, prevCount + (wasFollowing ? -1 : 1));

    try {
      const res = await fetch(action, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: new URLSearchParams(new FormData(form)),
      });
      if (res.status === 401) {
        window.location.href = "/user/signin?follow=" + authorId +
          "&next=" + encodeURIComponent(location.pathname);
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || "HTTP " + res.status);

      // Trust the server's answer (e.g. if another tab changed it meanwhile).
      buttons.forEach((b) => setButton(b, data.following));
      if (typeof data.followerCount === "number") setCount(authorId, data.followerCount);
    } catch (err) {
      console.error("Follow failed:", err);
      buttons.forEach((b) => setButton(b, wasFollowing));
      if (prevCount !== null) setCount(authorId, prevCount);
    } finally {
      pending.delete(action);
    }
  });
})();
