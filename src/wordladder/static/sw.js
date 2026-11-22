// Service worker: caches the app shell so it opens instantly from the home screen.
// Game data (/api, /ws) always goes to the network.

const CACHE = "wordladder-v1";
const SHELL = [
  "/",
  "/static/styles.css",
  "/static/app.js",
  "/manifest.webmanifest",
  "/static/icons/icon-192.png",
  "/static/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  // Pages: network first so updates show up, cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
    return;
  }
  // Static files: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const fresh = fetch(event.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        return res;
      });
      return hit || fresh;
    }),
  );
});
