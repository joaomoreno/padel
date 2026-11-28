const CACHE = 'padel-v1';
const APP_SHELL = './index.html';
const FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com']);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add(new Request(APP_SHELL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(APP_SHELL, copy));
        }
        return res;
      }).catch(() => caches.open(CACHE).then(c => c.match(APP_SHELL)))
    );
    return;
  }

  if (FONT_ORIGINS.has(url.origin)) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok || res.type === 'opaque') c.put(e.request, res.clone());
        return res;
      })
    );
  }
});
