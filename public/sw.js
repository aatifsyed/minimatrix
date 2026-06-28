// Minimal service worker: just enough to be an installable PWA that opens
// when offline. It caches the app shell only. Matrix API calls and media are
// always left to the network — we never want stale messages or stale auth.

const CACHE = "minimatrix-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle navigations from our own origin; everything else (the
  // homeserver, media downloads) goes straight to the network untouched.
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(() => caches.match("/index.html").then((res) => res ?? Response.error())),
  );
});
