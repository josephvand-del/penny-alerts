/* Penny Alerts v15 service worker.
 * Caches the app shell so the app opens offline. The deal briefing JSON is
 * NEVER cached here — it is always fetched fresh (network-first) because
 * penny lists go stale fast. v3 adds background push: the 'push' event
 * shows the sender's summary notification, and tapping it opens the app.
 * v4: new cache name for the thumbnail layout change. v14: real PNG
 * icons in the shell (the push icon/badge), and a richer push
 * notification — deal names + prices from the payload, a View deals
 * action, and vibration. v15: cache bump for the Food tab + drawer. */
var CACHE = 'penny-alerts-v15';
var SHELL = ['index.html', 'styles.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png'];
var BRIEFING = 'rocketshon.github.io/penny-finder-backend/briefings/latest.json';
var WEEKLY = 'feed/weekly.json';

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
  if (url.indexOf(BRIEFING) !== -1 || url.indexOf(WEEKLY) !== -1) {
    /* Briefing + weekly feed: always network, fall back to cache only if
     * offline. Penny lists go stale fast — never serve a cached feed. */
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

/* Background push (v3, richer in v14). The sender posts {title, body,
 * url} — the title is "Penny Alerts: N new deals" and the body names
 * the top new deals with prices. The notification shows the real PNG
 * icon + badge, a View deals action, and a vibration pattern. Tapping
 * the notification or the View deals action opens (or focuses) the app
 * at the URL from the payload. */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'Penny Alerts: new deals';
  var body = data.body || 'Open the app to see them.';
  var url = data.url || './index.html';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'icon-512.png',
      badge: 'icon-192.png',
      tag: 'penny-alerts-new',
      vibrate: [200, 100, 200],
      actions: [{ action: 'open', title: 'View deals' }],
      data: { url: url }
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })
  );
});
