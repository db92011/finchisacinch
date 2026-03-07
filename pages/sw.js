/* sw.js — Finch (Android-safe)
   Goal: prevent mixed versions.
   Strategy:
   - Network-first for HTML/JS/CSS (always try fresh)
   - Cache fallback only (for offline)
   - Hard wipe old caches on activate
*/

const CACHE = "finch-static-v2"; // bump this to force-refresh everything

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))));
    await self.clients.claim();

    // Tell all open tabs to reload (helps Android PWAs)
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => c.postMessage({ type: "FINCH_SW_ACTIVATED", cache: CACHE }));
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";
  const isHTML = req.mode === "navigate" || accept.includes("text/html");

  const isCodeAsset =
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".html");

  const isOtherAsset =
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".svg");

  // Network-first for HTML + code assets (prevents Franken-builds)
  if (isHTML || isCodeAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);

      try {
        // Always try fresh
        const fresh = await fetch(req, { cache: "no-store" });

        // Only cache successful responses
        if (fresh && fresh.ok) {
          await cache.put(req, fresh.clone());
        }

        return fresh;
      } catch {
        // Offline fallback
        const cached = await cache.match(req);
        return cached || new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Cache-first for static non-code assets (icons etc.)
  if (isOtherAsset) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;

      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return new Response("Offline", { status: 503 });
      }
    })());
    return;
  }

  // Default: just pass through
});