// VibeChat service worker: push notifications + local ROM serving.
//
// ONE worker per scope: nested-scope workers can't intercept this page's
// fetches (only the controlling worker's scope applies), so FCM and the
// emulator ROM server live together here under /vibechat/.
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyABcRHJYvAV75pQAieSzL5vTBTD52r8kRM",
  projectId: "vibechat-a2d59",
  messagingSenderId: "1094675039349",
  appId: "1:1094675039349:web:64a3a3a22d46d93df2a43c"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "VibeChat";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, { body });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("https://venulousthyduckulous.github.io/vibechat/"));
});

// NOTE: bump the ?v= query in BOTH registration call sites
// (registerPushToken in app.js, ensureEmuSW in games.js) whenever this
// file changes — otherwise browsers may run a stale copy for up to 24h.
self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Serves user-uploaded ROMs staged by the page in Cache Storage under
// /emu-rom/*. EmulatorJS only fetches games over http(s).
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
