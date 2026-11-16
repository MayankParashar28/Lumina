// Lumina service worker: installable app + offline reading.
//
// - Pages: network first, always. A post page (/blog/<slug>) that loads fine
//   is also kept in a small cache, so it can be read again offline. Nothing
//   else is stored: feeds, notifications and account pages are always live.
// - Static files (CSS, JS, images): served from cache and refreshed in the
//   background. They are versioned in their URLs (?v=), so this is safe.
// - Offline with no saved copy: /offline.html, which lists what is saved.
// - Signing out clears the saved posts (they were rendered for that account).
const VERSION = "v1";
const SHELL = "lumina-shell-" + VERSION;
const ASSETS = "lumina-assets-" + VERSION;
const POSTS = "lumina-posts"; // unversioned on purpose: survives app updates

const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/javascript/offline.js", "/images/icon-192.png"];
const MAX_POSTS = 30;
const MAX_ASSETS = 150;

const POST_RE = /^\/blog\/(?:[a-f\d]{24}|[a-z\d]+(?:-[a-z\d]+)*-[a-f\d]{6})$/i;
const ASSET_RE = /^\/(?:css|javascript|images|vendor|embed)\/|^\/(?:favicon\.ico|apple-touch-icon\.png)$/;
// Never intercepted (apart from the offline fallback for page loads): live
// data, auth, editing, APIs, realtime.
const BYPASS_RE = /^\/(?:api|socket\.io|notifications|highlights|admin|metrics|health|healthz|cron|captcha|ai)(?:\/|$)|^\/blog\/(?:edit|api|preview)(?:\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // cache: "reload" skips the HTTP cache, where these may sit for a year.
      .then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("lumina-") && k !== SHELL && k !== ASSETS && k !== POSTS)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Keep a cache to `max` entries, dropping the oldest first.
async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Cache key for a post: the path alone, so ?published=1 etc. share one copy.
const postKey = (url) => new Request(url.origin + url.pathname);

async function handleNavigation(event, url) {
  try {
    const response = await fetch(event.request);
    if (
      POST_RE.test(url.pathname) &&
      response.ok &&
      response.status === 200 &&
      response.type === "basic" &&
      !response.redirected &&
      (response.headers.get("Content-Type") || "").includes("text/html")
    ) {
      const copy = response.clone();
      event.waitUntil(
        caches.open(POSTS).then(async (cache) => {
          const key = postKey(url);
          await cache.delete(key); // re-insert so it counts as most recent
          await cache.put(key, copy);
          await trim(POSTS, MAX_POSTS);
        })
      );
    }
    return response;
  } catch (err) {
    const saved = POST_RE.test(url.pathname) && (await caches.match(postKey(url), { cacheName: POSTS }));
    if (saved) return saved;
    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL });
    return offline || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function handleAsset(event) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(event.request);
  const refresh = fetch(event.request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await cache.put(event.request, response.clone());
        trim(ASSETS, MAX_ASSETS);
      }
      return response;
    })
    .catch(() => cached);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  const shell = await caches.match(event.request, { cacheName: SHELL });
  return shell || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Signing out: forget the posts saved under that account.
  if (url.pathname === "/user/logout") {
    event.waitUntil(caches.delete(POSTS));
    return;
  }
  // Page loads always go to the network first; only posts are saved, and any
  // page falls back to the offline screen instead of the browser's error page.
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event, url));
    return;
  }
  if (BYPASS_RE.test(url.pathname) || url.pathname === "/sw.js") return;
  if (ASSET_RE.test(url.pathname)) event.respondWith(handleAsset(event));
});
