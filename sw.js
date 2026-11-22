/* Penny Alerts v1 service worker.
 * Caches the app shell so the app opens offline. The deal briefing JSON is
 * NEVER cached here — it is always fetched fresh (network-first) because
 * penny lists go stale fast.
 */
var CACHE = 'penny-alerts-v1';
var SHELL = ['index.html', 'styles.css', 'app.js', 'manifest.json', 'icon.svg'];
var BRIEFING = 'rocketshon.github.io/penny-finder-backend/briefings/latest.json';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = event.request.url;
  if (url.indexOf(BRIEFING) !== -1) {
    /* Briefing: always network, fall back to cache only if offline. */
    event.respondWith(
      fetch(event.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        return resp;
      }).catch(function () { return caches.match(event.request); })
    );
    return;
  }
  if (event.request.method === 'GET' && url.indexOf(self.location.origin) === 0) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
          return resp;
        });
      })
    );
  }
});
