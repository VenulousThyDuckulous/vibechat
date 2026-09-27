// Polls RTDB for undelivered mentions/announcements and sends FCM web push.
// Runs on GitHub Actions cron (free tier). Needs FIREBASE_SERVICE_ACCOUNT env.
import { GoogleAuth } from "google-auth-library";

const PROJECT_ID = "vibechat-a2d59";
const DB_URL = `https://${PROJECT_ID}-default-rtdb.firebaseio.com`;
const APP_URL = "https://venulousthyduckulous.github.io/vibechat/";
const MAX_SENDS = 50;

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
if (!svc.client_email) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT secret");
  process.exit(1);
}

const gauth = new GoogleAuth({
  credentials: svc,
  scopes: [
    "https://www.googleapis.com/auth/firebase.messaging",
    "https://www.googleapis.com/auth/firebase.database"
  ]
});
const accessToken = await (await gauth.getClient()).getAccessToken().then(t => t.token);

async function rtdb(path, method = "GET", body) {
  const res = await fetch(`${DB_URL}${path}.json?access_token=${accessToken}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`RTDB ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sendPush(token, title, body) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: (body || "").slice(0, 200) },
        webpush: { fcm_options: { link: APP_URL } }
      }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.details?.[0]?.errorCode || data?.error?.status || "error";
    console.error("FCM send failed:", res.status, code);
    return code;
  }
  return "ok";
}

function badToken(code) {
  return code === "UNREGISTERED" || code === "INVALID_ARGUMENT";
}

let sent = 0;
const [mentions, tokens, users, rooms, anns] = await Promise.all([
  rtdb("/mentions"), rtdb("/pushTokens"), rtdb("/users"), rtdb("/rooms"), rtdb("/announcements/messages")
]);

// 1. Direct mentions (incl. announcement pings, stored under roomId "announcements")
for (const [uid, roomMap] of Object.entries(mentions || {})) {
  const userTokens = Object.entries(tokens?.[uid] || {});
  for (const [roomId, msgs] of Object.entries(roomMap || {})) {
    for (const [msgId, m] of Object.entries(msgs || {})) {
      if (!m || m.sent || sent >= MAX_SENDS) continue;
      if (users?.[uid]?.notifyEnabled !== false && userTokens.length) {
        const roomName = roomId === "announcements" ? "Announcements" : (rooms?.[roomId]?.name || "a room");
        const title = roomId === "announcements" ? "📢 Announcement" : "🔔 You were mentioned";
        const body = `${m.by || "Someone"} in ${roomName}: ${m.text || ""}`;
        for (const [tokId, t] of userTokens) {
          if (sent >= MAX_SENDS || !t?.token) break;
          const r = await sendPush(t.token, title, body);
          sent++;
          if (badToken(r)) await rtdb(`/pushTokens/${uid}/${tokId}`, "DELETE").catch(() => {});
        }
      }
      await rtdb(`/mentions/${uid}/${roomId}/${msgId}/sent`, "PUT", true).catch(() => {});
    }
  }
}

// 2. Announcements → everyone with a token (except the author, unless muted)
for (const [msgId, m] of Object.entries(anns || {})) {
  if (!m || m.annSent || sent >= MAX_SENDS) continue;
  for (const [uid, tokMap] of Object.entries(tokens || {})) {
    if (uid === m.uid || users?.[uid]?.notifyEnabled === false) continue;
    for (const [tokId, t] of Object.entries(tokMap || {})) {
      if (sent >= MAX_SENDS || !t?.token) break;
      const r = await sendPush(t.token, "📢 New announcement", `${m.username || "Owner"}: ${(m.text || "").slice(0, 150)}`);
      sent++;
      if (badToken(r)) await rtdb(`/pushTokens/${uid}/${tokId}`, "DELETE").catch(() => {});
    }
  }
  await rtdb(`/announcements/messages/${msgId}/annSent`, "PUT", true).catch(() => {});
}

console.log(`done, sent=${sent}`);
