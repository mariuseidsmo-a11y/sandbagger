/* Sandbagger service worker — gjør appen installerbar + offline-tålig.
   Bump CACHE-versjonen når du vil tvinge ny app-shell-cache. */
const CACHE = 'sandbagger-v2';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/bg/splash.jpeg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Bare same-origin GET caches. AI-proxy og rom-synk (kryss-origin / POST)
  // skal alltid gå rett til nettet — aldri caches.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // App-dokumentet: network-first så brukeren alltid får siste versjon når
  // online, men faller tilbake til cache (offline-støtte).
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
    );
    return;
  }

  // Statiske ressurser (ikoner, manifest): cache-first.
  e.respondWith(
    caches.match(req).then((m) =>
      m || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
    )
  );
});
