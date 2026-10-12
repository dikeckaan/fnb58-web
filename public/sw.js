// Offline cache. Built assets carry a content hash in their name, so they are
// safe to keep forever. Everything else is refreshed in the background.
const CACHE = 'fnb58-bench-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  const put = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  };

  if (req.mode === 'navigate') {
    // Newest page when online, last good page when not.
    event.respondWith(fetch(req).then(put).catch(() => caches.match(req).then((hit) => hit || caches.match('./'))));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req).then(put).catch(() => hit);
      return hit || fresh;
    }),
  );
});
