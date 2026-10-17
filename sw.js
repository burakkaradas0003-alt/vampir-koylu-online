// vk-v94: önbellek yok; eski önbellekleri temizler, her zaman ağdan yükler.
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil((async()=>{try{for(const k of await caches.keys())await caches.delete(k)}catch(_){}await self.clients.claim()})()));
