// Service worker d'Request : appli installable, page hors ligne, notifications push.
// Aucune réponse de l'API (/api) ni de l'appli n'est mise en cache : seule la page hors ligne l'est.

const CACHE = 'request-hors-ligne-v1';
const OFFLINE_PAGE = '/hors-ligne.html';
const ICON = '/icon-192.png';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_PAGE, ICON]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Navigation seulement : le réseau d'abord, la page hors ligne s'il ne répond pas. Le reste (API, scripts, images)
// n'est pas intercepté.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' || new URL(request.url).pathname.startsWith('/api')) return;
  event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_PAGE)));
});

// Charge utile envoyée par le serveur : { title, body, url } (url : chemin dans l'appli).
self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'Request', {
      body: message.body || '',
      icon: ICON,
      badge: ICON,
      lang: 'fr',
      data: { url: message.url || '/' },
    }),
  );
});

// Clic : l'onglet de l'appli déjà ouvert est mis au premier plan sur la bonne page, sinon une fenêtre s'ouvre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === target.origin);
      if (!open) return self.clients.openWindow(target.href);
      if (open.url === target.href) return open.focus();
      // `navigate` n'est permis que sur un onglet que ce service worker contrôle : sinon, une nouvelle fenêtre.
      return open
        .focus()
        .then((client) => client.navigate(target.href))
        .catch(() => self.clients.openWindow(target.href));
    }),
  );
});
