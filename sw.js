const CACHE='skytrace-v1';
const ASSETS=['/','/index.html','/manifest.webmanifest','/src/main.js','/src/style.css'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('fetch',e=>e.respondWith(fetch(e.request).catch(()=>caches.match(e.request))));
