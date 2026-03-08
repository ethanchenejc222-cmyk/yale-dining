// Yale Dining Service Worker
// Caches the app shell (HTML/CSS/JS) so it loads instantly offline.
// API calls are NOT cached here — the frontend handles data caching in localStorage.

const CACHE_NAME = 'yale-dining-v1';
const SHELL = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only cache-first for the HTML shell; everything else is network-first
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        const net = fetch(e.request).then(res => {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        });
        return cached || net;
      })
    );
  }
  // API calls: network only (data is cached in localStorage by the app)
});
