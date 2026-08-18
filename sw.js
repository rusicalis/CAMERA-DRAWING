const CACHE='hook-mobile-v0.6.4';
const ASSETS=['./version.json','./','./index.html','./styles.css?v=0.6.4','./app.js?v=0.6.4','./manifest.json?v=0.6.4','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  e.respondWith(fetch(e.request).then(resp=>{
    if(resp && resp.ok && new URL(e.request.url).origin===location.origin){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));}
    return resp;
  }).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html'))));
});
