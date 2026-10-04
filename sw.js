/*
 * Fuel by Buzah — service worker (makes the pages installable and lets them
 * open without a connection). Network first: you always get the latest
 * version when online; the cached copy is only a fallback when offline.
 * Only this site's own files are cached. Database calls go straight to Supabase.
 */
const CACHE = "fuel-by-buzah-v1";
const SHELL = [
  "./", "index.html", "order.html", "css/styles.css", "css/order.css",
  "js/config.js", "js/logic.js", "js/seed.js", "js/store.js", "js/route.js", "js/recalls.js", "js/app.js",
  "js/shoptools.js", "js/order.js", "img/icon-192.png", "img/icon-512.png", "img/icon-180.png", "img/logo-full.png", "img/logo-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("order.html")))
  );
});
