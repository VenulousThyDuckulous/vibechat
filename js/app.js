// ============================================================
//  VibeChat — Main App Module
// ============================================================

import { auth, db, ADMIN_UIDS, OWNER_USERNAMES, VAPID_KEY, GIPHY_API_KEY } from "./firebase-config.js";
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
  runTransaction,
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
let replyTarget = null;
let myRooms = new Set();
let coinBalance = 0;
let avatarDraft = null;
let coinListenerRef = null;
let plateDraftTheme = "classic";

const PLATE_UNLOCK_PRICE = 1000;

// Nameplate themes (pure CSS, see style.css). The plate itself must be
// unlocked first (1000 coins), then themes are bought individually.
const PLATE_THEMES = [
  { id: "classic", name: "Classic", price: 0 },
  { id: "ember", name: "Ember", price: 100 },
  { id: "crimson", name: "Crimson", price: 150 },
  { id: "ocean", name: "Ocean", price: 200 },
  { id: "mint", name: "Mint", price: 300 },
  { id: "sunset", name: "Sunset", price: 450 },
  { id: "royal", name: "Royal", price: 600 },
  { id: "diamond", name: "Diamond", price: 800 }
];

function plateHtml(uid) {
  const p = (userCache[uid] || {}).nameplate;
  const show = p?.text ? "" : ' style="display:none"';
  const theme = p?.theme || "classic";
  const text = p?.text ? escapeHtml(p.text.slice(0, 16)) : "";
  return `<span class="plate plate-${theme}" data-plate-uid="${escapeHtml(uid)}"${show}>${text}</span>`;
}

function paintPlatesIn(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("[data-plate-uid]").forEach(el => {
    const p = (userCache[el.dataset.plateUid] || {}).nameplate;
    if (p?.text) {
      el.className = `plate plate-${p.theme || "classic"}`;
      el.textContent = p.text.slice(0, 16);
      el.style.display = "";
    } else {
      el.style.display = "none";
    }
  });
}
let friendListeners = [];
let friendsCache = {};
let requestsCache = {};
let friendsPrimed = false;

function loadMyRooms() {
  try {
    myRooms = new Set(JSON.parse(localStorage.getItem("vibechat-myrooms") || "[]"));
  } catch (e) {
    myRooms = new Set();
  }
}

function saveMyRooms() {
  localStorage.setItem("vibechat-myrooms", JSON.stringify([...myRooms]));
}

// Saved room passwords (plaintext convenience — room locks are casual, not secure)
function savedRoomPw(roomId) {
  return localStorage.getItem(`vibechat-roompw:${roomId}`);
}

function saveRoomPw(roomId, pw) {
  localStorage.setItem(`vibechat-roompw:${roomId}`, pw);
}

function clearRoomPw(roomId) {
  localStorage.removeItem(`vibechat-roompw:${roomId}`);
}

const ANNOUNCEMENTS_ID = "announcements";

// One-time migration: the old pinned announcements room (if any) moves to
// the dedicated announcements feed, then the legacy room is removed.
async function migrateAnnouncements() {
  try {
    const legacy = await get(ref(db, `rooms/${ANNOUNCEMENTS_ID}`));
    if (!legacy.exists()) return;
    const msgs = legacy.val()?.messages || {};
    for (const [id, m] of Object.entries(msgs)) {
      await set(ref(db, `announcements/messages/${id}`), m);
    }
    await remove(ref(db, `rooms/${ANNOUNCEMENTS_ID}`));
  } catch (err) {
    console.error("Announcements migration failed:", err);
  }
}
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
  games: $("games-screen"),
  announcements: $("announcements-screen"),
  dm: $("dm-screen")
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
  syncFrameClass(el, currentUser.uid);
}

// Frames the shop sells (pure CSS, see style.css)
const FRAMES = [
  { id: "gold", name: "24K Gold", price: 100 },
  { id: "neon", name: "Neon", price: 150 },
  { id: "royal", name: "Royal", price: 250 },
  { id: "rainbow", name: "Rainbow", price: 400 },
  { id: "pixel", name: "8-Bit", price: 75 },
  { id: "abyss", name: "Abyss", price: 150 },
  { id: "sunset", name: "Sunset", price: 200 },
  { id: "frost", name: "Frost", price: 125 },
  { id: "shadow", name: "Shadow", price: 300 }
];

function equippedFrame(uid) {
  return (userCache[uid] || {}).equippedFrame || null;
}

function syncFrameClass(el, uid) {
  [...el.classList].forEach(c => {
    if (c.startsWith("frame-")) el.classList.remove(c);
  });
  const f = equippedFrame(uid);
  if (f) el.classList.add(`frame-${f}`);
}

function paintFramesIn(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(".avatar[data-uid]").forEach(el => syncFrameClass(el, el.dataset.uid));
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
const MENTION_CAND_RE = /@([A-Za-z0-9_ |.\-]{1,20})/g;

// Greedy candidate + shrink until a real username matches, so
// "@bob hello there" pings bob instead of looking up "bob hello there".
// Returns { uid, username, matchLen } where matchLen is raw chars consumed.
function lookupMention(cand) {
  let c = (cand || "").trim();
  while (c) {
    const norm = c.toLowerCase().replace(/[ .|\-]+$/, "");
    if (norm) {
      for (const [uid, u] of Object.entries(userCache)) {
        if ((u.username || "").toLowerCase() === norm) {
          return { uid, username: u.username, matchLen: norm.length };
        }
      }
    }
    const sp = c.lastIndexOf(" ");
    c = (sp > 0 ? c.slice(0, sp) : c.slice(0, -1)).trimEnd();
  }
  return null;
}

function extractMentionedUids(text, senderIsOwner) {
  const uids = new Set();
  const raw = text || "";
  // @everyone: owner-only broadcast to every known user
  if (senderIsOwner && /(?:^|\s)@everyone(?![A-Za-z0-9_])/i.test(raw) && currentUser) {
    for (const uid of Object.keys(userCache)) {
      if (uid !== currentUser.uid) uids.add(uid);
    }
  }
  raw.replace(MENTION_CAND_RE, (m, cand) => {
    const hit = lookupMention(cand);
    if (hit && currentUser && hit.uid !== currentUser.uid) uids.add(hit.uid);
    return m;
  });
  return [...uids];
}

function messageMentionsMe(msg) {
  const text = msg?.text || "";
  // Owner-sent @everyone pings every viewer
  if (isOwnerName(msg?.username) && /(?:^|\s)@everyone(?![A-Za-z0-9_])/i.test(text)) return true;
  // Replies directed at me ping me too
  if (msg?.replyTo?.uid && currentUser && msg.replyTo.uid === currentUser.uid) return true;
  const myName = getUsername().toLowerCase();
  let found = false;
  text.replace(MENTION_CAND_RE, (m, cand) => {
    const hit = lookupMention(cand);
    if (hit && hit.username.toLowerCase() === myName) found = true;
    return m;
  });
  return found;
}

function renderMessageText(raw, everyoneActive = false) {
  const text = raw || "";
  // Pull URLs out first (raw), so @ inside links never parses as mentions.
  // Private-use placeholders survive the escape step unharmed.
  const urls = [];
  const noUrls = text.replace(URL_RE, (m) => {
    urls.push(m);
    return `\uE000${urls.length - 1}\uE001`;
  });
  const myName = getUsername().toLowerCase();
  let out = "";
  let last = 0;
  const candRe = new RegExp(MENTION_CAND_RE.source, "g");
  let m;
  while ((m = candRe.exec(noUrls)) !== null) {
    const cand = m[1];
    const ev = /^everyone(?![A-Za-z0-9_])/i.exec(cand);
    if (everyoneActive && ev) {
      out += escapeHtml(noUrls.slice(last, m.index)) + `<span class="mention me">@everyone</span>`;
      last = m.index + 1 + ev[0].length;
      continue;
    }
    const hit = lookupMention(cand);
    if (!hit) continue;
    const me = hit.username.toLowerCase() === myName;
    out += escapeHtml(noUrls.slice(last, m.index)) +
      `<span class="mention${me ? " me" : ""}">@${escapeHtml(hit.username)}</span>`;
    last = m.index + 1 + hit.matchLen;
  }
  out += escapeHtml(noUrls.slice(last));
  return out.replace(/\uE000(\d+)\uE001/g, (_, i) => {
    const u = urls[+i] || "";
    const e = escapeHtml(u);
    return `<a href="${e}" target="_blank" rel="noopener">${e}</a>`;
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
  const buildItems = (qq) => {
    const online = Object.entries(currentPresence)
      .filter(([uid, u]) => uid !== currentUser.uid && (u.username || "").toLowerCase().includes(qq))
      .map(([uid, u]) => ({ uid, username: u.username, online: true }));
    const seen = new Set(online.map(i => i.uid));
    seen.add(currentUser.uid);
    const others = Object.entries(userCache)
      .filter(([uid, u]) => !seen.has(uid) && (u.username || "").toLowerCase().includes(qq))
      .map(([uid, u]) => ({ uid, username: u.username, online: false }));
    return [...online, ...others];
  };
  // If trailing message text kills all matches, drop words from the right.
  let query = q.query.toLowerCase();
  let all = buildItems(query);
  while (!all.length && /\s/.test(query.trim())) {
    query = query.trim().slice(0, query.trim().lastIndexOf(" "));
    all = buildItems(query);
  }
  let items = all;
  if (isOwner && "everyone".includes(query)) {
    items.unshift({ uid: null, username: "everyone", online: true, everyone: true });
  }
  items = items.slice(0, 8);
  mentionMenuState = { open: true, items, highlight: 0 };
  menu.innerHTML = "<h4>Members</h4>";
  if (!items.length) {
    menu.innerHTML += '<p class="mention-empty">No matches</p>';
  } else {
    items.forEach((item, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-row" + (i === 0 ? " selected" : "") + (item.online ? "" : " offline");
      if (item.everyone) {
        row.innerHTML = `<span style="font-size:1.1rem">📣</span> <b>everyone</b> <span style="color:var(--text-secondary);font-size:0.8rem">Notify everyone</span>`;
      } else {
        const photo = (userCache[item.uid] || {}).photoURL;
        row.innerHTML = `<span class="avatar" data-uid="${escapeHtml(item.uid)}" data-name="${escapeHtml(item.username)}">${avatarInner(item.username, photo)}</span> ${escapeHtml(item.username)}`;
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        completeMention(item.username);
      });
      row.addEventListener("mouseenter", () => setMentionHighlight(i));
      menu.appendChild(row);
    });
  }
  paintFramesIn(menu);
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
      stopNotifListeners();
      stopFriends();
      stopCoinListener();
      detachDmAll();
      closeAnnListeners();
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

  await migrateAnnouncements();
  showScreen("lobby");
  loadMyRooms();
  loadRooms();
  loadFriends();
  loadDmList();
  updateAnnouncementsBadge();
  startNotifListeners();
  startCoinListener();
  if (notifEnabled()) registerPushToken();
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

  // Keep member counts / info fresh without a full reload
  const changedCb = (snap) => {
    const card = document.querySelector(`#room-list [data-room-id="${snap.key}"]`);
    if (card) {
      const p = card.querySelector(".room-card-info p");
      if (p) p.innerHTML = roomCardSub(snap.val(), snap.key);
    }
    roomCache[snap.key] = snap.val();
  };
  onChildChanged(roomsRef, changedCb);
  roomListeners.push({ ref: roomsRef, event: "child_changed", cb: changedCb });

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

function roomCardSub(data, roomId) {
  const base = `${data.isPrivate ? "🔒 Private" : "🌍 Public"} · ${data.memberCount || 0} members`;
  return myRooms.has(roomId) ? `${base} · ✅ <b>You're in it</b>` : base;
}

function refreshRoomCard(roomId) {
  const card = document.querySelector(`#room-list [data-room-id="${roomId}"]`);
  const data = roomCache[roomId];
  if (card && data) {
    const p = card.querySelector(".room-card-info p");
    if (p) p.innerHTML = roomCardSub(data, roomId);
  }
}

function addRoomToList(roomId, data) {
  const list = $("room-list");
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();
  if (list.querySelector(`[data-room-id="${roomId}"]`)) return;

  const card = document.createElement("div");
  card.className = "room-card";
  card.dataset.roomId = roomId;
  card.innerHTML = `
    <div class="room-card-info">
      <h4>${escapeHtml(data.name)}</h4>
      <p>${roomCardSub(data, roomId)}</p>
    </div>
    <div class="room-badges">
      <span class="mention-badge hidden"></span>
      <span class="room-card-badge ${data.isPrivate ? "private" : ""}">${data.isPrivate ? "🔒" : "🌍"}</span>
    </div>
  `;
  card.addEventListener("click", () => handleJoinRoom(roomId, data));
  roomCache[roomId] = data;
  list.appendChild(card);
  updateMentionBadges();
}

function removeRoomFromList(roomId) {
  const card = document.querySelector(`[data-room-id="${roomId}"]`);
  if (card) card.remove();
  delete roomCache[roomId];
  if (myRooms.delete(roomId)) saveMyRooms();
  const list = $("room-list");
  if (list && !list.children.length) {
    list.innerHTML = '<p class="empty-state">No rooms yet — create one!</p>';
  }
}

function handleJoinRoom(roomId, data) {
  if (!data.isPrivate) {
    enterRoom(roomId, data);
    return;
  }
  // Private room: members with a saved password skip the prompt
  const saved = savedRoomPw(roomId);
  if (saved) verifyRoomPassword(roomId, data, saved, true);
  else showPasswordModal(roomId, data);
}

async function verifyRoomPassword(roomId, data, pw, fromSaved) {
  const hashed = await simpleHash(pw);
  if (hashed === data.passwordHash) {
    saveRoomPw(roomId, pw);
    enterRoom(roomId, data);
  } else if (fromSaved) {
    clearRoomPw(roomId);
    showPasswordModal(roomId, data);
  } else {
    showToast("Wrong room password", "error");
  }
}

async function enterRoom(roomId, data) {
  await ensureMember(roomId);
  myRooms.add(roomId);
  saveMyRooms();
  refreshRoomCard(roomId);
  joinRoom(roomId, data).catch(err => console.error("Join failed:", err));
}

// Server membership is the source of truth (prevents double member counts).
async function ensureMember(roomId) {
  try {
    const snap = await get(ref(db, `rooms/${roomId}/members/${currentUser.uid}`));
    if (!snap.exists()) {
      await set(ref(db, `rooms/${roomId}/members/${currentUser.uid}`), {
        username: getUsername(),
        joinedAt: serverTimestamp()
      });
      await runTransaction(ref(db, `rooms/${roomId}/memberCount`), (c) => (c || 0) + 1);
    }
  } catch (err) {
    console.error("Member join failed:", err);
  }
}

async function removeMember(roomId) {
  try {
    await remove(ref(db, `rooms/${roomId}/members/${currentUser.uid}`));
    await runTransaction(ref(db, `rooms/${roomId}/memberCount`), (c) => Math.max(0, (c || 1) - 1));
  } catch (err) {
    console.error("Member leave failed:", err);
  }
}

function leaveRoomForGood() {
  if (!currentRoomId) return;
  const name = currentRoom?.name || "this room";
  const locked = !!currentRoom?.isPrivate;
  showConfirmModal(
    `Leave "${name}"?`,
    `<p style="color:var(--text-secondary)">You'll be removed from the member list.${locked ? " You'll need the password to rejoin." : ""}</p>`,
    "Leave Room",
    async () => {
      const roomId = currentRoomId;
      await removeMember(roomId);
      myRooms.delete(roomId);
      saveMyRooms();
      clearRoomPw(roomId);
      leaveRoom();
      showToast("Left room");
    }
  );
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
    overlay.classList.add("hidden");
    verifyRoomPassword(roomId, data, pw, false);
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
  clearReply();
  document.querySelector(".gif-picker")?.classList.add("hidden");
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
  clearReply();
  document.querySelector(".gif-picker")?.classList.add("hidden");
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
  updateAnnouncementsBadge();
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
    paintFramesIn(list);
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
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : isMsgOwner ? '<span class="message-admin-badge">OWNER</span>' : ""} ${plateHtml(msg.uid)}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${msg.replyTo ? `<div class="reply-quote" data-goto="${escapeHtml(msg.replyTo.msgId)}"><span class="reply-author">@${escapeHtml(msg.replyTo.username)}</span><span>${escapeHtml((msg.replyTo.text || "").slice(0, 120))}</span></div>` : ""}${renderMessageText(msg.text, isOwnerName(msg.username))}${msg.imageUrl ? `<a href="${escapeHtml(msg.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(msg.imageUrl)}" class="message-image" loading="lazy" alt="shared image" /></a>` : ""}${msg.fileUrl ? `<a href="${escapeHtml(msg.fileUrl)}" target="_blank" rel="noopener" download="${escapeHtml(msg.fileName || "file")}" class="file-link">📎 ${escapeHtml(msg.fileName || "Download file")}</a>` : ""}</div>
  `;
  if (messageMentionsMe(msg)) div.classList.add("mentioned");
  container.appendChild(div);
  const header = div.querySelector(".message-header");
  if (isAdmin) {
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
  const rpl = document.createElement("button");
  rpl.className = "msg-reply";
  rpl.title = "Reply";
  rpl.textContent = "↩️";
  rpl.addEventListener("click", () => {
    replyTarget = { msgId, uid: msg.uid, username: msg.username, text: (msg.text || "").slice(0, 120) };
    showReplyPreview();
    $("message-input").focus();
  });
  header.appendChild(rpl);
  paintFramesIn(div);
  container.scrollTop = container.scrollHeight;
}

function showReplyPreview() {
  if (!replyTarget) {
    $("reply-bar").classList.add("hidden");
    return;
  }
  $("reply-to-name").textContent = "@" + replyTarget.username;
  $("reply-to-text").textContent = replyTarget.text || "";
  $("reply-bar").classList.remove("hidden");
}

function clearReply() {
  replyTarget = null;
  const bar = $("reply-bar");
  if (bar) bar.classList.add("hidden");
}

function scrollToMessage(msgId) {
  const el = document.querySelector(`#messages .message[data-msg-id="${msgId}"]`);
  if (!el) {
    showToast("Original message isn't loaded", "error");
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1300);
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
    const msgData = {
      uid: currentUser.uid,
      username: getUsername(),
      text: text,
      timestamp: serverTimestamp()
    };
    if (replyTarget) msgData.replyTo = { ...replyTarget };
    const msgRef = await push(messagesRef, msgData);
    // Notify mentioned users (unread badge on their lobby room card)
    try {
      for (const uid of extractMentionedUids(text, isOwner)) {
        await set(ref(db, `mentions/${uid}/${currentRoomId}/${msgRef.key}`), {
          by: getUsername(),
          text: text.slice(0, 120),
          at: serverTimestamp()
        });
      }
      // Replies ping the original author like a mention
      if (replyTarget && replyTarget.uid !== currentUser.uid) {
        await set(ref(db, `mentions/${replyTarget.uid}/${currentRoomId}/${msgRef.key}`), {
          by: getUsername(),
          text: `↩️ ${text.slice(0, 110)}`,
          at: serverTimestamp()
        });
      }
    } catch (err) {
      console.error("Mention notify failed:", err);
    }

    input.value = "";
    if (typingRef) remove(typingRef);
    clearReply();
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

  // GIF picker (Giphy)
  $("gif-btn").addEventListener("click", toggleGifPicker);

  // Reply composer
  $("reply-cancel").addEventListener("click", clearReply);
  $("messages").addEventListener("click", (e) => {
    const quote = e.target.closest(".reply-quote");
    if (quote && quote.dataset.goto) scrollToMessage(quote.dataset.goto);
  });
}

// ============ GIF PICKER (GIPHY) ============
function toggleGifPicker() {
  let picker = document.querySelector(".gif-picker");
  if (picker) {
    picker.classList.toggle("hidden");
    return;
  }

  picker = document.createElement("div");
  picker.className = "gif-picker";
  picker.innerHTML = `
    <div class="gif-search-row">
      <input type="text" id="gif-search" placeholder="Search GIFs..." autocomplete="off" />
    </div>
    <div class="gif-grid"></div>
    <div class="gif-attrib">Powered by GIPHY</div>
  `;
  document.querySelector(".chat-main").appendChild(picker);

  const grid = picker.querySelector(".gif-grid");
  const search = picker.querySelector("#gif-search");
  let debounce;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => loadGifs(grid, search.value.trim()), 400);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(debounce);
      loadGifs(grid, search.value.trim());
    }
  });
  loadGifs(grid, "");
}

async function loadGifs(grid, q) {
  if (!GIPHY_API_KEY || GIPHY_API_KEY === "YOUR_GIPHY_KEY") {
    grid.innerHTML = '<p class="gif-status">GIFs need a Giphy API key — ask the owner to add one.</p>';
    return;
  }
  grid.innerHTML = '<p class="gif-status">Loading…</p>';
  try {
    const base = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(q)}&limit=20&rating=g`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=20&rating=g`;
    const res = await fetch(base);
    if (!res.ok) throw new Error(`Giphy ${res.status}`);
    const data = await res.json();
    grid.innerHTML = "";
    if (!data.data?.length) {
      grid.innerHTML = '<p class="gif-status">No GIFs found.</p>';
      return;
    }
    data.data.forEach(g => {
      const tiny = g.images?.fixed_height_small?.url || g.images?.preview_gif?.url;
      const full = g.images?.downsized_large?.url || g.images?.original?.url || tiny;
      if (!tiny || !full) return;
      const img = document.createElement("img");
      img.src = tiny;
      img.loading = "lazy";
      img.alt = g.title || "GIF";
      img.title = g.title || "GIF";
      img.addEventListener("click", () => sendGif(full));
      grid.appendChild(img);
    });
  } catch (err) {
    console.error("GIF load failed:", err);
    grid.innerHTML = '<p class="gif-status">Could not load GIFs. Try again.</p>';
  }
}

async function sendGif(url) {
  if (!currentRoomId || isBanned || !currentUser) return;
  const picker = document.querySelector(".gif-picker");
  if (picker) picker.classList.add("hidden");
  try {
    await push(ref(db, `rooms/${currentRoomId}/messages`), {
      uid: currentUser.uid,
      username: getUsername(),
      text: "🎬 GIF",
      imageUrl: url,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.error("GIF send failed:", err);
    showToast("Could not send GIF", "error");
  }
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
  const currentPhoto = avatarDraft || (userCache[currentUser.uid] || {}).photoURL || null;
  pendingAvatar = avatarDraft;
  $("modal-title").textContent = "Your Profile";
  $("modal-body").innerHTML = `
    <div class="profile-preview"><span id="profile-preview-avatar" class="avatar avatar-lg">${avatarInner(getUsername(), currentPhoto)}</span></div>
    <p style="margin-bottom:12px;color:var(--text-secondary);text-align:center">${escapeHtml(getUsername())}</p>
    <input type="file" id="profile-file" accept="image/*" style="width:100%;margin-bottom:12px" />
    <button id="profile-remove" class="btn btn-ghost btn-small" ${currentPhoto ? "" : "disabled"}>Remove picture</button>
    <div class="profile-section">
      <h4>Bio</h4>
      <textarea id="profile-bio" maxlength="150" rows="3" placeholder="Say something about yourself..."></textarea>
    </div>
    <div class="profile-section">
      <h4>Frames <span id="shop-balance" class="coin-pill">🪙 0</span></h4>
      <div id="frames-grid" class="frames-grid"></div>
    </div>
    <div class="profile-section">
      <h4>Nameplate</h4>
      <div class="plate-preview"><span id="plate-live-preview" class="plate plate-classic">Preview</span></div>
      <input type="text" id="plate-text" maxlength="16" placeholder="Plate text (max 16)" autocomplete="off" />
      <div id="plates-grid" class="plates-grid"></div>
      <button id="plate-action" class="btn btn-primary btn-small">Unlock — 🪙1000</button>
    </div>
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
  confirmBtn.style.display = "";
  confirmBtn.textContent = "Save";
  confirmBtn.onclick = saveProfile;
  $("modal-cancel").textContent = "Cancel";
  $("modal-cancel").onclick = () => overlay.classList.add("hidden");
  overlay.classList.remove("hidden");
  $("profile-bio").value = (userCache[currentUser.uid] || {}).bio || "";
  syncFrameClass($("profile-preview-avatar"), currentUser.uid);
  renderFramesShop();
  initPlatesShop();

  $("profile-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      showToast("Image must be under 5MB", "error");
      return;
    }
    try {
      pendingAvatar = await processAvatar(file);
      avatarDraft = pendingAvatar;
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
      pendingAvatar = null;
      avatarDraft = null;
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

async function saveProfile() {
  const overlay = $("modal-overlay");
  const bioEl = $("profile-bio");
  const updates = {};
  if (bioEl) updates.bio = bioEl.value.trim().slice(0, 150);
  if (pendingAvatar) updates.photoURL = pendingAvatar;
  if (!Object.keys(updates).length) {
    overlay.classList.add("hidden");
    return;
  }
  try {
    await update(ref(db, `users/${currentUser.uid}`), updates);
    if (!userCache[currentUser.uid]) userCache[currentUser.uid] = {};
    Object.assign(userCache[currentUser.uid], updates);
    userCache[currentUser.uid].username = getUsername();
    pendingAvatar = null;
    avatarDraft = null;
    overlay.classList.add("hidden");
    paintHeaderAvatar();
    paintAvatars(currentUser.uid);
    paintFramesIn(document);
    showToast("Profile updated");
  } catch (err) {
    console.error("Profile save failed:", err);
    showToast(`Could not save profile (${err.code || err.message})`, "error");
  }
}

function openProfileView(uid, fallbackName) {
  const p = userCache[uid] || {};
  const name = p.username || fallbackName || "user";
  const badges = isOwnerName(name) ? '<span class="message-admin-badge">OWNER</span>'
    : adminUids.has(uid) ? '<span class="message-admin-badge">ADMIN</span>' : "";
  $("modal-title").textContent = name;
  $("modal-body").innerHTML = `
    <div class="profile-preview"><span id="profile-view-avatar" class="avatar avatar-lg">${avatarInner(name, p.photoURL)}</span></div>
    <p style="text-align:center;font-weight:700">${escapeHtml(name)} ${badges} ${plateHtml(uid)}</p>
    <p class="bio-text">${p.bio ? escapeHtml(p.bio) : '<span class="bio-empty">No bio yet.</span>'}</p>
    <div id="profile-friend-action" style="display:flex;justify-content:center;margin-top:12px"></div>
    <div id="profile-msg-action" style="display:flex;justify-content:center;margin-top:8px"></div>
  `;
  syncFrameClass($("modal-body").querySelector("#profile-view-avatar"), uid);
  renderFriendAction(uid, $("modal-body").querySelector("#profile-friend-action"));
  const msgBox = $("modal-body").querySelector("#profile-msg-action");
  msgBox.innerHTML = "";
  if (currentUser && uid !== currentUser.uid) {
    const b = document.createElement("button");
    b.className = "btn btn-primary btn-small";
    b.textContent = "Message";
    b.addEventListener("click", () => {
      $("modal-overlay").classList.add("hidden");
      openDM(uid, name);
    });
    msgBox.appendChild(b);
  }
  const confirmBtn = $("modal-confirm");
  confirmBtn.style.display = "none";
  const cancelBtn = $("modal-cancel");
  cancelBtn.textContent = "Close";
  cancelBtn.onclick = () => $("modal-overlay").classList.add("hidden");
  $("modal-overlay").classList.remove("hidden");
}

function renderFramesShop() {
  const grid = $("frames-grid");
  if (!grid || !currentUser) return;
  const me = userCache[currentUser.uid] || {};
  const owned = (me.frames && me.frames.owned) || {};
  const equipped = me.equippedFrame || null;
  const myName = getUsername();
  const myPhoto = me.photoURL || null;
  const bal = $("shop-balance");
  if (bal) bal.textContent = `🪙 ${coinBalance}`;
  grid.innerHTML = "";
  FRAMES.forEach(f => {
    const item = document.createElement("div");
    item.className = "frame-item";
    const isEquipped = equipped === f.id;
    const isOwned = !!owned[f.id];
    item.innerHTML = `
      <span class="avatar frame-${f.id}">${avatarInner(myName, myPhoto)}</span>
      <span class="frame-name">${f.name}</span>
    `;
    const btn = document.createElement("button");
    if (isEquipped) {
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = "Equipped ✓";
      btn.title = "Click to remove";
      btn.addEventListener("click", () => unequipFrame());
    } else if (isOwned) {
      btn.className = "btn btn-primary btn-small";
      btn.textContent = "Equip";
      btn.addEventListener("click", () => equipFrame(f.id, f.name));
    } else {
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = `Buy 🪙${f.price}`;
      btn.addEventListener("click", () => buyFrame(f.id, f.name, f.price));
    }
    item.appendChild(btn);
    grid.appendChild(item);
  });
}

async function buyFrame(id, name, price) {
  try {
    const res = await runTransaction(ref(db, `users/${currentUser.uid}/coins`), (c) => {
      if ((c || 0) < price) return; // abort: can't afford it
      return c - price;
    });
    if (!res.committed) {
      showToast(`Need 🪙${price} for ${name} — play games to earn more!`, "error");
      return;
    }
    await update(ref(db, `users/${currentUser.uid}`), {
      [`frames/owned/${id}`]: true,
      equippedFrame: id
    });
    const me = userCache[currentUser.uid] || (userCache[currentUser.uid] = {});
    me.coins = res.snapshot.val() || 0;
    me.frames = me.frames || {};
    me.frames.owned = { ...(me.frames.owned || {}), [id]: true };
    me.equippedFrame = id;
    coinBalance = me.coins;
    paintFramesIn(document);
    renderFramesShop();
    showToast(`${name} frame equipped!`);
  } catch (err) {
    console.error("Frame buy failed:", err);
    showToast(`Couldn't buy frame (${err.code || err.message})`, "error");
  }
}

async function equipFrame(id, name) {
  try {
    await update(ref(db, `users/${currentUser.uid}`), { equippedFrame: id });
    const me = userCache[currentUser.uid] || (userCache[currentUser.uid] = {});
    me.equippedFrame = id;
    paintFramesIn(document);
    renderFramesShop();
    showToast(`${name} frame equipped!`);
  } catch (err) {
    console.error("Frame equip failed:", err);
    showToast("Couldn't equip frame", "error");
  }
}

async function unequipFrame() {
  try {
    await update(ref(db, `users/${currentUser.uid}`), { equippedFrame: null });
    if (userCache[currentUser.uid]) userCache[currentUser.uid].equippedFrame = null;
    paintFramesIn(document);
    renderFramesShop();
  } catch (err) {
    console.error("Frame unequip failed:", err);
  }
}

function startCoinListener() {
  if (coinListenerRef || !currentUser) return;
  coinListenerRef = ref(db, `users/${currentUser.uid}/coins`);
  const cb = (snap) => {
    coinBalance = snap.val() || 0;
    const pill = $("coin-balance");
    if (pill) pill.textContent = coinBalance;
    const shop = $("shop-balance");
    if (shop) shop.textContent = `🪙 ${coinBalance}`;
    if (userCache[currentUser.uid]) userCache[currentUser.uid].coins = coinBalance;
  };
  onValue(coinListenerRef, cb);
}

function stopCoinListener() {
  if (coinListenerRef) {
    try { off(coinListenerRef); } catch (e) {}
    coinListenerRef = null;
  }
  coinBalance = 0;
}

function initPlatesShop() {
  const me = userCache[currentUser.uid] || {};
  plateDraftTheme = (me.nameplate && me.nameplate.theme) || "classic";
  const textInput = $("plate-text");
  textInput.value = (me.nameplate && me.nameplate.text) || "";
  const refreshPreview = () => {
    const prev = $("plate-live-preview");
    prev.className = `plate plate-${plateDraftTheme}`;
    prev.textContent = textInput.value.trim().slice(0, 16) || "Preview";
  };
  textInput.oninput = refreshPreview;
  refreshPreview();
  renderPlatesShop();
}

function renderPlatesShop() {
  const grid = $("plates-grid");
  if (!grid || !currentUser) return;
  const me = userCache[currentUser.uid] || {};
  const unlocked = !!(me.nameplate && me.nameplate.text);
  const owned = (me.plates && me.plates.owned) || {};
  const equipped = (me.nameplate && me.nameplate.theme) || "classic";
  grid.innerHTML = "";
  PLATE_THEMES.forEach(t => {
    const isEquipped = unlocked && equipped === t.id;
    const isOwned = t.id === "classic" || !!owned[t.id];
    const item = document.createElement("div");
    item.className = "plate-item";
    item.innerHTML = `
      <span class="plate plate-${t.id} plate-sample">Aa</span>
      <span class="plate-meta">
        <span class="plate-name">${t.name}</span>
      </span>
    `;
    const btn = document.createElement("button");
    if (isEquipped) {
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = "Equipped ✓";
      btn.disabled = true;
    } else if (isOwned && unlocked) {
      btn.className = "btn btn-primary btn-small";
      btn.textContent = "Equip";
      btn.addEventListener("click", () => equipPlateTheme(t.id, t.name));
    } else if (isOwned) {
      btn.className = "btn btn-primary btn-small";
      btn.textContent = "Select";
      btn.addEventListener("click", () => {
        plateDraftTheme = t.id;
        const prev = $("plate-live-preview");
        if (prev) {
          prev.className = `plate plate-${t.id}`;
          renderPlatesShop();
        }
      });
    } else {
      btn.className = "btn btn-ghost btn-small";
      btn.textContent = `Buy 🪙${t.price}`;
      btn.addEventListener("click", () => buyPlateTheme(t.id, t.name, t.price));
    }
    item.querySelector(".plate-meta").appendChild(btn);
    grid.appendChild(item);
  });
  const action = $("plate-action");
  if (unlocked) {
    action.textContent = "Save Text";
    action.onclick = savePlateText;
  } else {
    action.textContent = `Unlock — 🪙${PLATE_UNLOCK_PRICE}`;
    action.onclick = unlockNameplate;
  }
}

async function unlockNameplate() {
  const text = ($("plate-text")?.value || "").trim().slice(0, 16);
  if (!text) {
    showToast("Write your plate text first", "error");
    return;
  }
  try {
    const res = await runTransaction(ref(db, `users/${currentUser.uid}/coins`), (c) => {
      if ((c || 0) < PLATE_UNLOCK_PRICE) return; // abort
      return c - PLATE_UNLOCK_PRICE;
    });
    if (!res.committed) {
      showToast(`Need 🪙${PLATE_UNLOCK_PRICE} to unlock — play games to earn more!`, "error");
      return;
    }
    await update(ref(db, `users/${currentUser.uid}`), {
      "nameplate/text": text,
      "nameplate/theme": "classic"
    });
    const me = userCache[currentUser.uid] || (userCache[currentUser.uid] = {});
    me.coins = res.snapshot.val() || 0;
    me.nameplate = { text, theme: "classic" };
    coinBalance = me.coins;
    plateDraftTheme = "classic";
    paintPlatesIn(document);
    renderPlatesShop();
    showToast("Nameplate unlocked!");
  } catch (err) {
    console.error("Nameplate unlock failed:", err);
    showToast(`Couldn't unlock (${err.code || err.message})`, "error");
  }
}

async function savePlateText() {
  const text = ($("plate-text")?.value || "").trim().slice(0, 16);
  if (!text) {
    showToast("Plate text can't be empty", "error");
    return;
  }
  try {
    await update(ref(db, `users/${currentUser.uid}`), { "nameplate/text": text });
    const me = userCache[currentUser.uid] || (userCache[currentUser.uid] = {});
    me.nameplate = me.nameplate || {};
    me.nameplate.text = text;
    paintPlatesIn(document);
    showToast("Plate text saved!");
  } catch (err) {
    console.error("Plate text save failed:", err);
    showToast("Couldn't save text", "error");
  }
}

async function buyPlateTheme(id, name, price) {
  const me = userCache[currentUser.uid] || {};
  if (!me.nameplate?.text) {
    showToast("Unlock your nameplate first (🪙1000)", "error");
    return;
  }
  try {
    const res = await runTransaction(ref(db, `users/${currentUser.uid}/coins`), (c) => {
      if ((c || 0) < price) return; // abort
      return c - price;
    });
    if (!res.committed) {
      showToast(`Need 🪙${price} for ${name} — play games to earn more!`, "error");
      return;
    }
    await update(ref(db, `users/${currentUser.uid}`), {
      [`plates/owned/${id}`]: true,
      "nameplate/theme": id
    });
    me.coins = res.snapshot.val() || 0;
    me.plates = me.plates || {};
    me.plates.owned = { ...(me.plates.owned || {}), [id]: true };
    me.nameplate.theme = id;
    plateDraftTheme = id;
    coinBalance = me.coins;
    paintPlatesIn(document);
    renderPlatesShop();
    showToast(`${name} plate equipped!`);
  } catch (err) {
    console.error("Plate buy failed:", err);
    showToast(`Couldn't buy theme (${err.code || err.message})`, "error");
  }
}

async function equipPlateTheme(id, name) {
  try {
    await update(ref(db, `users/${currentUser.uid}`), { "nameplate/theme": id });
    const me = userCache[currentUser.uid] || (userCache[currentUser.uid] = {});
    me.nameplate = me.nameplate || {};
    me.nameplate.theme = id;
    plateDraftTheme = id;
    paintPlatesIn(document);
    renderPlatesShop();
    showToast(`${name} plate equipped!`);
  } catch (err) {
    console.error("Plate equip failed:", err);
    showToast("Couldn't equip theme", "error");
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
    myRooms.add(newRoomRef.key);
    saveMyRooms();
    refreshRoomCard(newRoomRef.key);

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
    info.innerHTML = `<h5>${escapeHtml(data.username)} ${badges} ${plateHtml(id)}</h5><p>UID: ${escapeHtml(id.slice(0, 12))}... · 🪙 ${data.coins || 0}</p>`;
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
    // Coins can be granted to anyone, including yourself.
    if (isOwner && (!userIsOwner || isSelf)) {
      addBtn("Give Coins", "btn-ghost", () => window.__giveCoins(id, data.username));
    }
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
  paintFramesIn($("admin-user-list"));
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

window.__giveCoins = async (uid, username) => {
  if (!isOwner) {
    showToast("Only the owner can give coins", "error");
    return;
  }
  const raw = prompt(`How many coins to give ${username}?`, "100");
  if (raw === null) return;
  const amount = Math.floor(Number(raw));
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
    showToast("Enter a whole number between 1 and 100000", "error");
    return;
  }
  try {
    await runTransaction(ref(db, `users/${uid}/coins`), (c) => (c || 0) + amount);
    if (userCache[uid]) userCache[uid].coins = (userCache[uid].coins || 0) + amount;
    showToast(`Gave 🪙${amount} to ${username}`);
    loadAdminData();
  } catch (err) {
    console.error("Give coins failed:", err);
    showToast(`Couldn't give coins (${err.code || err.message})`, "error");
  }
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
// ============ ANNOUNCEMENTS TAB ============
let annListeners = [];

function closeAnnListeners() {
  annListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  annListeners = [];
}

function openAnnouncements() {
  closeAnnListeners();
  $("ann-messages").innerHTML = "";
  $("ann-form").classList.toggle("hidden", !isOwner);
  $("ann-readonly").classList.toggle("hidden", isOwner);
  localStorage.setItem("vibechat-ann-seen", String(Date.now()));
  $("ann-dot").classList.add("hidden");
  remove(ref(db, `mentions/${currentUser.uid}/announcements`)).catch(() => {});
  showScreen("announcements");
  const msgsRef = query(ref(db, "announcements/messages"), orderByChild("timestamp"), limitToLast(100));
  const addedCb = (snap) => appendAnnouncement(snap.key, snap.val());
  const removedCb = (snap) => {
    document.querySelector(`#ann-messages .message[data-msg-id="${snap.key}"]`)?.remove();
  };
  onChildAdded(msgsRef, addedCb);
  onChildRemoved(msgsRef, removedCb);
  annListeners.push({ ref: msgsRef, event: "child_added", cb: addedCb });
  annListeners.push({ ref: msgsRef, event: "child_removed", cb: removedCb });
}

function closeAnnouncements() {
  closeAnnListeners();
  $("ann-messages").innerHTML = "";
  // Everything here is now read — no stale dot on the way out
  localStorage.setItem("vibechat-ann-seen", String(Date.now()));
  $("ann-dot").classList.add("hidden");
  showScreen("lobby");
}

function appendAnnouncement(msgId, msg) {
  const container = $("ann-messages");
  if (!msg || container.querySelector(`[data-msg-id="${msgId}"]`)) return;
  const div = document.createElement("div");
  div.className = "message other";
  div.dataset.msgId = msgId;
  const isMsgAdmin = adminUids.has(msg.uid);
  const isMsgOwner = !isMsgAdmin && isOwnerName(msg.username);
  div.innerHTML = `
    <div class="message-header">
      <span class="avatar" data-uid="${escapeHtml(msg.uid)}" data-name="${escapeHtml(msg.username)}">${avatarInner(msg.username, (userCache[msg.uid] || {}).photoURL)}</span>
      <span class="message-username">${escapeHtml(msg.username)}</span>
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : isMsgOwner ? '<span class="message-admin-badge">OWNER</span>' : ""} ${plateHtml(msg.uid)}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${renderMessageText(msg.text, isOwnerName(msg.username))}</div>
  `;
  if (messageMentionsMe(msg)) div.classList.add("mentioned");
  if (isAdmin) {
    const header = div.querySelector(".message-header");
    const del = document.createElement("button");
    del.className = "msg-delete";
    del.title = "Delete announcement";
    del.textContent = "🗑️";
    del.addEventListener("click", () => {
      showConfirmModal(
        "Delete this announcement?",
        `<p style="color:var(--text-secondary)">${escapeHtml((msg.text || "").slice(0, 120))}</p>`,
        "Delete",
        () => remove(ref(db, `announcements/messages/${msgId}`))
      );
    });
    header.appendChild(del);
  }
  container.appendChild(div);
  paintFramesIn(div);
  container.scrollTop = container.scrollHeight;
}

async function updateAnnouncementsBadge() {
  try {
    if (!currentUser) return;
    const seen = Number(localStorage.getItem("vibechat-ann-seen") || 0);
    const [msgSnap, menSnap] = await Promise.all([
      get(query(ref(db, "announcements/messages"), orderByChild("timestamp"), limitToLast(1))),
      get(ref(db, `mentions/${currentUser.uid}/announcements`))
    ]);
    let latest = 0;
    msgSnap.forEach(s => {
      latest = Math.max(latest, s.val()?.timestamp || 0);
    });
    const hasMentions = menSnap.exists() && Object.keys(menSnap.val() || {}).length > 0;
    $("ann-dot").classList.toggle("hidden", !(latest > seen || hasMentions));
  } catch (err) {
    /* offline or no announcements yet — no badge */
  }
}

function initAnnouncements() {
  $("ann-btn").addEventListener("click", openAnnouncements);
  $("ann-back-btn").addEventListener("click", closeAnnouncements);
  $("ann-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isOwner || isBanned) return;
    const input = $("ann-input");
    const text = input.value.trim();
    if (!text) return;
    const annRef = await push(ref(db, "announcements/messages"), {
      uid: currentUser.uid,
      username: getUsername(),
      text: text,
      timestamp: serverTimestamp()
    });
    // Owner @everyone pings light up everyone's Announcements tab
    try {
      await Promise.all(extractMentionedUids(text, isOwner).map(uid =>
        set(ref(db, `mentions/${uid}/announcements/${annRef.key}`), {
          by: getUsername(),
          text: text.slice(0, 120),
          at: serverTimestamp()
        })
      ));
    } catch (err) {
      console.error("Announcement mention notify failed:", err);
    }
    input.value = "";
  });
}

// ============ BROWSER NOTIFICATIONS ============
// Foreground only (true background push needs a server). Fires for
// mentions and announcements while the app is open, even in another tab.
let notifListeners = [];
let notifStarted = false;
let notifiedKeys = new Set();
let roomCache = {};

function notifSupported() {
  return "Notification" in window;
}

function notifEnabled() {
  return notifSupported() && Notification.permission === "granted" &&
    localStorage.getItem("vibechat-notif-enabled") === "1";
}

function paintBell() {
  const bell = $("notif-bell");
  if (!bell) return;
  const on = notifEnabled();
  bell.textContent = on ? "🔔" : "🔕";
  bell.title = !notifSupported() ? "Notifications not supported in this browser"
    : Notification.permission === "denied" ? "Notifications blocked — allow them in browser site settings"
    : on ? "Notifications on (click to mute)" : "Notifications off (click to enable)";
}

function pushNotify(title, body, onClick) {
  if (!notifEnabled()) return;
  try {
    const n = new Notification(title, { body: body || "" });
    n.onclick = () => {
      window.focus();
      try { if (onClick) onClick(); } catch (e) {}
      n.close();
    };
  } catch (err) {
    console.error("Notify failed:", err);
  }
}

async function enableNotifications() {
  if (!notifSupported()) {
    showToast("This browser doesn't support notifications", "error");
    return;
  }
  if (Notification.permission === "denied") {
    showToast("Notifications are blocked — allow them in browser site settings", "error");
    return;
  }
  if (Notification.permission === "default") {
    const res = await Notification.requestPermission();
    localStorage.setItem("vibechat-notif-asked", "1");
    $("notif-banner").classList.add("hidden");
    if (res !== "granted") return;
  }
  localStorage.setItem("vibechat-notif-enabled", "1");
  paintBell();
  showToast("Notifications on");
  registerPushToken();
}

function toggleNotifications() {
  if (!notifSupported()) {
    showToast("This browser doesn't support notifications", "error");
    return;
  }
  if (Notification.permission !== "granted") {
    enableNotifications();
    return;
  }
  const on = notifEnabled();
  localStorage.setItem("vibechat-notif-enabled", on ? "0" : "1");
  paintBell();
  if (!on) {
    showToast("Notifications on");
    registerPushToken();
  } else {
    showToast("Notifications muted");
    if (currentUser) update(ref(db, `users/${currentUser.uid}`), { notifyEnabled: false }).catch(() => {});
  }
}

function handleMentionEvent(roomId, msgs) {
  const keys = Object.keys(msgs || {});
  const fresh = keys.filter(k => !notifiedKeys.has(`${roomId}/${k}`));
  fresh.forEach(k => notifiedKeys.add(`${roomId}/${k}`));
  if (!fresh.length) return;
  const latestKey = fresh.sort().pop();
  const m = msgs[latestKey];
  if (!m) return;
  const viewingChat = screens.chat.classList.contains("active") && currentRoomId === roomId;
  const viewingAnn = screens.announcements.classList.contains("active") && roomId === "announcements";
  if (viewingChat || viewingAnn) return;
  if (roomId === "announcements") {
    pushNotify("📢 Announcement", `${m.by}: ${m.text || ""}`, () => openAnnouncements());
  } else {
    const roomName = (roomCache[roomId] || {}).name || "a room";
    pushNotify("🔔 You were mentioned", `${m.by} in ${roomName}: ${m.text || ""}`, () => {
      const data = roomCache[roomId];
      if (data) handleJoinRoom(roomId, data);
    });
  }
}

async function startNotifListeners() {
  if (notifStarted || !currentUser) return;
  notifStarted = true;
  notifiedKeys = new Set();
  try {
    const [menSnap, annSnap] = await Promise.all([
      get(ref(db, `mentions/${currentUser.uid}`)),
      get(query(ref(db, "announcements/messages"), orderByChild("timestamp"), limitToLast(30)))
    ]);
    const men = menSnap.val() || {};
    for (const [roomId, msgs] of Object.entries(men)) {
      Object.keys(msgs || {}).forEach(k => notifiedKeys.add(`${roomId}/${k}`));
    }
    Object.keys(annSnap.val() || {}).forEach(k => notifiedKeys.add(`ann/${k}`));
  } catch (err) {
    /* offline — listeners still attach below */
  }
  const menRef = ref(db, `mentions/${currentUser.uid}`);
  const menAdded = (snap) => handleMentionEvent(snap.key, snap.val());
  const menChanged = (snap) => handleMentionEvent(snap.key, snap.val());
  onChildAdded(menRef, menAdded);
  onChildChanged(menRef, menChanged);
  notifListeners.push({ ref: menRef, event: "child_added", cb: menAdded });
  notifListeners.push({ ref: menRef, event: "child_changed", cb: menChanged });
  const annRef = query(ref(db, "announcements/messages"), orderByChild("timestamp"), limitToLast(30));
  const annAdded = (snap) => {
    if (notifiedKeys.has(`ann/${snap.key}`)) return;
    notifiedKeys.add(`ann/${snap.key}`);
    const msg = snap.val();
    if (!msg || msg.uid === currentUser.uid) return;
    if (screens.announcements.classList.contains("active")) return;
    pushNotify("📢 New announcement", `${msg.username}: ${(msg.text || "").slice(0, 120)}`, () => openAnnouncements());
    updateAnnouncementsBadge();
  };
  onChildAdded(annRef, annAdded);
  notifListeners.push({ ref: annRef, event: "child_added", cb: annAdded });
}

function stopNotifListeners() {
  notifListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  notifListeners = [];
  notifStarted = false;
  notifiedKeys = new Set();
}

// Registers this device for closed-browser push (FCM token → RTDB).
// Needs VAPID_KEY set in firebase-config.js. Safe to call repeatedly.
async function registerPushToken() {
  try {
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
    if (!VAPID_KEY || VAPID_KEY === "YOUR_VAPID_KEY") return;
    if (!currentUser || Notification.permission !== "granted") return;
    const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js");
    const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
    const token = await getToken(getMessaging(), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return;
    const snap = await get(ref(db, `pushTokens/${currentUser.uid}`));
    const exists = Object.values(snap.val() || {}).some(t => t.token === token);
    if (!exists) {
      await push(ref(db, `pushTokens/${currentUser.uid}`), { token, at: serverTimestamp() });
    }
    await update(ref(db, `users/${currentUser.uid}`), { notifyEnabled: true });
  } catch (err) {
    console.error("Push token registration failed:", err);
  }
}

function initNotifications() {
  $("notif-bell").addEventListener("click", toggleNotifications);
  $("notif-enable").addEventListener("click", enableNotifications);
  $("notif-dismiss").addEventListener("click", () => {
    localStorage.setItem("vibechat-notif-asked", "1");
    $("notif-banner").classList.add("hidden");
  });
  if (notifSupported() && Notification.permission === "default" && !localStorage.getItem("vibechat-notif-asked")) {
    $("notif-banner").classList.remove("hidden");
  }
  paintBell();
}

// ============ FRIENDS ============
function switchLobbyTab(which) {
  $("tab-rooms").classList.toggle("active", which === "rooms");
  $("tab-friends").classList.toggle("active", which === "friends");
  $("tab-dms").classList.toggle("active", which === "dms");
  $("room-list").classList.toggle("hidden", which !== "rooms");
  $("friends-panel").classList.toggle("hidden", which !== "friends");
  $("dms-panel").classList.toggle("hidden", which !== "dms");
}

function loadFriends() {
  friendListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  friendListeners = [];
  friendsPrimed = false;

  const reqRef = ref(db, `friendRequests/${currentUser.uid}`);
  const reqCb = (snap) => {
    const prev = new Set(Object.keys(requestsCache));
    requestsCache = snap.val() || {};
    renderFriends();
    // Notify for brand-new incoming requests (skip the initial prime)
    if (friendsPrimed) {
      for (const [fromUid, req] of Object.entries(requestsCache)) {
        if (!prev.has(fromUid)) {
          pushNotify("🤝 Friend request", `${req.username || "Someone"} wants to be friends`, () => {
            showScreen("lobby");
            switchLobbyTab("friends");
          });
        }
      }
    }
    friendsPrimed = true;
  };
  onValue(reqRef, reqCb);
  friendListeners.push({ ref: reqRef, event: "value", cb: reqCb });

  const frRef = ref(db, `friends/${currentUser.uid}`);
  const frCb = (snap) => {
    friendsCache = snap.val() || {};
    renderFriends();
  };
  onValue(frRef, frCb);
  friendListeners.push({ ref: frRef, event: "value", cb: frCb });
}

function stopFriends() {
  friendListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  friendListeners = [];
  friendsCache = {};
  requestsCache = {};
  friendsPrimed = false;
}

function friendRow(uid, username, buttons) {
  const item = document.createElement("div");
  item.className = "admin-item";
  const photo = (userCache[uid] || {}).photoURL;
  const display = userCache[uid]?.username || username;
  const av = document.createElement("span");
  av.className = "avatar";
  av.dataset.uid = uid;
  av.dataset.name = display;
  av.innerHTML = avatarInner(display, photo);
  item.appendChild(av);
  const info = document.createElement("div");
  info.className = "admin-item-info";
  info.innerHTML = `<h5>${escapeHtml(display)}</h5>`;
  item.appendChild(info);
  const actions = document.createElement("div");
  actions.className = "admin-item-actions";
  buttons.forEach(([label, cls, fn]) => {
    const b = document.createElement("button");
    b.className = `btn ${cls} btn-small`;
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    actions.appendChild(b);
  });
  item.appendChild(actions);
  return item;
}

function renderFriends() {
  const reqBox = $("friend-requests");
  const frBox = $("friend-list");
  if (!reqBox || !frBox) return;
  reqBox.innerHTML = "";
  frBox.innerHTML = "";

  const reqIds = Object.keys(requestsCache);
  const badge = $("friends-badge");
  badge.textContent = reqIds.length > 0 ? reqIds.length : "";
  badge.classList.toggle("hidden", reqIds.length === 0);

  if (!reqIds.length) {
    reqBox.innerHTML = '<p class="empty-state" style="padding:16px">No requests right now.</p>';
  } else {
    reqIds.forEach(fromUid => {
      const req = requestsCache[fromUid];
      reqBox.appendChild(friendRow(fromUid, req.username, [
        ["Accept", "btn-primary", () => acceptFriend(fromUid, req.username)],
        ["Decline", "btn-ghost", () => declineFriend(fromUid)]
      ]));
    });
  }

  const frIds = Object.keys(friendsCache);
  if (!frIds.length) {
    frBox.innerHTML = '<p class="empty-state" style="padding:16px">No friends yet — click any avatar to add one.</p>';
  } else {
    frIds.forEach(fid => {
      frBox.appendChild(friendRow(fid, friendsCache[fid].username, [
        ["Remove", "btn-ghost", () => removeFriend(fid, friendsCache[fid].username)]
      ]));
    });
  }
  paintFramesIn($("friends-panel"));
}

async function sendFriendRequest(uid, username) {
  try {
    await set(ref(db, `friendRequests/${uid}/${currentUser.uid}`), {
      username: getUsername(),
      at: serverTimestamp()
    });
    showToast(`Request sent to ${username}`);
    openProfileView(uid, username);
  } catch (err) {
    console.error("Friend request failed:", err);
    showToast(`Couldn't send request (${err.code || err.message})`, "error");
  }
}

async function acceptFriend(uid, username) {
  try {
    const me = getUsername();
    await set(ref(db, `friends/${currentUser.uid}/${uid}`), { username, at: serverTimestamp() });
    await set(ref(db, `friends/${uid}/${currentUser.uid}`), { username: me, at: serverTimestamp() });
    await remove(ref(db, `friendRequests/${currentUser.uid}/${uid}`));
    showToast(`You and ${username} are friends now`);
  } catch (err) {
    console.error("Accept failed:", err);
    showToast("Couldn't accept request", "error");
  }
}

async function declineFriend(uid) {
  await remove(ref(db, `friendRequests/${currentUser.uid}/${uid}`)).catch(() => {});
}

async function removeFriend(uid, username) {
  if (!confirm(`Remove ${username} from friends?`)) return;
  await remove(ref(db, `friends/${currentUser.uid}/${uid}`)).catch(() => {});
  await remove(ref(db, `friends/${uid}/${currentUser.uid}`)).catch(() => {});
  showToast("Friend removed");
}

// Friend action button inside the profile popup
async function renderFriendAction(uid, container) {
  container.innerHTML = "";
  if (!currentUser || uid === currentUser.uid) return;
  try {
    const [frSnap, inSnap, outSnap] = await Promise.all([
      get(ref(db, `friends/${currentUser.uid}/${uid}`)),
      get(ref(db, `friendRequests/${currentUser.uid}/${uid}`)),
      get(ref(db, `friendRequests/${uid}/${currentUser.uid}`))
    ]);
    const addBtn = (label, cls, fn, disabled) => {
      const b = document.createElement("button");
      b.className = `btn ${cls} btn-small`;
      b.textContent = label;
      if (disabled) b.disabled = true;
      else b.addEventListener("click", fn);
      container.appendChild(b);
    };
    const name = (userCache[uid] || {}).username || "them";
    if (frSnap.exists()) {
      addBtn("Remove Friend", "btn-ghost", () => removeFriend(uid, name).then(() => openProfileView(uid, name)));
    } else if (inSnap.exists()) {
      addBtn("Accept Request", "btn-primary", () => acceptFriend(uid, name).then(() => openProfileView(uid, name)));
    } else if (outSnap.exists()) {
      addBtn("Requested ✓", "btn-ghost", null, true);
    } else {
      addBtn("Add Friend", "btn-primary", () => sendFriendRequest(uid, name));
    }
  } catch (err) {
    console.error("Friend status failed:", err);
  }
}

// ============ DIRECT MESSAGES ============
let dmListListeners = [];
let dmViewListeners = [];
let dmIndex = {};
let dmUnreadCounts = {};
let dmSeen = {};
let dmPrimed = false;
let openDmId = null;
let openDmWith = null;
let dmTypingRef = null;

function dmIdFor(a, b) {
  return [a, b].sort().join("_");
}

function initLobbyTabs() {
  $("tab-rooms").onclick = () => switchLobbyTab("rooms");
  $("tab-friends").onclick = () => switchLobbyTab("friends");
  $("tab-dms").onclick = () => switchLobbyTab("dms");
}

function loadDmList() {
  dmListListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  dmListListeners = [];
  dmPrimed = false;

  const idxRef = ref(db, `myDms/${currentUser.uid}`);
  const idxCb = (snap) => {
    dmIndex = snap.val() || {};
    if (!dmPrimed) {
      dmPrimed = true;
      for (const [id, d] of Object.entries(dmIndex)) dmSeen[id] = d.updatedAt || 0;
    } else {
      for (const [id, d] of Object.entries(dmIndex)) {
        if ((d.updatedAt || 0) > (dmSeen[id] || 0) && id !== openDmId && d.lastByUid !== currentUser.uid) {
          pushNotify(`💬 ${d.withName}`, (d.lastText || "").slice(0, 120), () => openDM(d.withUid, d.withName));
        }
        dmSeen[id] = Math.max(dmSeen[id] || 0, d.updatedAt || 0);
      }
    }
    renderDmList();
  };
  onValue(idxRef, idxCb);
  dmListListeners.push({ ref: idxRef, event: "value", cb: idxCb });

  const unRef = ref(db, `dmUnread/${currentUser.uid}`);
  const unCb = (snap) => {
    dmUnreadCounts = snap.val() || {};
    renderDmList();
  };
  onValue(unRef, unCb);
  dmListListeners.push({ ref: unRef, event: "value", cb: unCb });
}

function renderDmList() {
  const box = $("dm-list");
  if (!box) return;
  box.innerHTML = "";
  const ids = Object.keys(dmIndex).sort((a, b) => (dmIndex[b].updatedAt || 0) - (dmIndex[a].updatedAt || 0));
  const total = Object.values(dmUnreadCounts).reduce((n, c) => n + (Number(c) || 0), 0);
  const badge = $("dms-badge");
  badge.textContent = total > 0 ? total : "";
  badge.classList.toggle("hidden", total === 0);
  if (!ids.length) {
    box.innerHTML = '<p class="empty-state" style="padding:16px">No conversations yet — click any avatar, then Message.</p>';
    return;
  }
  ids.forEach(id => {
    const d = dmIndex[id];
    const name = userCache[d.withUid]?.username || d.withName;
    const photo = (userCache[d.withUid] || {}).photoURL;
    const unread = Number(dmUnreadCounts[id]) || 0;
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `
      <span class="avatar" data-uid="${escapeHtml(d.withUid)}" data-name="${escapeHtml(name)}">${avatarInner(name, photo)}</span>
      <div class="admin-item-info">
        <h5>${escapeHtml(name)}</h5>
        <p class="dm-snippet">${escapeHtml((d.lastText || "").slice(0, 60))}</p>
      </div>
      <div class="admin-item-actions">
        ${unread > 0 ? `<span class="mention-badge">${unread}</span>` : ""}
      </div>`;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".avatar")) return; // avatar opens the profile popup instead
      openDM(d.withUid, name);
    });
    box.appendChild(item);
  });
  paintFramesIn(box);
}

async function openDM(withUid, withName) {
  closeDmViewListeners();
  openDmId = dmIdFor(currentUser.uid, withUid);
  openDmWith = { uid: withUid, name: withName };
  const photo = (userCache[withUid] || {}).photoURL;
  const av = $("dm-avatar");
  av.dataset.uid = withUid;
  av.dataset.name = withName;
  av.innerHTML = avatarInner(withName, photo);
  $("dm-name").textContent = withName;
  $("dm-messages").innerHTML = "";
  $("dm-typing").classList.add("hidden");
  showScreen("dm");
  // Mark read
  remove(ref(db, `dmUnread/${currentUser.uid}/${openDmId}`)).catch(() => {});
  dmSeen[openDmId] = Date.now();
  const dmId = openDmId;
  const msgsRef = query(ref(db, `dms/${dmId}/messages`), orderByChild("timestamp"), limitToLast(100));
  const addedCb = (snap) => appendDmMessage(snap.key, snap.val());
  const removedCb = (snap) => {
    document.querySelector(`#dm-messages .message[data-msg-id="${snap.key}"]`)?.remove();
  };
  onChildAdded(msgsRef, addedCb);
  onChildRemoved(msgsRef, removedCb);
  dmViewListeners.push({ ref: msgsRef, event: "child_added", cb: addedCb });
  dmViewListeners.push({ ref: msgsRef, event: "child_removed", cb: removedCb });
  setupDmTyping(dmId);
}

function appendDmMessage(msgId, msg) {
  if (!msg) return;
  const container = $("dm-messages");
  if (container.querySelector(`[data-msg-id="${msgId}"]`)) return;
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
      ${isMsgAdmin ? '<span class="message-admin-badge">ADMIN</span>' : isMsgOwner ? '<span class="message-admin-badge">OWNER</span>' : ""} ${plateHtml(msg.uid)}
      <span class="message-time">${formatTime(msg.timestamp)}</span>
    </div>
    <div class="message-bubble">${renderMessageText(msg.text, isOwnerName(msg.username))}</div>
  `;
  if (isOwn) {
    const del = document.createElement("button");
    del.className = "msg-delete";
    del.title = "Delete message";
    del.textContent = "🗑️";
    del.addEventListener("click", () => {
      showConfirmModal(
        "Delete this message?",
        `<p style="color:var(--text-secondary)">${escapeHtml((msg.text || "").slice(0, 120))}</p>`,
        "Delete",
        () => remove(ref(db, `dms/${openDmId}/messages/${msgId}`))
      );
    });
    div.querySelector(".message-header").appendChild(del);
  }
  container.appendChild(div);
  paintFramesIn(div);
  container.scrollTop = container.scrollHeight;
}

function setupDmTyping(dmId) {
  dmTypingRef = ref(db, `dms/${dmId}/typing/${currentUser.uid}`);
  const input = $("dm-input");
  input.oninput = () => {
    if (input.value.trim()) set(dmTypingRef, { username: getUsername() }).catch(() => {});
    else remove(dmTypingRef).catch(() => {});
  };
  const otherRef = ref(db, `dms/${dmId}/typing`);
  const cb = (snap) => {
    const typing = snap.val() || {};
    const names = Object.values(typing).map(t => t.username).filter(n => n && n !== getUsername());
    const indicator = $("dm-typing");
    if (names.length > 0) {
      indicator.textContent = `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing...`;
      indicator.classList.remove("hidden");
    } else {
      indicator.classList.add("hidden");
    }
  };
  onValue(otherRef, cb);
  dmViewListeners.push({ ref: otherRef, event: "value", cb });
}

function closeDmViewListeners() {
  dmViewListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  dmViewListeners = [];
  if (dmTypingRef) {
    remove(dmTypingRef).catch(() => {});
    dmTypingRef = null;
  }
}

function closeDM() {
  closeDmViewListeners();
  openDmId = null;
  openDmWith = null;
  $("dm-messages").innerHTML = "";
  showScreen("lobby");
}

function detachDmAll() {
  closeDmViewListeners();
  dmListListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  dmListListeners = [];
  openDmId = null;
  openDmWith = null;
  dmIndex = {};
  dmUnreadCounts = {};
  dmSeen = {};
  dmPrimed = false;
}

function initDM() {
  $("dm-back-btn").addEventListener("click", closeDM);
  $("dm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isBanned || !openDmId || !openDmWith) return;
    const input = $("dm-input");
    const text = input.value.trim();
    if (!text) return;
    const dmId = openDmId;
    const them = openDmWith.uid;
    await push(ref(db, `dms/${dmId}/messages`), {
      uid: currentUser.uid,
      username: getUsername(),
      text: text,
      timestamp: serverTimestamp()
    });
    const preview = text.slice(0, 80);
    update(ref(db, `myDms/${currentUser.uid}/${dmId}`), {
      withUid: them, withName: openDmWith.name, lastText: preview,
      lastByUid: currentUser.uid, updatedAt: serverTimestamp()
    }).catch(() => {});
    update(ref(db, `myDms/${them}/${dmId}`), {
      withUid: currentUser.uid, withName: getUsername(), lastText: preview,
      lastByUid: currentUser.uid, updatedAt: serverTimestamp()
    }).catch(() => {});
    runTransaction(ref(db, `dmUnread/${them}/${dmId}`), (c) => (Number(c) || 0) + 1).catch(() => {});
    input.value = "";
    if (dmTypingRef) remove(dmTypingRef).catch(() => {});
  });
}

// ============ NAVIGATION ============
function initNavigation() {
  $("back-btn").addEventListener("click", leaveRoom);

  $("profile-btn").addEventListener("click", openProfileModal);

  // Click any avatar/username to view that user's profile
  document.addEventListener("click", (e) => {
    if (e.target.closest("#mention-menu")) return;
    const av = e.target.closest(".avatar[data-uid]");
    if (av && av.dataset.uid) {
      openProfileView(av.dataset.uid, av.dataset.name);
      return;
    }
    const nm = e.target.closest(".message-username");
    if (nm) {
      const avEl = nm.closest(".message-header")?.querySelector(".avatar[data-uid]");
      if (avEl && avEl.dataset.uid) openProfileView(avEl.dataset.uid, nm.textContent);
    }
  });

  $("close-room-btn").addEventListener("click", () => {
    if (!currentRoomId) return;
    showConfirmModal(
      `Close "${currentRoom?.name}"?`,
      `<p style="color:var(--text-secondary)">This deletes the room and all its messages for everyone. This can't be undone.</p>`,
      "Delete Room",
      async () => {
        const roomId = currentRoomId;
        myRooms.delete(roomId);
        saveMyRooms();
        clearRoomPw(roomId);
        leaveRoom();
        await remove(ref(db, `rooms/${roomId}`));
        showToast("Room closed");
      }
    );
  });

  $("leave-room-btn").addEventListener("click", leaveRoomForGood);
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
  initAnnouncements();
  initNotifications();
  initLobbyTabs();
  initDM();
});

function initGamesUI() {
  initGames();
  window.addEventListener("vibechat-coins", (e) => showToast(`+${e.detail} 🪙`, "success", 2000));
  $("games-btn").addEventListener("click", () => showScreen("games"));
  $("games-back-btn").addEventListener("click", () => {
    closeGame();
    showScreen("lobby");
  });
}
