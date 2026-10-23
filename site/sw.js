// Earthwire service worker: makes the app installable and quick to reopen.
// App files are served from cache and refreshed in the background; news and
// weather always try the network first so they're never stale when online.
const VERSION = 'earthwire-v2.1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/globe.js', 'js/geo.js', 'js/data.js',
  'js/charts.js', 'js/population.js', 'vendor/three.module.min.js', 'assets/land.png',
  'assets/population-density.png', 'assets/icon.svg', 'data/countries.json', 'data/cities.json', 'data/stations.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const live = /\/data\/(news|history|weather)\.json$/.test(url.pathname);
  if (live) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(url.pathname, copy));
      return res;
    }).catch(() => caches.match(url.pathname)));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
