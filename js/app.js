// ============================================================
//  VibeChat — Main App Module
// ============================================================

import { auth, db, storage, ADMIN_UIDS, OWNER_USERNAMES } from "./firebase-config.js";
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
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// ============ STATE ============
let currentUser = null;
let currentRoom = null;
let currentRoomId = null;
let isAdmin = false;
let isOwner = false;
let isBanned = false;
let adminUids = new Set(ADMIN_UIDS);
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

function isOwnerName(name) {
  return OWNER_USERNAMES.some(o => o.toLowerCase() === (name || "").toLowerCase());
}

// Refresh the known admin UID list (hardcoded + DB-granted) for badges
async function refreshAdminList() {
  try {
    const snap = await get(ref(db, "admins"));
    const data = snap.val() || {};
    adminUids = new Set([...ADMIN_UIDS, ...Object.keys(data).filter(k => data[k] === true)]);
  } catch (err) {
    console.error("Admin list refresh failed:", err);
    adminUids = new Set(ADMIN_UIDS);
  }
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
      detachActiveListeners();
      if (presenceRef && currentUser) {
        try { remove(presenceRef); } catch (e) {}
      }
      presenceRef = null;
      typingRef = null;
      currentUser = null;
      isAdmin = false;
      isOwner = false;
      isBanned = false;
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
    const cred = await signInWithEmailAndPassword(auth, usernameToEmail(username), password);
    localStorage.setItem("vibechat-username", username);
    // Backfill profile if signup's DB write previously failed
    try {
      const snap = await get(ref(db, `users/${cred.user.uid}`));
      if (!snap.exists()) {
        await set(ref(db, `users/${cred.user.uid}`), {
          username: username,
          createdAt: serverTimestamp()
        });
      }
    } catch (dbErr) {
      console.error("Profile backfill failed:", dbErr);
    }
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
    localStorage.setItem("vibechat-username", username);
    // Store username in DB — don't block signup if this fails
    try {
      await set(ref(db, `users/${cred.user.uid}`), {
        username: username,
        createdAt: serverTimestamp()
      });
    } catch (dbErr) {
      console.error("Profile save failed:", dbErr);
      showError(`Account created but profile save failed (${dbErr.code || dbErr.message}). Check database rules/URL.`);
    }
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
  try {
    const snap = await get(ref(db, `users/${currentUser.uid}`));
    let username = snap.val()?.username;
    if (!username) {
      // Repair: profile missing (created while rules denied writes).
      // Fall back to the name saved on this device, or ask the user.
      username = localStorage.getItem("vibechat-username") || prompt("Pick your display name:");
      if (username) {
        try {
          await set(ref(db, `users/${currentUser.uid}`), {
            username: username,
            createdAt: serverTimestamp()
          });
          localStorage.setItem("vibechat-username", username);
        } catch (err) {
          console.error("Profile repair failed:", err);
        }
      } else {
        username = "user";
      }
    }
    $("current-username").textContent = username;
  } catch (err) {
    console.error("Profile load failed:", err);
    $("current-username").textContent = localStorage.getItem("vibechat-username") || "user";
    showToast(`Database read failed (${err.code || err.message}) — check rules/URL`, "error");
  }

  // Owners get full access too
  isOwner = isOwnerName($("current-username").textContent);
  if (isOwner) isAdmin = true;

  // Banned? (owners can't be banned)
  if (!isOwner) {
    try {
      const banSnap = await get(ref(db, `banned/${currentUser.uid}`));
      if (banSnap.exists()) {
        isBanned = true;
        await signOut(auth);
        showError("This account has been banned.");
        return;
      }
    } catch (err) {
      console.error("Ban check failed:", err);
    }
  }
  isBanned = false;

  // DB-backed admins — this is what the panel's Make Admin grants
  if (!isAdmin) {
    try {
      const adminSnap = await get(ref(db, `admins/${currentUser.uid}`));
      if (adminSnap.val() === true) isAdmin = true;
    } catch (err) {
      console.error("Admin check failed:", err);
    }
  }
  await refreshAdminList();

  // Live ban enforcement — get kicked even mid-session
  const myBanRef = ref(db, `banned/${currentUser.uid}`);
  const myBanCb = (snap) => {
    if (snap.exists() && !isOwner) {
      signOut(auth).then(() => showError("This account has been banned."));
    }
  };
  onValue(myBanRef, myBanCb);
  trackListener(myBanRef, "value", myBanCb);

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
  const list = $("room-list");
  if (list && !list.children.length) {
    list.innerHTML = '<p class="empty-state">No rooms yet — create one!</p>';
  }
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
  // Only the creator (or an admin) can close the room
  const canClose = currentUser.uid === data.createdBy || isAdmin;
  $("close-room-btn").classList.toggle("hidden", !canClose);
  showScreen("chat");
  watchRoomExists(roomId);
  setupPresence(roomId);
  loadMessages(roomId);
  setupTyping(roomId);
}

// If the room is deleted while we're inside, bounce back to lobby
function watchRoomExists(roomId) {
  const roomRef = ref(db, `rooms/${roomId}/name`);
  const cb = (snap) => {
    if (!snap.exists() && currentRoomId === roomId) {
      leaveRoom();
      showToast("This room was closed", "error");
    }
  };
  onValue(roomRef, cb);
  trackListener(roomRef, "value", cb);
}

function leaveRoom() {
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

  const isMsgAdmin = adminUids.has(msg.uid);
  const isMsgOwner = !isMsgAdmin && isOwnerName(msg.username);

  div.innerHTML = `
    <div class="message-header">
      <span class="message-username">${escapeHtml(msg.username)}</span>
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : isMsgOwner ? '<span class="message-admin-badge">OWNER</span>' : ""}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${linkify(msg.text || "")}${msg.imageUrl ? `<a href="${escapeHtml(msg.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(msg.imageUrl)}" class="message-image" loading="lazy" alt="shared image" /></a>` : ""}${msg.fileUrl ? `<a href="${escapeHtml(msg.fileUrl)}" target="_blank" rel="noopener" download="${escapeHtml(msg.fileName || "file")}" class="file-link">📎 ${escapeHtml(msg.fileName || "Download file")}</a>` : ""}</div>
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
    if (isBanned) {
      showToast("You are banned", "error");
      return;
    }
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

  // File/image attachments via Firebase Storage
  $("attach-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !currentRoomId) return;
    if (isBanned) {
      showToast("You are banned", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("File must be under 5MB", "error");
      return;
    }

    const sendBtn = $("send-btn");
    sendBtn.disabled = true;
    sendBtn.textContent = "Uploading…";
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const sRef = storageRef(storage, `chat-files/${currentRoomId}/${Date.now()}_${safeName}`);
      await uploadBytes(sRef, file);
      const url = await getDownloadURL(sRef);
      const isImage = file.type.startsWith("image/");
      const caption = $("message-input").value.trim();
      await push(ref(db, `rooms/${currentRoomId}/messages`), {
        uid: currentUser.uid,
        username: getUsername(),
        text: caption || (isImage ? "📷 Image" : `📎 ${file.name}`),
        ...(isImage ? { imageUrl: url } : { fileUrl: url, fileName: file.name }),
        timestamp: serverTimestamp()
      });
      $("message-input").value = "";
      if (typingRef) remove(typingRef);
    } catch (err) {
      console.error("Upload failed:", err);
      showToast("Upload failed — is Firebase Storage enabled?", "error");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
    }
  });
}

function showConfirmModal(title, bodyHtml, confirmText, onConfirm) {
  const overlay = $("modal-overlay");
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  const confirmBtn = $("modal-confirm");
  confirmBtn.textContent = confirmText;
  confirmBtn.onclick = () => {
    overlay.classList.add("hidden");
    onConfirm();
  };
  $("modal-cancel").onclick = () => overlay.classList.add("hidden");
  overlay.classList.remove("hidden");
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
  await refreshAdminList();
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
  const bannedSnap = await get(ref(db, "banned"));
  const banned = bannedSnap.val() || {};
  const userList = $("admin-user-list");
  userList.innerHTML = "";

  Object.entries(users).forEach(([id, data]) => {
    const item = document.createElement("div");
    item.className = "admin-item";
    const userIsAdmin = adminUids.has(id);
    const userIsOwner = isOwnerName(data.username);
    const userIsBanned = !!banned[id];
    const isSelf = id === currentUser.uid;

    const info = document.createElement("div");
    info.className = "admin-item-info";
    const badges = `${userIsOwner ? '<span class="message-admin-badge">OWNER</span>' : userIsAdmin ? '<span class="message-admin-badge">ADMIN</span>' : ""} ${userIsBanned ? '<span class="message-admin-badge">BANNED</span>' : ""}`;
    info.innerHTML = `<h5>${escapeHtml(data.username)} ${badges}</h5><p>UID: ${escapeHtml(id.slice(0, 12))}...</p>`;
    item.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "admin-item-actions";
    const addBtn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.className = `btn ${cls} btn-small`;
      b.textContent = label;
      b.addEventListener("click", fn);
      actions.appendChild(b);
    };
    // Owner-only powers: banning and managing admins. Admins can moderate content only.
    // Note: config-file admins (ADMIN_UIDS) can only be revoked by editing the code.
    if (isOwner && !userIsOwner && !isSelf) {
      if (!userIsBanned) addBtn("Ban", "btn-danger", () => window.__banUser(id, data.username));
      else addBtn("Unban", "btn-ghost", () => window.__unbanUser(id));
      if (ADMIN_UIDS.includes(id)) {
        const note = document.createElement("span");
        note.className = "admin-note";
        note.textContent = "Config admin";
        actions.appendChild(note);
      }
      else if (!userIsAdmin) addBtn("Make Admin", "btn-ghost", () => window.__toggleAdmin(id, true));
      else addBtn("Remove Admin", "btn-ghost", () => window.__toggleAdmin(id, false));
    }
    item.appendChild(actions);
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
  if (!isOwner) {
    showToast("Only the owner can manage admins", "error");
    return;
  }
  if (makeAdmin) {
    await set(ref(db, `admins/${uid}`), true);
    showToast("User is now admin");
  } else {
    await remove(ref(db, `admins/${uid}`));
    showToast("Admin removed");
  }
  loadAdminData();
};

window.__banUser = async (uid, username) => {
  if (!isOwner) {
    showToast("Only the owner can ban users", "error");
    return;
  }
  if (!confirm(`Ban ${username}? They will be signed out and blocked from coming back.`)) return;
  await set(ref(db, `banned/${uid}`), {
    username: username,
    bannedBy: getUsername(),
    bannedAt: serverTimestamp()
  });
  showToast(`${username} banned`);
  loadAdminData();
};

window.__unbanUser = async (uid) => {
  if (!isOwner) {
    showToast("Only the owner can unban users", "error");
    return;
  }
  await remove(ref(db, `banned/${uid}`));
  showToast("User unbanned");
  loadAdminData();
};

window.__deleteMessage = async (roomId, msgId) => {
  await remove(ref(db, `rooms/${roomId}/messages/${msgId}`));
  showToast("Message deleted");
  loadAdminData();
};

// ============ NAVIGATION ============
function initNavigation() {
  $("back-btn").addEventListener("click", leaveRoom);

  $("close-room-btn").addEventListener("click", () => {
    if (!currentRoomId) return;
    showConfirmModal(
      `Close "${currentRoom?.name}"?`,
      `<p style="color:var(--text-secondary)">This deletes the room and all its messages for everyone. This can't be undone.</p>`,
      "Delete Room",
      async () => {
        const roomId = currentRoomId;
        leaveRoom();
        await remove(ref(db, `rooms/${roomId}`));
        showToast("Room closed");
      }
    );
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
