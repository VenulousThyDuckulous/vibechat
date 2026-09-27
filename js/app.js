// ============================================================
//  VibeChat — Main App Module
// ============================================================

import { auth, db, ADMIN_UIDS, OWNER_USERNAMES } from "./firebase-config.js";
import { initGames, closeGame } from "./games.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
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
console.log("VibeChat build: avatars-1");
let currentUser = null;
let currentRoom = null;
let currentRoomId = null;
let isAdmin = false;
let isOwner = false;
let isBanned = false;
let adminUids = new Set(ADMIN_UIDS);
let userCache = {};
let mentionCounts = {};
let currentPresence = {};
let mentionMenuState = { open: false, items: [], highlight: 0 };
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
  admin: $("admin-screen"),
  games: $("games-screen")
};

// ============ UTILITIES ============
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function showToast(msg, type = "success", ms = 3000) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add("hidden"), ms);
}

function showError(msg) {
  $("auth-error").textContent = msg;
}

function clearError() {
  $("auth-error").textContent = "";
}

function usernameToEmail(username) {
  return `${normalizeName(username)}@vibechat.app`;
}

function normalizeName(username) {
  return (username || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Display names live in users/{uid} + usernames/{key}; the Auth email
// (built from the ORIGINAL signup name) never changes, so renames are
// database-only and can't hit Firebase's email-change restrictions.
async function ensureUsernameIndex(key, uid) {
  if (!key) return;
  try {
    const snap = await get(ref(db, `usernames/${key}`));
    const hit = snap.val();
    const owner = typeof hit === "string" ? hit : hit?.uid;
    if (!snap.exists() || owner === uid) {
      await set(ref(db, `usernames/${key}`), uid);
    } else {
      console.warn("Username index collision, skipping:", key);
    }
  } catch (err) {
    console.error("Username index backfill failed:", err);
  }
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

// Refresh the uid -> { username, photoURL } cache for avatars
async function refreshUserCache() {
  try {
    const snap = await get(ref(db, "users"));
    userCache = snap.val() || {};
  } catch (err) {
    console.error("User cache refresh failed:", err);
  }
}

function avatarHue(name) {
  let h = 0;
  for (const c of (name || "?")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function avatarInner(name, photo) {
  if (photo) return `<img src="${escapeHtml(photo)}" alt="" />`;
  const initial = ((name || "?").trim().charAt(0) || "?").toUpperCase();
  return `<span class="avatar-initial" style="background:hsl(${avatarHue(name)},45%,45%)">${escapeHtml(initial)}</span>`;
}

function paintAvatars(uid) {
  const profile = userCache[uid] || {};
  document.querySelectorAll(`.avatar[data-uid="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(el.dataset.name || profile.username || "?", profile.photoURL);
  });
}

function paintHeaderAvatar() {
  const el = $("header-avatar");
  if (!el || !currentUser) return;
  el.dataset.uid = currentUser.uid;
  el.dataset.name = getUsername();
  el.innerHTML = avatarInner(getUsername(), (userCache[currentUser.uid] || {}).photoURL);
}

// Downscale an image file to a small square JPEG data URL (no Storage needed)
function processAvatar(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const size = 128;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const side = Math.min(img.width, img.height);
      canvas.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read image"));
    };
    img.src = objectUrl;
  });
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

const URL_RE = /(https?:\/\/[^\s<]+)/g;
const MENTION_RE = /@([A-Za-z0-9_][A-Za-z0-9_ |.\-]{2,19})/g;

function findUserByName(name) {
  const want = (name || "").trim().toLowerCase().replace(/[ .|\-]+$/, "");
  if (!want) return null;
  for (const [uid, u] of Object.entries(userCache)) {
    if ((u.username || "").toLowerCase() === want) return { uid, username: u.username };
  }
  return null;
}

function extractMentionedUids(text) {
  const uids = new Set();
  (text || "").replace(MENTION_RE, (m, name) => {
    const hit = findUserByName(name);
    if (hit && currentUser && hit.uid !== currentUser.uid) uids.add(hit.uid);
    return m;
  });
  return [...uids];
}

function messageMentionsMe(text) {
  const myName = getUsername().toLowerCase();
  let found = false;
  (text || "").replace(MENTION_RE, (m, name) => {
    const hit = findUserByName(name);
    if (hit && hit.username.toLowerCase() === myName) found = true;
    return m;
  });
  return found;
}

function renderMessageText(raw) {
  const esc = escapeHtml(raw || "");
  const urls = [];
  const noUrls = esc.replace(URL_RE, (m) => {
    urls.push(m);
    return `\u0000${urls.length - 1}\u0000`;
  });
  const myName = getUsername().toLowerCase();
  const withMentions = noUrls.replace(MENTION_RE, (m, name) => {
    const hit = findUserByName(name);
    if (!hit) return m;
    const me = hit.username.toLowerCase() === myName;
    return `<span class="mention${me ? " me" : ""}">@${escapeHtml(hit.username)}</span>`;
  });
  return withMentions.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const u = urls[+i];
    return `<a href="${u}" target="_blank" rel="noopener">${u}</a>`;
  });
}

// ============ MENTION AUTOCOMPLETE MENU ============
function getMentionQuery() {
  const input = $("message-input");
  if (!input) return null;
  const uptoCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
  const m = /(?:^|\s)@([A-Za-z0-9_ |.\-]*)$/.exec(uptoCaret);
  if (!m) return null;
  return { query: m[1], start: uptoCaret.length - m[1].length - 1 };
}

function hideMentionMenu() {
  mentionMenuState.open = false;
  $("mention-menu").classList.add("hidden");
}

function setMentionHighlight(i) {
  mentionMenuState.highlight = i;
  document.querySelectorAll("#mention-menu .mention-row").forEach((row, j) => {
    row.classList.toggle("selected", j === i);
    if (j === i) row.scrollIntoView({ block: "nearest" });
  });
}

function updateMentionMenu() {
  const menu = $("mention-menu");
  const q = currentRoomId && currentUser ? getMentionQuery() : null;
  if (!q) {
    hideMentionMenu();
    return;
  }
  const query = q.query.toLowerCase();
  const onlineItems = Object.entries(currentPresence)
    .filter(([uid, u]) => uid !== currentUser.uid && (u.username || "").toLowerCase().includes(query))
    .map(([uid, u]) => ({ uid, username: u.username, online: true }));
  const seen = new Set(onlineItems.map(i => i.uid));
  seen.add(currentUser.uid);
  const otherItems = Object.entries(userCache)
    .filter(([uid, u]) => !seen.has(uid) && (u.username || "").toLowerCase().includes(query))
    .map(([uid, u]) => ({ uid, username: u.username, online: false }));
  const items = [...onlineItems, ...otherItems].slice(0, 8);
  mentionMenuState = { open: true, items, highlight: 0 };
  menu.innerHTML = "<h4>Members</h4>";
  if (!items.length) {
    menu.innerHTML += '<p class="mention-empty">No matches</p>';
  } else {
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-row" + (i === 0 ? " selected" : "") + (item.online ? "" : " offline");
      const photo = (userCache[item.uid] || {}).photoURL;
      row.innerHTML = `<span class="avatar" data-uid="${escapeHtml(item.uid)}" data-name="${escapeHtml(item.username)}">${avatarInner(item.username, photo)}</span> ${escapeHtml(item.username)}`;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        completeMention(item.username);
      });
      row.addEventListener("mouseenter", () => setMentionHighlight(i));
      menu.appendChild(row);
    });
  }
  menu.classList.remove("hidden");
}

function completeMention(username) {
  const input = $("message-input");
  const q = getMentionQuery();
  hideMentionMenu();
  if (!q) return;
  const before = input.value.slice(0, q.start);
  const after = input.value.slice(input.selectionStart ?? input.value.length);
  const insert = `@${username} `;
  input.value = before + insert + after;
  const pos = before.length + insert.length;
  input.setSelectionRange(pos, pos);
  input.focus();
}

function mentionMenuKey(e) {
  if (!mentionMenuState.open) return;
  const items = mentionMenuState.items;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length) setMentionHighlight((mentionMenuState.highlight + 1) % items.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length) setMentionHighlight((mentionMenuState.highlight - 1 + items.length) % items.length);
  } else if (e.key === "Enter" || e.key === "Tab") {
    if (items.length) {
      e.preventDefault();
      completeMention(items[mentionMenuState.highlight].username);
    } else {
      hideMentionMenu();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    hideMentionMenu();
  }
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
  if (!username) {
    showError("Enter your username");
    return;
  }

  let user = null;
  try {
    try {
      // Usual path: typed name maps directly to the login email
      // (original signup name, or pre-rename account).
      user = (await signInWithEmailAndPassword(auth, usernameToEmail(username), password)).user;
      localStorage.setItem("vibechat-username", username);
    } catch (legacyErr) {
      if (!["auth/invalid-credential", "auth/invalid-login-credentials", "auth/user-not-found", "auth/wrong-password"].includes(legacyErr.code)) throw legacyErr;
      // Maybe a renamed display name — resolve via the username index.
      const key = normalizeName(username);
      if (!key) throw legacyErr;
      const idxSnap = await get(ref(db, `usernames/${key}`));
      const hit = idxSnap.val();
      const uid = typeof hit === "string" ? hit : hit?.uid;
      const profSnap = uid ? await get(ref(db, `users/${uid}`)) : null;
      const login = profSnap?.val()?.login;
      if (!uid || !login) throw legacyErr;
      user = (await signInWithEmailAndPassword(auth, `${login}@vibechat.app`, password)).user;
      localStorage.setItem("vibechat-username", profSnap.val()?.username || username);
    }
    // Backfill profile + index if signup's DB writes previously failed
    try {
      const profRef = ref(db, `users/${user.uid}`);
      const snap = await get(profRef);
      const cur = snap.val() || {};
      const storedName = cur.username || localStorage.getItem("vibechat-username") || username;
      await update(profRef, {
        username: storedName,
        login: cur.login || normalizeName(username),
        ...(cur.createdAt ? {} : { createdAt: serverTimestamp() })
      });
      await ensureUsernameIndex(normalizeName(storedName), user.uid);
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

  if (username.length < 3 || username.length > 20) {
    showError("Username must be 3–20 characters");
    return;
  }
  const key = normalizeName(username);
  if (!key) {
    showError("Username needs at least one letter or number");
    return;
  }

  try {
    const taken = await get(ref(db, `usernames/${key}`));
    if (taken.exists()) {
      showError("That username is taken");
      return;
    }
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(username), password);
    localStorage.setItem("vibechat-username", username);
    // Store username in DB — don't block signup if this fails
    try {
      await set(ref(db, `users/${cred.user.uid}`), {
        username: username,
        login: key,
        createdAt: serverTimestamp()
      });
      await set(ref(db, `usernames/${key}`), cred.user.uid);
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
            login: normalizeName(username),
            createdAt: serverTimestamp()
          });
          await ensureUsernameIndex(normalizeName(username), currentUser.uid);
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
  await refreshUserCache();
  paintHeaderAvatar();

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

  // Unread mention counts for the lobby badges
  const mentionsRef = ref(db, `mentions/${currentUser.uid}`);
  const mentionsCb = (snap) => {
    const data = snap.val() || {};
    mentionCounts = {};
    for (const [roomId, msgs] of Object.entries(data)) {
      mentionCounts[roomId] = Object.keys(msgs || {}).length;
    }
    updateMentionBadges();
  };
  onValue(mentionsRef, mentionsCb);
  roomListeners.push({ ref: mentionsRef, event: "value", cb: mentionsCb });
}

function updateMentionBadges() {
  document.querySelectorAll("#room-list .room-card").forEach(card => {
    const count = mentionCounts[card.dataset.roomId] || 0;
    const badge = card.querySelector(".mention-badge");
    if (!badge) return;
    badge.textContent = count > 0 ? `🔔 ${count}` : "";
    badge.classList.toggle("hidden", count === 0);
  });
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
    <div class="room-badges">
      <span class="mention-badge hidden"></span>
      <span class="room-card-badge ${data.isPrivate ? "private" : ""}">${data.isPrivate ? "🔒" : "🌍"}</span>
    </div>
  `;
  card.addEventListener("click", () => handleJoinRoom(roomId, data));
  list.appendChild(card);
  updateMentionBadges();
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
    joinRoom(roomId, data).catch(err => console.error("Join failed:", err));
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
      joinRoom(roomId, data).catch(err => console.error("Join failed:", err));
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

async function joinRoom(roomId, data) {
  detachActiveListeners();
  currentPresence = {};
  hideMentionMenu();
  currentRoomId = roomId;
  currentRoom = data;
  $("chat-room-name").textContent = data.name;
  // Only the creator (or an admin) can close the room
  const canClose = currentUser.uid === data.createdBy || isAdmin;
  $("close-room-btn").classList.toggle("hidden", !canClose);
  showScreen("chat");
  await refreshUserCache();
  // Opening the room marks its mentions as read
  remove(ref(db, `mentions/${currentUser.uid}/${roomId}`)).catch(() => {});
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
  currentPresence = {};
  hideMentionMenu();
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
    currentPresence = users;
    const list = $("online-list");
    list.innerHTML = "";
    const count = Object.keys(users).length;
    $("online-count").textContent = count;

    Object.entries(users).forEach(([uid, u]) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="online-dot"></span><span class="avatar" data-uid="${escapeHtml(uid)}" data-name="${escapeHtml(u.username)}">${avatarInner(u.username, (userCache[uid] || {}).photoURL)}</span> ${escapeHtml(u.username)}`;
      list.appendChild(li);
    });
    if (mentionMenuState.open) updateMentionMenu();
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

  // Vanish deleted messages live for everyone in the room
  const removedCb = (snap) => {
    document.querySelector(`.message[data-msg-id="${snap.key}"]`)?.remove();
  };
  onChildRemoved(messagesRef, removedCb);
  trackListener(messagesRef, "child_removed", removedCb);
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
      <span class="avatar" data-uid="${escapeHtml(msg.uid)}" data-name="${escapeHtml(msg.username)}">${avatarInner(msg.username, (userCache[msg.uid] || {}).photoURL)}</span>
      <span class="message-username">${escapeHtml(msg.username)}</span>
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : isMsgOwner ? '<span class="message-admin-badge">OWNER</span>' : ""}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${renderMessageText(msg.text)}${msg.imageUrl ? `<a href="${escapeHtml(msg.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(msg.imageUrl)}" class="message-image" loading="lazy" alt="shared image" /></a>` : ""}${msg.fileUrl ? `<a href="${escapeHtml(msg.fileUrl)}" target="_blank" rel="noopener" download="${escapeHtml(msg.fileName || "file")}" class="file-link">📎 ${escapeHtml(msg.fileName || "Download file")}</a>` : ""}</div>
  `;
  if (messageMentionsMe(msg.text)) div.classList.add("mentioned");
  container.appendChild(div);
  if (isAdmin) {
    const header = div.querySelector(".message-header");
    const del = document.createElement("button");
    del.className = "msg-delete";
    del.title = "Delete message";
    del.textContent = "🗑️";
    del.addEventListener("click", () => {
      showConfirmModal(
        "Delete this message?",
        `<p style="color:var(--text-secondary)">${escapeHtml((msg.text || "").slice(0, 120))}</p>`,
        "Delete",
        () => remove(ref(db, `rooms/${currentRoomId}/messages/${msgId}`))
      );
    });
    header.appendChild(del);
  }
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
    const msgRef = await push(messagesRef, {
      uid: currentUser.uid,
      username: getUsername(),
      text: text,
      timestamp: serverTimestamp()
    });
    // Notify mentioned users (unread badge on their lobby room card)
    try {
      for (const uid of extractMentionedUids(text)) {
        await set(ref(db, `mentions/${uid}/${currentRoomId}/${msgRef.key}`), {
          by: getUsername(),
          at: serverTimestamp()
        });
      }
    } catch (err) {
      console.error("Mention notify failed:", err);
    }

    input.value = "";
    if (typingRef) remove(typingRef);
    hideMentionMenu();
  });

  // Mention autocomplete (@ to ping someone)
  $("message-input").addEventListener("input", updateMentionMenu);
  $("message-input").addEventListener("keydown", mentionMenuKey);
  $("mention-btn").addEventListener("click", () => {
    const input = $("message-input");
    if (!currentRoomId) return;
    input.focus();
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos);
    const after = input.value.slice(pos);
    const needsSpace = before && !/\s$/.test(before) ? " " : "";
    input.value = before + needsSpace + "@" + after;
    const newPos = before.length + needsSpace.length + 1;
    input.setSelectionRange(newPos, newPos);
    updateMentionMenu();
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

// ============ PROFILE PICTURE ============
let pendingAvatar = null;

function openProfileModal() {
  const overlay = $("modal-overlay");
  const currentPhoto = (userCache[currentUser.uid] || {}).photoURL || null;
  pendingAvatar = null;
  $("modal-title").textContent = "Your Profile";
  $("modal-body").innerHTML = `
    <div class="profile-preview"><span id="profile-preview-avatar" class="avatar avatar-lg">${avatarInner(getUsername(), currentPhoto)}</span></div>
    <p style="margin-bottom:12px;color:var(--text-secondary);text-align:center">${escapeHtml(getUsername())}</p>
    <input type="file" id="profile-file" accept="image/*" style="width:100%;margin-bottom:12px" />
    <button id="profile-remove" class="btn btn-ghost btn-small" ${currentPhoto ? "" : "disabled"}>Remove picture</button>
    <div class="profile-section">
      <h4>Change username</h4>
      <input type="text" id="profile-username" maxlength="20" placeholder="New username" autocomplete="off" />
      <button id="profile-username-save" class="btn btn-primary btn-small">Change Username</button>
    </div>
    <div class="profile-section">
      <h4>Change password</h4>
      <input type="password" id="profile-pw-current" placeholder="Current password" autocomplete="current-password" />
      <input type="password" id="profile-pw-new" placeholder="New password (min 6)" autocomplete="new-password" />
      <input type="password" id="profile-pw-confirm" placeholder="Confirm new password" autocomplete="new-password" />
      <button id="profile-pw-save" class="btn btn-primary btn-small">Change Password</button>
    </div>
  `;
  const confirmBtn = $("modal-confirm");
  confirmBtn.textContent = "Save";
  confirmBtn.onclick = saveProfileAvatar;
  $("modal-cancel").onclick = () => overlay.classList.add("hidden");
  overlay.classList.remove("hidden");

  $("profile-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast("Image must be under 5MB", "error");
      return;
    }
    try {
      pendingAvatar = await processAvatar(file);
      $("profile-preview-avatar").innerHTML = avatarInner(getUsername(), pendingAvatar);
    } catch (err) {
      console.error("Avatar processing failed:", err);
      showToast("Could not read that image", "error");
    }
  });

  $("profile-remove").addEventListener("click", async () => {
    try {
      await update(ref(db, `users/${currentUser.uid}`), { photoURL: null });
      if (userCache[currentUser.uid]) userCache[currentUser.uid].photoURL = null;
      overlay.classList.add("hidden");
      paintHeaderAvatar();
      paintAvatars(currentUser.uid);
      showToast("Profile picture removed");
    } catch (err) {
      console.error("Avatar remove failed:", err);
      showToast(`Could not remove picture (${err.code || err.message})`, "error");
    }
  });

  $("profile-username-save").addEventListener("click", changeUsername);
  $("profile-pw-save").addEventListener("click", changePassword);
}

async function saveProfileAvatar() {
  if (!pendingAvatar) {
    $("modal-overlay").classList.add("hidden");
    return;
  }
  try {
    await update(ref(db, `users/${currentUser.uid}`), { photoURL: pendingAvatar });
    if (!userCache[currentUser.uid]) userCache[currentUser.uid] = {};
    userCache[currentUser.uid].photoURL = pendingAvatar;
    userCache[currentUser.uid].username = getUsername();
    $("modal-overlay").classList.add("hidden");
    paintHeaderAvatar();
    paintAvatars(currentUser.uid);
    showToast("Profile picture updated");
  } catch (err) {
    console.error("Avatar save failed:", err);
    showToast(`Could not save picture (${err.code || err.message})`, "error");
  }
}

async function changeUsername() {
  const newName = $("profile-username").value.trim();
  if (!newName) return;
  if (newName === getUsername()) {
    showToast("That's already your username", "error");
    return;
  }
  if (newName.length < 3 || newName.length > 20) {
    showToast("Username must be 3–20 characters", "error");
    return;
  }
  const newKey = normalizeName(newName);
  if (!newKey) {
    showToast("Username needs at least one letter or number", "error");
    return;
  }
  const oldKey = normalizeName(getUsername());
  try {
    if (newKey !== oldKey) {
      const taken = await get(ref(db, `usernames/${newKey}`));
      const hit = taken.val();
      const owner = typeof hit === "string" ? hit : hit?.uid;
      if (taken.exists() && owner !== currentUser.uid) {
        showToast("That username is taken", "error");
        return;
      }
      await set(ref(db, `usernames/${newKey}`), currentUser.uid);
      await remove(ref(db, `usernames/${oldKey}`));
    }
    await update(ref(db, `users/${currentUser.uid}`), { username: newName });
  } catch (err) {
    console.error("Username change failed:", err);
    showToast(`Could not change username (${err.code || err.message})`, "error");
    return;
  }
  localStorage.setItem("vibechat-username", newName);
  if (userCache[currentUser.uid]) userCache[currentUser.uid].username = newName;
  $("current-username").textContent = newName;
  isOwner = isOwnerName(newName);
  if (isOwner) isAdmin = true;
  $("admin-btn").classList.toggle("hidden", !isAdmin);
  paintHeaderAvatar();
  paintAvatars(currentUser.uid);
  $("modal-overlay").classList.add("hidden");
  showToast(`Username changed to ${newName} — you can log in with either name`);
}

async function changePassword() {
  const currentPw = $("profile-pw-current").value;
  const next = $("profile-pw-new").value;
  const confirm = $("profile-pw-confirm").value;
  if (!currentPw || !next || !confirm) {
    showToast("Fill in all password fields", "error");
    return;
  }
  if (next !== confirm) {
    showToast("New passwords don't match", "error");
    return;
  }
  if (next.length < 6) {
    showToast("New password must be at least 6 characters", "error");
    return;
  }
  try {
    await reauthenticateWithCredential(currentUser, EmailAuthProvider.credential(currentUser.email, currentPw));
    await updatePassword(currentUser, next);
  } catch (err) {
    console.error("Password change failed:", err);
    showToast(
      err.code === "auth/wrong-password" || err.code === "auth/invalid-credential" ? "Current password is wrong"
      : `Could not change password (${err.code || err.message})`, "error");
    return;
  }
  $("modal-overlay").classList.add("hidden");
  showToast("Password changed");
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
    const av = document.createElement("span");
    av.className = "avatar";
    av.dataset.uid = id;
    av.dataset.name = data.username;
    av.innerHTML = avatarInner(data.username, data.photoURL);
    item.appendChild(av);
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

// ============ COLOUR THEMES ============
const THEMES = [
  { id: "purple", name: "Midnight Purple", color: "#7c6cf0" },
  { id: "ocean", name: "Ocean Blue", color: "#3aa8e0" },
  { id: "mint", name: "Mint Green", color: "#3ecf8e" },
  { id: "sunset", name: "Sunset Orange", color: "#f07830" },
  { id: "rose", name: "Rose Pink", color: "#ec5f8c" },
  { id: "retro", name: "Retro Terminal", color: "#00ff41" },
  { id: "daylight", name: "Daylight", color: "#f2f2f7" }
];

function currentTheme() {
  return localStorage.getItem("vibechat-theme") || "purple";
}

function applyTheme(id) {
  if (!THEMES.some(t => t.id === id)) id = "purple";
  if (id === "purple") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", id);
  localStorage.setItem("vibechat-theme", id);
  document.querySelectorAll(".theme-row").forEach(row => {
    const check = row.querySelector(".theme-check");
    if (check) check.textContent = row.dataset.theme === id ? "✓" : "";
  });
}

function initThemes() {
  const panel = $("theme-panel");
  panel.innerHTML = "<h4>Colour theme</h4>";
  THEMES.forEach(t => {
    const row = document.createElement("button");
    row.className = "theme-row";
    row.dataset.theme = t.id;
    row.innerHTML = `<span class="theme-dot" style="background:${t.color}"></span> ${t.name} <span class="theme-check"></span>`;
    row.addEventListener("click", () => {
      applyTheme(t.id);
      panel.classList.add("hidden");
    });
    panel.appendChild(row);
  });
  applyTheme(currentTheme());
  $("theme-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!panel.classList.contains("hidden") && !e.target.closest(".theme-wrap")) {
      panel.classList.add("hidden");
    }
  });
}
// ============ NAVIGATION ============
function initNavigation() {
  $("back-btn").addEventListener("click", leaveRoom);

  $("profile-btn").addEventListener("click", openProfileModal);

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
  initGamesUI();
  initThemes();
});

function initGamesUI() {
  initGames();
  $("games-btn").addEventListener("click", () => showScreen("games"));
  $("games-back-btn").addEventListener("click", () => {
    closeGame();
    showScreen("lobby");
  });
}
