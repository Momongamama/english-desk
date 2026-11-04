/* English Desk service worker: makes the site open and work offline (cards, logs, the last news and dictionary words you looked up).
   Only same-origin GET requests are handled. Everything else (AI APIs, GitHub, fonts, article proxies) goes straight to the network.
   - Pages and *.json (news, podcasts): network first, so you always get the newest copy online; the saved copy when offline.
   - Scripts with ?v=, icons and dict/ files: cache first. A new ?v= is a new URL, so updates still arrive; older versions are dropped. */
const CACHE = "english-desk-v1";
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => e.waitUntil((async () => {
  const c = await caches.open(CACHE);
  await c.addAll(SHELL);
  // Also save the scripts the current page uses, so the very first offline open works.
  const html = await (await c.match("./")).text();
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(u => !/^https?:/.test(u));
  await Promise.all(scripts.map(u => c.add(u).catch(() => { })));
  await self.skipWaiting();
})()));

self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// On a weak connection (subway), wait at most 4 s for the network before showing the saved copy; the download still finishes and refreshes the cache.
async function networkFirst(req, key) {
  const c = await caches.open(CACHE);
  const net = fetch(req).then(async res => { if (res.ok && !res.redirected) await c.put(key, res.clone()); return res });
  net.catch(() => { });
  const saved = () => c.match(key, { ignoreSearch: key !== req });
  const slow = new Promise(r => setTimeout(r, 4000)).then(saved);
  try {
    const first = await Promise.race([net, slow]);
    if (first) return first;
    return await net;
  } catch (err) {
    const hit = await saved();
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    // Drop older ?v= copies of the same file, then save this one.
    const path = new URL(req.url).pathname;
    for (const k of await c.keys()) { const u = new URL(k.url); if (u.pathname === path && k.url !== req.url) await c.delete(k) }
    await c.put(req, res.clone());
  }
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (req.mode === "navigate") { e.respondWith(networkFirst(req, "./")); return }
  // news.json?d=<date> and podcasts.json?d=<date>: keep one copy per file, so yesterday's news still shows offline.
  if (url.pathname.endsWith(".json") && !url.pathname.includes("/dict/")) { e.respondWith(networkFirst(req, url.pathname)); return }
  if (url.search.includes("v=") || url.pathname.includes("/dict/") || url.pathname.includes("/icons/")) { e.respondWith(cacheFirst(req)); return }
  e.respondWith(networkFirst(req, req));
});
