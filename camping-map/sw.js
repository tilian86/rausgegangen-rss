/* Service Worker: macht die Karte offline nutzbar.
   Eigene Dateien werden gecacht, GPS funktioniert ohne Netz sowieso.

   Programmdateien holt er zuerst aus dem Netz (mit kurzem Zeitlimit), damit
   Korrekturen sofort ankommen statt erst beim übernächsten Start. Alles
   Schwere und Unveränderliche – Lageplan, Symbole, pdf.js – kommt zuerst aus
   dem Cache. */

const CACHE = 'campmap-v3';
const NET_TIMEOUT_MS = 3500;
const ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isProgramFile(url) {
  return /(^|\/)(index\.html|app\.js|app\.css|manifest\.webmanifest)$/.test(url.pathname)
      || url.pathname.endsWith('/');
}

async function put(req, res) {
  if (res && res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('langsam')), NET_TIMEOUT_MS))
    ]);
    return await put(req, res);
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const fallback = await caches.match('index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req, { ignoreSearch: true });
  if (cached) return cached;
  return put(req, await fetch(req));
}

self.addEventListener('fetch', ev => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  ev.respondWith(
    (req.mode === 'navigate' || isProgramFile(url)) ? networkFirst(req) : cacheFirst(req)
  );
});
