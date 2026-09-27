// ============================================================
//  VibeChat — Main App Module
// ============================================================

import { auth, db, ADMIN_UIDS } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  ref,
  push,
  set,
  get,
  onValue,
  onChildAdded,
  onChildRemoved,
  onChildChanged,
  onDisconnect,
  remove,
  update,
  serverTimestamp,
  query,
  orderByChild,
  limitToLast,
  off
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============ STATE ============
let currentUser = null;
let currentRoom = null;
let currentRoomId = null;
let isAdmin = false;
let presenceRef = null;
let typingRef = null;
let messageListeners = [];
let roomListeners = [];
let activeListeners = [];

function trackListener(r, event, cb) {
  activeListeners.push({ ref: r, event, cb });
}

function detachActiveListeners() {
  activeListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  activeListeners = [];
  messageListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  messageListeners = [];
}

// ============ DOM REFS ============
const $ = (id) => document.getElementById(id);

const screens = {
  auth: $("auth-screen"),
  lobby: $("lobby-screen"),
  chat: $("chat-screen"),
  admin: $("admin-screen")
};

// ============ UTILITIES ============
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function showToast(msg, type = "success") {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function showError(msg) {
  $("auth-error").textContent = msg;
}

function clearError() {
  $("auth-error").textContent = "";
}

function usernameToEmail(username) {
  return `${username.toLowerCase().replace(/[^a-z0-9]/g, "")}@vibechat.app`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escapeHtml(text).replace(urlRegex, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ============ AUTH ============
function initAuth() {
  // Tab switching
  $("tab-login").addEventListener("click", () => switchAuthTab("login"));
  $("tab-signup").addEventListener("click", () => switchAuthTab("signup"));

  // Forms
  $("login-form").addEventListener("submit", handleLogin);
  $("signup-form").addEventListener("submit", handleSignup);

  // Auth state
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      isAdmin = ADMIN_UIDS.includes(user.uid);
      loadUserProfile();
    } else {
      currentUser = null;
      isAdmin = false;
      currentRoom = null;
      currentRoomId = null;
      showScreen("auth");
    }
  });
}

function switchAuthTab(tab) {
  $("tab-login").classList.toggle("active", tab === "login");
  $("tab-signup").classList.toggle("active", tab === "signup");
  $("login-form").classList.toggle("hidden", tab !== "login");
  $("signup-form").classList.toggle("hidden", tab !== "signup");
  clearError();
}

async function handleLogin(e) {
  e.preventDefault();
  clearError();
  const username = $("login-username").value.trim();
  const password = $("login-password").value;

  try {
    await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
  } catch (err) {
    console.error("Login failed:", err);
    showError(getAuthErrorMessage(err.code) + (err.code ? ` (${err.code})` : ""));
  }
}

async function handleSignup(e) {
  e.preventDefault();
  clearError();
  const username = $("signup-username").value.trim();
  const password = $("signup-password").value;
  const password2 = $("signup-password2").value;

  if (password !== password2) {
    showError("Passwords don't match");
    return;
  }

  try {
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    // Store username in DB
    await set(ref(db, `users/${cred.user.uid}`), {
      username: username,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.error("Signup failed:", err);
    showError(getAuthErrorMessage(err.code) + (err.code ? ` (${err.code})` : ""));
  }
}

function getAuthErrorMessage(code) {
  const messages = {
    "auth/user-not-found": "No account found with that username",
    "auth/wrong-password": "Incorrect password",
    "auth/invalid-credential": "Wrong username or password",
    "auth/invalid-login-credentials": "Wrong username or password",
    "auth/email-already-in-use": "That username is taken",
    "auth/weak-password": "Password must be at least 6 characters",
    "auth/invalid-email": "Invalid username format",
    "auth/operation-not-allowed": "Email/password login is not enabled in Firebase Console",
    "auth/api-key-not-valid": "Firebase API key is invalid — check firebase-config.js",
    "auth/network-request-failed": "Network error — check your connection",
    "auth/too-many-requests": "Too many attempts. Try again later."
  };
  return messages[code] || `Something went wrong${code ? ": " + code : ""}. Try again.`;
}

async function loadUserProfile() {
  const snap = await get(ref(db, `users/${currentUser.uid}`));
  const data = snap.val();
  const username = data?.username || "user";
  $("current-username").textContent = username;

  // Show admin button if admin
  $("admin-btn").classList.toggle("hidden", !isAdmin);

  showScreen("lobby");
  loadRooms();
}

$("logout-btn").addEventListener("click", async () => {
  await signOut(auth);
});

// ============ ROOMS ============
function loadRooms() {
  // Clear existing listeners
  roomListeners.forEach(({ ref: r, event, cb }) => off(r, event, cb));
  roomListeners = [];

  // Clear list to avoid duplicates on re-entry
  $("room-list").innerHTML = '<p class="empty-state">No rooms yet — create one!</p>';

  const roomsRef = ref(db, "rooms");
  const addedCb = (snap) => {
    const room = snap.key;
    const data = snap.val();
    addRoomToList(room, data);
  };
  const removedCb = (snap) => {
    removeRoomFromList(snap.key);
  };

  onChildAdded(roomsRef, addedCb);
  onChildRemoved(roomsRef, removedCb);
  roomListeners.push({ ref: roomsRef, event: "child_added", cb: addedCb });
  roomListeners.push({ ref: roomsRef, event: "child_removed", cb: removedCb });
}

function addRoomToList(roomId, data) {
  const list = $("room-list");
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();

  const card = document.createElement("div");
  card.className = "room-card";
  card.dataset.roomId = roomId;
  card.innerHTML = `
    <div class="room-card-info">
      <h4>${escapeHtml(data.name)}</h4>
      <p>${data.isPrivate ? "🔒 Private" : "🌍 Public"} · ${data.memberCount || 0} members</p>
    </div>
    <span class="room-card-badge ${data.isPrivate ? "private" : ""}">${data.isPrivate ? "🔒" : "🌍"}</span>
  `;
  card.addEventListener("click", () => handleJoinRoom(roomId, data));
  list.appendChild(card);
}

function removeRoomFromList(roomId) {
  const card = document.querySelector(`[data-room-id="${roomId}"]`);
  if (card) card.remove();
}

function handleJoinRoom(roomId, data) {
  if (data.isPrivate) {
    showPasswordModal(roomId, data);
  } else {
    joinRoom(roomId, data);
  }
}

function showPasswordModal(roomId, data) {
  const overlay = $("modal-overlay");
  $("modal-title").textContent = `Join "${data.name}"`;
  $("modal-body").innerHTML = `
    <p style="margin-bottom:12px;color:var(--text-secondary)">This room is password-protected.</p>
    <input type="password" id="room-password-input" placeholder="Room password" style="width:100%" />
  `;
  overlay.classList.remove("hidden");

  $("modal-confirm").onclick = async () => {
    const pw = $("room-password-input").value;
    // Simple hash comparison (in production, use a proper auth flow)
    const hashed = await simpleHash(pw);
    if (hashed === data.passwordHash) {
      overlay.classList.add("hidden");
      joinRoom(roomId, data);
    } else {
      showToast("Wrong room password", "error");
    }
  };
  $("modal-cancel").onclick = () => overlay.classList.add("hidden");
}

async function simpleHash(str) {
  // Simple hash for room passwords (not for auth — that's Firebase's job)
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function joinRoom(roomId, data) {
  detachActiveListeners();
  currentRoomId = roomId;
  currentRoom = data;
  $("chat-room-name").textContent = data.name;
  showScreen("chat");
  setupPresence(roomId);
  loadMessages(roomId);
  setupTyping(roomId);
}

function setupPresence(roomId) {
  // Remove old presence
  if (presenceRef) {
    remove(presenceRef);
    presenceRef = null;
  }

  presenceRef = ref(db, `rooms/${roomId}/presence/${currentUser.uid}`);
  set(presenceRef, {
    username: getUsername(),
    online: true,
    lastSeen: serverTimestamp()
  });

  // Auto-remove on disconnect
  onDisconnect(presenceRef).remove();

  // Listen for presence changes
  const presenceListRef = ref(db, `rooms/${roomId}/presence`);
  const presenceCb = (snap) => {
    const users = snap.val() || {};
    const list = $("online-list");
    list.innerHTML = "";
    const count = Object.keys(users).length;
    $("online-count").textContent = count;

    Object.values(users).forEach(u => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="online-dot"></span> ${escapeHtml(u.username)}`;
      list.appendChild(li);
    });
  };
  onValue(presenceListRef, presenceCb);
  trackListener(presenceListRef, "value", presenceCb);
}

function getUsername() {
  return $("current-username").textContent || "user";
}

function loadMessages(roomId) {
  // Clear old message listeners
  detachActiveListeners();

  const messagesRef = query(
    ref(db, `rooms/${roomId}/messages`),
    orderByChild("timestamp"),
    limitToLast(100)
  );

  const container = $("messages");
  container.innerHTML = "";

  const addedCb = (snap) => {
    const msg = snap.val();
    const msgId = snap.key;
    appendMessage(msgId, msg);
  };

  onChildAdded(messagesRef, addedCb);
  trackListener(messagesRef, "child_added", addedCb);
}

function appendMessage(msgId, msg) {
  const container = $("messages");
  const isOwn = msg.uid === currentUser.uid;
  const div = document.createElement("div");
  div.className = `message ${isOwn ? "own" : "other"}`;
  div.dataset.msgId = msgId;

  const isMsgAdmin = ADMIN_UIDS.includes(msg.uid);

  div.innerHTML = `
    <div class="message-header">
      <span class="message-username">${escapeHtml(msg.username)}</span>
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : ""}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${linkify(msg.text)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function setupTyping(roomId) {
  typingRef = ref(db, `rooms/${roomId}/typing/${currentUser.uid}`);
  const input = $("message-input");

  input.oninput = () => {
    if (input.value.trim()) {
      set(typingRef, { username: getUsername(), typing: true });
    } else {
      remove(typingRef);
    }
  };

  // Listen for typing
  const typingRef2 = ref(db, `rooms/${roomId}/typing`);
  const typingCb = (snap) => {
    const typing = snap.val() || {};
    const indicator = $("typing-indicator");
    const names = Object.values(typing)
      .filter(t => t.username !== getUsername())
      .map(t => t.username);

    if (names.length > 0) {
      indicator.textContent = `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing...`;
      indicator.classList.remove("hidden");
    } else {
      indicator.classList.add("hidden");
    }
  };
  onValue(typingRef2, typingCb);
  trackListener(typingRef2, "value", typingCb);
}

// ============ MESSAGES ============
function initChat() {
  $("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("message-input");
    const text = input.value.trim();
    if (!text || !currentRoomId) return;

    const messagesRef = ref(db, `rooms/${currentRoomId}/messages`);
    await push(messagesRef, {
      uid: currentUser.uid,
      username: getUsername(),
      text: text,
      timestamp: serverTimestamp()
    });

    input.value = "";
    if (typingRef) remove(typingRef);
  });

  // Emoji picker
  $("emoji-btn").addEventListener("click", toggleEmojiPicker);
}

function toggleEmojiPicker() {
  let picker = document.querySelector(".emoji-picker");
  if (picker) {
    picker.classList.toggle("hidden");
    return;
  }

  picker = document.createElement("div");
  picker.className = "emoji-picker";
  const emojis = ["😀","😂","🥰","😎","🤔","😅","😭","😤","🥺","😴","🤯","🥳","😇","🙃","😉","👍","👎","👏","🙌","💪","🔥","✨","💯","🎉","❤️","💜","💙","💚","💛","🧡","💔","⭐","🌟","⚡","🌈","☀️","🌙","🍕","🍔","☕","🎵","🎮","🏆","💎","🚀","👋","🤝","✅","❌","⚠️","💡","📌","🔒","🔑","🛡️","👑","🎯","📝","🔔","⏰","📊","🌍","🏠","💬","🗑️","📎","🖼️","🎬","📺","🎧","🎤","🎸","🎹","🎲","🎰","🎳","🏀","⚽","🏈","⚾","🎾","🏐","🏓","🥊","🏋️","🚴","🏊","🏄","🧗","🎿","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎗️","🎫","🎟️","🎪","🤹","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟️","🎯","🎳","🎮","🎰","🧩","🧸","🪀","🪁","🔮","🪄","🧿","💈","🔭","🔬","🕳️","💊","💉","🩸","🧬","🦠","🧫","🧪","🌡️","🧹","🧺","🧻","🚽","🚰","🚿","🛁","🛀","🧼","🪒","🧽","🧴","🛎️","🔑","🗝️","🚪","🪑","🛋️","🛏️","🧸","🖼️","🛍️","🛒","🎁","🎈","🎏","🎀","🎊","🎉","🎎","🏮","🎐","🧧","✉️","📩","📨","📧","💌","📥","📤","📦","🏷️","📪","📫","📬","📭","📮","📯","📜","📃","📄","📑","🧾","📊","📈","📉","🗒️","🗓️","📆","📅","🗑️","📇","🗃️","🗳️","🗄️","📋","📁","📂","🗂️","🗞️","📰","📓","📔","📒","📕","📗","📘","📙","📚","📖","🔖","🧷","🔗","📎","🖇️","📐","📏","🧮","📌","📍","✂️","🖊️","🖋️","✒️","🖌️","🖍️","📝","✏️","🔍","🔎","🔏","🔐","🔒","🔓"];

  emojis.forEach(e => {
    const btn = document.createElement("button");
    btn.textContent = e;
    btn.addEventListener("click", () => {
      $("message-input").value += e;
      $("message-input").focus();
    });
    picker.appendChild(btn);
  });

  document.querySelector(".chat-main").appendChild(picker);
}

// ============ CREATE ROOM ============
function initCreateRoom() {
  // Toggle password input
  document.querySelectorAll('input[name="room-type"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      $("room-password").classList.toggle("hidden", e.target.value !== "private");
    });
  });

  $("create-room-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("room-name").value.trim();
    const type = document.querySelector('input[name="room-type"]:checked').value;
    const password = $("room-password").value;

    if (!name) return;

    const roomRef = ref(db, "rooms");
    const newRoomRef = push(roomRef);

    const roomData = {
      name: name,
      createdBy: currentUser.uid,
      createdByName: getUsername(),
      createdAt: serverTimestamp(),
      isPrivate: type === "private",
      passwordHash: type === "private" ? await simpleHash(password) : null,
      memberCount: 1
    };

    await set(newRoomRef, roomData);

    // Add creator as member
    await set(ref(db, `rooms/${newRoomRef.key}/members/${currentUser.uid}`), {
      username: getUsername(),
      joinedAt: serverTimestamp()
    });

    $("room-name").value = "";
    $("room-password").value = "";
    showToast(`Room "${name}" created!`);
  });
}

// ============ ADMIN PANEL ============
function initAdmin() {
  $("admin-btn").addEventListener("click", () => {
    showScreen("admin");
    loadAdminData();
  });

  $("admin-back-btn").addEventListener("click", () => {
    showScreen("lobby");
  });
}

async function loadAdminData() {
  // Load all rooms
  const roomsSnap = await get(ref(db, "rooms"));
  const rooms = roomsSnap.val() || {};
  const roomList = $("admin-room-list");
  roomList.innerHTML = "";

  Object.entries(rooms).forEach(([id, data]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `
      <div class="admin-item-info">
        <h5>${escapeHtml(data.name)}</h5>
        <p>By ${escapeHtml(data.createdByName || "unknown")} · ${data.isPrivate ? "🔒 Private" : "🌍 Public"} · ${data.memberCount || 0} members</p>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-ghost btn-small" onclick="window.__viewRoom('${id}')">View</button>
        <button class="btn btn-danger btn-small" onclick="window.__deleteRoom('${id}')">Delete</button>
      </div>
    `;
    roomList.appendChild(item);
  });

  // Load all users
  const usersSnap = await get(ref(db, "users"));
  const users = usersSnap.val() || {};
  const userList = $("admin-user-list");
  userList.innerHTML = "";

  Object.entries(users).forEach(([id, data]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    const userIsAdmin = ADMIN_UIDS.includes(id);
    item.innerHTML = `
      <div class="admin-item-info">
        <h5>${escapeHtml(data.username)} ${userIsAdmin ? '<span class="message-admin-badge">ADMIN</span>' : ""}</h5>
        <p>UID: ${id.slice(0, 12)}...</p>
      </div>
      <div class="admin-item-actions">
        ${!userIsAdmin ? `<button class="btn btn-ghost btn-small" onclick="window.__toggleAdmin('${id}', true)">Make Admin</button>` : `<button class="btn btn-ghost btn-small" onclick="window.__toggleAdmin('${id}', false)">Remove Admin</button>`}
      </div>
    `;
    userList.appendChild(item);
  });

  // Load recent messages
  const messagesSnap = await get(ref(db, "rooms"));
  const allRooms = messagesSnap.val() || {};
  const msgList = $("admin-message-list");
  msgList.innerHTML = "";

  for (const [roomId, roomData] of Object.entries(allRooms)) {
    const msgsSnap = await get(query(ref(db, `rooms/${roomId}/messages`), limitToLast(5)));
    const msgs = msgsSnap.val() || {};
    Object.entries(msgs).forEach(([msgId, msg]) => {
      const item = document.createElement("div");
      item.className = "admin-item";
      item.innerHTML = `
        <div class="admin-item-info">
          <h5>${escapeHtml(msg.username)} in ${escapeHtml(roomData.name)}</h5>
          <p>${escapeHtml(msg.text)}</p>
        </div>
        <div class="admin-item-actions">
          <button class="btn btn-danger btn-small" onclick="window.__deleteMessage('${roomId}', '${msgId}')">Delete</button>
        </div>
      `;
      msgList.appendChild(item);
    });
  }
}

// Expose admin functions globally
window.__viewRoom = (roomId) => {
  showToast(`Viewing room ${roomId} — implement as needed`);
};

window.__deleteRoom = async (roomId) => {
  if (!confirm("Delete this room and all its messages?")) return;
  await remove(ref(db, `rooms/${roomId}`));
  showToast("Room deleted");
  loadAdminData();
};

window.__toggleAdmin = async (uid, makeAdmin) => {
  const adminsRef = ref(db, "admins");
  if (makeAdmin) {
    await set(ref(db, `admins/${uid}`), true);
    showToast("User is now admin");
  } else {
    await remove(ref(db, `admins/${uid}`));
    showToast("Admin removed");
  }
  loadAdminData();
};

window.__deleteMessage = async (roomId, msgId) => {
  await remove(ref(db, `rooms/${roomId}/messages/${msgId}`));
  showToast("Message deleted");
  loadAdminData();
};

// ============ NAVIGATION ============
function initNavigation() {
  $("back-btn").addEventListener("click", () => {
    detachActiveListeners();
    if (presenceRef) {
      remove(presenceRef);
      presenceRef = null;
    }
    if (typingRef) {
      remove(typingRef);
      typingRef = null;
    }
    currentRoom = null;
    currentRoomId = null;
    $("messages").innerHTML = "";
    showScreen("lobby");
    loadRooms();
  });
}

// ============ INIT ============
document.addEventListener("DOMContentLoaded", () => {
  initAuth();
  initChat();
  initCreateRoom();
  initAdmin();
  initNavigation();
});
