/* LifeRPG service worker - cache on demand, lightweight */
const CACHE = "liferpg-v1";

self.addEventListener("install", (event) => {
  // Precache only the shell that already exists
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll([
        "./",
        "./index.html",
        "./styles.css",
        "./manifest.webmanifest"
      ])
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // For everything: try cache, then network; update cache in background
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req).then((netRes) => {
        // Ignore opaque/error responses
        if (netRes && netRes.ok) {
          caches.open(CACHE).then((c) => c.put(req, netRes.clone()));
        }
        return netRes;
      }).catch(() => cached); // offline fallback
      return cached || fetchPromise;
    })
  );
});
