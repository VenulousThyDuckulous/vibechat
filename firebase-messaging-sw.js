// Firebase Cloud Messaging service worker — shows push notifications
// when the browser is closed/backgrounded. Queued by the notify workflow.
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
