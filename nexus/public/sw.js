/* NEXUS — офлайн-оболочка. API не кэшируем: данные должны быть живыми. */

const CACHE = 'nexus-shell-v3';
const SHELL = [
  './',
  './index.html',
  './icon.svg',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/store.js',
  './js/ui.js',
  './js/console.js',
  './js/palette.js',
  './js/view-control.js',
  './js/view-main.js',
  './js/view-kb.js',
  './js/view-constructor.js',
  './js/view-settings.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      /* addAll падает целиком при любой ошибке — кэшируем по одному */
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* Живые данные: /api, /data и потоки прогонов в кэш не попадают */
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) return;

  /* Навигация: сначала сеть, при отсутствии — оболочка из кэша */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  /* Статика: сначала кэш, параллельно обновляем */
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    }),
  );
});