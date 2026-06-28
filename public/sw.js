// Minimal service worker: just enough to be an installable PWA that opens
// when offline. It caches the app shell only. Matrix API calls and media are
// always left to the network — we never want stale messages or stale auth.

const CACHE = "minimatrix-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
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

  if (request.method !== "GET") return;

  // The homeserver and media downloads are cross-origin and always go straight
  // to the network. Same-origin build assets are app shell and can be cached.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isShellAsset(url)) event.respondWith(cacheFirst(request));
});

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const index = await fetch("/index.html", { cache: "no-cache" });
  if (!index.ok) throw new Error("Could not cache app shell");

  const html = await index.clone().text();
  await cache.put("/", index.clone());
  await cache.put("/index.html", index);
  await cache.addAll([
    ...SHELL.filter((path) => path !== "/" && path !== "/index.html"),
    ...assetsIn(html),
  ]);
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put("/index.html", response.clone());
    }
    return response;
  } catch {
    return (await caches.match("/index.html")) ?? (await caches.match("/")) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

function isShellAsset(url) {
  return url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname);
}

function assetsIn(html) {
  const assets = new Set();
  const attr = /\b(?:href|src)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attr)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
      assets.add(url.pathname);
    }
  }
  return [...assets];
}
