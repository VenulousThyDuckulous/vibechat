// Serves user-uploaded ROMs to the emulator.
//
// EmulatorJS only fetches games over http(s), so uploaded files are staged
// in Cache Storage and served back under a same-origin ./emu-rom/ URL.
// Narrow scope: never interferes with the FCM service worker.
self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  let path = "";
  try {
    path = new URL(event.request.url).pathname;
  } catch (e) {
    return;
  }
  if (!path.includes("/emu-rom/")) return;
  event.respondWith(
    caches.match(event.request).then((res) => res || new Response("ROM not found", { status: 404 }))
  );
});
