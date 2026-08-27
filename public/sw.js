/**
 * Offline cache for the app shell and the 32 MB WebAssembly engine, so Pocket
 * Cut keeps working once it has been loaded even with no network at all.
 *
 * Nothing here talks to a server beyond re-fetching this app's own files.
 */
const VERSION = 'pocket-cut-v1';
const ENGINE_CACHE = `${VERSION}-engine`;
const APP_CACHE = `${VERSION}-app`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Range requests (media scrubbing) must reach the network untouched.
  if (req.headers.has('range')) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isEngine = url.pathname.includes('/ffmpeg/');

  event.respondWith(
    (async () => {
      const cache = await caches.open(isEngine ? ENGINE_CACHE : APP_CACHE);
      const hit = await cache.match(req);

      // The engine never changes for a given build: serve it straight from cache.
      if (hit && isEngine) return hit;

      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => null);

      // App shell: instant from cache, refreshed in the background.
      if (hit) {
        network.catch(() => {});
        return hit;
      }

      const res = await network;
      if (res) return res;
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('index.html', self.registration.scope).href);
        if (shell) return shell;
      }
      return new Response('Offline, and this file has not been cached yet.', { status: 504 });
    })(),
  );
});
