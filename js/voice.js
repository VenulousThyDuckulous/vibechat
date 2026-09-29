// ============================================================
//  VibeChat Voice — WebRTC mesh with Firebase RTDB signaling.
//  Free STUN only (no TURN server), so symmetric-NAT users may fail.
//  Best with ~6 or fewer people per room (mesh bandwidth).
// ============================================================

import { db, auth, ADMIN_UIDS, OWNER_USERNAMES } from "./firebase-config.js";
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
  off
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const ICE_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const SPEAK_THRESHOLD = 18; // analyser RMS level that counts as talking

let lobbyListeners = [];
let lobbyStarted = false;
let roomCache = {};

// User directory for tiles (photos, badges, plates, frames).
// Refreshed on join; app.js owns the live copy for chat.
let dirCache = {};
let dirAdmins = new Set(ADMIN_UIDS);

// Active call state (null when not in a voice room)
let call = null;

function myUid() {
  return auth.currentUser?.uid || null;
}

function myName() {
  return localStorage.getItem("vibechat-username") || "user";
}

// ============ LOBBY (list + create) ============
export function initVoiceTab() {
  document.getElementById("create-voice-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("voice-room-name");
    const name = input.value.trim();
    if (!name || !myUid()) return;
    const newRef = push(ref(db, "voiceRooms"));
    await set(newRef, {
      name,
      createdBy: myUid(),
      createdByName: myName(),
      createdAt: serverTimestamp()
    });
    input.value = "";
  });
}

export function startVoiceLobby() {
  if (lobbyStarted || !myUid()) return;
  lobbyStarted = true;
  const roomsRef = ref(db, "voiceRooms");
  const addedCb = (snap) => {
    roomCache[snap.key] = snap.val();
    renderVoiceRooms();
  };
  const removedCb = (snap) => {
    delete roomCache[snap.key];
    renderVoiceRooms();
  };
  const changedCb = (snap) => {
    roomCache[snap.key] = snap.val();
    renderVoiceRooms();
  };
  onChildAdded(roomsRef, addedCb);
  onChildRemoved(roomsRef, removedCb);
  onChildChanged(roomsRef, changedCb);
  lobbyListeners.push(
    { ref: roomsRef, event: "child_added", cb: addedCb },
    { ref: roomsRef, event: "child_removed", cb: removedCb },
    { ref: roomsRef, event: "child_changed", cb: changedCb }
  );
  // One lightweight listener gives live headcounts for every room
  const peersRef = ref(db, "voicePeers");
  const peersCb = () => renderVoiceRooms();
  onValue(peersRef, peersCb);
  lobbyListeners.push({ ref: peersRef, event: "value", cb: peersCb });
}

export function stopVoiceLobby() {
  lobbyListeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  lobbyListeners = [];
  lobbyStarted = false;
  roomCache = {};
}

async function peerCounts() {
  try {
    const snap = await get(ref(db, "voicePeers"));
    const counts = {};
    for (const [roomId, peers] of Object.entries(snap.val() || {})) {
      counts[roomId] = Object.keys(peers || {}).length;
    }
    return counts;
  } catch (err) {
    return {};
  }
}

async function renderVoiceRooms() {
  const box = document.getElementById("voice-room-list");
  if (!box) return;
  const counts = await peerCounts();
  box.innerHTML = "";
  const ids = Object.keys(roomCache);
  if (!ids.length) {
    box.innerHTML = '<p class="empty-state" style="padding:16px">No voice rooms — create one!</p>';
    return;
  }
  ids.forEach(id => {
    const data = roomCache[id];
    const n = counts[id] || 0;
    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-info">
        <h4>${escapeHtml(data.name)}</h4>
        <p>🔊 Voice · ${n} inside</p>
      </div>
      <span class="room-card-badge">🔊</span>
    `;
    card.addEventListener("click", () => joinVoiceRoom(id, data.name));
    box.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function refreshDirectory() {
  try {
    const [uSnap, aSnap] = await Promise.all([
      get(ref(db, "users")),
      get(ref(db, "admins"))
    ]);
    dirCache = uSnap.val() || {};
    const admins = aSnap.val() || {};
    dirAdmins = new Set([...ADMIN_UIDS, ...Object.keys(admins).filter(k => admins[k] === true)]);
  } catch (err) {
    /* offline — keep whatever we have */
  }
}

function dirIsOwner(name) {
  return OWNER_USERNAMES.some(o => o.toLowerCase() === (name || "").toLowerCase());
}

function dirHue(name) {
  let h = 0;
  for (const c of (name || "?")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// Full tile content (avatar photo, badges, plate, frame). The live
// voice-state line (muted/sharing) is preserved across repaints.
function paintTileContent(tile, uid, fallbackName, isSelf) {
  const p = dirCache[uid] || {};
  const display = p.username || fallbackName;
  const photo = p.photoURL || null;
  const avatar = photo
    ? `<img src="${escapeHtml(photo)}" alt="" />`
    : `<span class="avatar-initial" style="background:hsl(${dirHue(display)},45%,45%)">${escapeHtml((display || "?").trim().charAt(0).toUpperCase())}</span>`;
  const isAdmin = dirAdmins.has(uid);
  const isOwner = !isAdmin && dirIsOwner(display);
  const badges = isAdmin ? '<span class="message-admin-badge">ADMIN</span>'
    : isOwner ? '<span class="message-admin-badge">OWNER</span>' : "";
  const np = p.nameplate;
  const plate = np?.text ? `<span class="plate plate-${np.theme || "classic"}">${escapeHtml(np.text.slice(0, 16))}</span>` : "";
  const frame = p.equippedFrame ? ` frame-${p.equippedFrame}` : "";
  const prevState = tile.querySelector(".voice-state")?.textContent || "";
  tile.innerHTML = `
    <span class="avatar${frame}" data-voice-avatar="${escapeHtml(uid)}">${avatar}</span>
    <span class="voice-name">${escapeHtml(display)}${isSelf ? " (you)" : ""} ${badges} ${plate}</span>
    <span class="voice-state">${escapeHtml(prevState)}</span>
  `;
}

function repaintTile(uid) {
  const tile = document.getElementById("voice-tiles")?.querySelector(`[data-voice-uid="${uid}"]`);
  if (!tile || !call) return;
  const entry = call.peers[uid];
  paintTileContent(tile, uid, entry?.name || tile.dataset.voiceName || "user", uid === call.uid);
}

// ============ CALL ============
export function inVoiceCall() {
  return !!call;
}

export async function joinVoiceRoom(roomId, roomName) {
  if (call) leaveVoiceRoom();
  const uid = myUid();
  if (!uid) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error("Mic unavailable:", err);
    const showToast = window.__toast || ((m) => alert(m));
    showToast("Microphone blocked — allow mic access to join voice.");
    return;
  }

  const joinedAt = Date.now();
  call = {
    roomId,
    uid,
    joinedAt,
    stream,
    peers: {}, // uid -> { pc, audio, analyser, screenStream, name, tile, pending }
    roster: {}, // uid -> roster data (username, muted, sharing, joinedAt)
    listeners: [],
    muted: false,
    deafened: false,
    analyser: null,
    screenStream: null,
    screenTrack: null,
    stageUid: null,
    raf: 0,
    alive: true
  };

  document.getElementById("voice-room-name").textContent = roomName;
  document.getElementById("voice-mute-btn").textContent = "🔊 Unmuted";
  document.getElementById("voice-deafen-btn").textContent = "👂 Hearing";
  document.getElementById("voice-tiles").innerHTML = "";
  paintShareBtn();
  await refreshDirectory();
  if (!call || !call.alive) return;
  addTile(uid, myName(), true);
  showVoiceScreen();
  paintVoiceClose(roomId);

  // Roster first so others see us even if signaling lags.
  // Auto-removed if the tab crashes or the network drops.
  await set(ref(db, `voicePeers/${roomId}/${uid}`), {
    username: myName(),
    muted: false,
    sharing: false,
    joinedAt
  });
  onDisconnect(ref(db, `voicePeers/${roomId}/${uid}`)).remove().catch(() => {});

  // Signals listener BEFORE sending offers (answers can come back fast)
  const sigRef = ref(db, `voiceSignals/${roomId}/${uid}`);
  const sigCb = (snap) => handleSignal(snap.key, snap.val());
  onChildAdded(sigRef, sigCb);
  call.listeners.push({ ref: sigRef, event: "child_added", cb: sigCb });

  // Offer to everyone already here (they're older, so no glare)
  try {
    const snap = await get(ref(db, `voicePeers/${roomId}`));
    for (const [peerUid, peer] of Object.entries(snap.val() || {})) {
      if (peerUid === uid) continue;
      call.roster[peerUid] = peer;
      if (shouldOfferTo(joinedAt, uid, peer.joinedAt || 0, peerUid)) {
        await makeOffer(peerUid, peer.username || "user");
      }
    }
  } catch (err) {
    console.error("Roster read failed:", err);
  }

  // Roster changes: offer to genuine newcomers, drop leavers, track state
  const rosterRef = ref(db, `voicePeers/${roomId}`);
  const rosterAdded = async (snap) => {
    if (!call || snap.key === uid || call.peers[snap.key]) return;
    const peer = snap.val() || {};
    call.roster[snap.key] = peer;
    if (!dirCache[snap.key]) {
      await refreshDirectory();
      if (!call) return;
    }
    if (shouldOfferTo(joinedAt, uid, peer.joinedAt || 0, snap.key)) {
      try { await makeOffer(snap.key, peer.username || "user"); }
      catch (err) { console.error("Offer failed:", err); }
    }
    // Otherwise they offer to us; their offer handler builds the tile
    // from the directory we just refreshed.
  };
  const rosterRemoved = (snap) => {
    if (call) delete call.roster[snap.key];
    if (snap.key !== uid) destroyPeer(snap.key);
  };
  const rosterChanged = (snap) => {
    if (!call || snap.key === uid) return;
    const peer = snap.val() || {};
    call.roster[snap.key] = peer;
    repaintTile(snap.key);
    const entry = call.peers[snap.key];
    if (entry?.tile) {
      const stateEl = entry.tile.querySelector(".voice-state");
      if (stateEl) stateEl.textContent = peer.muted ? "🔇" : (peer.sharing ? "🖥️ sharing" : "");
    }
    refreshStage();
  };
  onChildAdded(rosterRef, rosterAdded);
  onChildRemoved(rosterRef, rosterRemoved);
  onChildChanged(rosterRef, rosterChanged);
  call.listeners.push(
    { ref: rosterRef, event: "child_added", cb: rosterAdded },
    { ref: rosterRef, event: "child_removed", cb: rosterRemoved },
    { ref: rosterRef, event: "child_changed", cb: rosterChanged }
  );

  // Bounce if the room itself is deleted
  const roomRef = ref(db, `voiceRooms/${roomId}`);
  const roomCb = (snap) => {
    if (!snap.exists() && call && call.roomId === roomId) {
      leaveVoiceRoom();
      const showToast = window.__toast || (() => {});
      showToast("Voice room was closed", "error");
    }
  };
  onValue(roomRef, roomCb);
  call.listeners.push({ ref: roomRef, event: "value", cb: roomCb });

  // Speaking indicators
  call.analyser = makeAnalyser(stream);
  speakLoop();

  // Creator/admins can close the room
  paintVoiceClose(roomId);
}

// Newcomer offers; deterministic tie-break so both sides never offer at once
function shouldOfferTo(myTs, myUid, theirTs, theirUid) {
  if (myTs !== theirTs) return myTs > theirTs;
  return myUid > theirUid;
}

async function makeOffer(peerUid, peerName) {
  const pc = createPeer(peerUid, peerName);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await push(ref(db, `voiceSignals/${call.roomId}/${peerUid}`), {
    from: call.uid,
    fromName: myName(),
    type: "offer",
    sdp: offer.sdp
  });
}

function createPeer(peerUid, peerName) {
  destroyPeer(peerUid);
  const pc = new RTCPeerConnection(ICE_CONFIG);
  for (const track of call.stream.getTracks()) pc.addTrack(track, call.stream);
  const entry = { pc, audio: null, analyser: null, name: peerName, tile: null, pending: [] };
  call.peers[peerUid] = entry;
  entry.tile = addTile(peerUid, peerName, false);

  pc.onicecandidate = (e) => {
    if (e.candidate && call && call.alive) {
      push(ref(db, `voiceSignals/${call.roomId}/${peerUid}`), {
        from: call.uid,
        fromName: myName(),
        type: "candidate",
        candidate: e.candidate.toJSON()
      }).catch(() => {});
    }
  };
  pc.ontrack = (e) => {
    const track = e.track;
    if (track && track.kind === "video") {
      // Screen share stream — show it on the stage
      entry.screenStream = e.streams[0] || null;
      track.onmute = () => refreshStage();
      track.onunmute = () => refreshStage();
      track.onended = () => refreshStage();
      refreshStage();
      return;
    }
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.srcObject = e.streams[0];
    document.getElementById("voice-tiles").appendChild(audio);
    entry.audio = audio;
    entry.analyser = makeAnalyser(e.streams[0]);
    applyDeafen();
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) destroyPeer(peerUid);
  };
  return pc;
}

async function handleSignal(sid, sig) {
  if (!call || !call.alive || !sig) return;
  const from = sig.from;
  // Delete first so redeliveries can't double-handle
  remove(ref(db, `voiceSignals/${call.roomId}/${call.uid}/${sid}`)).catch(() => {});
  try {
    if (sig.type === "offer") {
      // Reuse the live connection when this is a renegotiation (screen share),
      // otherwise build a fresh peer connection.
      let entry = call.peers[from];
      let pc;
      if (entry && entry.pc.signalingState !== "closed") {
        pc = entry.pc;
        entry.name = sig.fromName || entry.name;
      } else {
        pc = createPeer(from, sig.fromName || "user");
        entry = call.peers[from];
      }
      await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
      if (!pc.getSenders().some(s => s.track && s.track.kind === "audio")) {
        for (const track of call.stream.getTracks()) pc.addTrack(track, call.stream);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await push(ref(db, `voiceSignals/${call.roomId}/${from}`), {
        from: call.uid,
        fromName: myName(),
        type: "answer",
        sdp: answer.sdp
      });
      flushPending(from);
    } else if (sig.type === "answer") {
      const entry = call.peers[from];
      if (entry && entry.pc.signalingState !== "stable") {
        await entry.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
        flushPending(from);
      }
    } else if (sig.type === "candidate") {
      const entry = call.peers[from];
      if (!entry) return;
      const cand = new RTCIceCandidate(sig.candidate);
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(cand);
      else entry.pending.push(cand);
    }
  } catch (err) {
    console.error("Signal handling failed:", err);
  }
}

async function flushPending(peerUid) {
  const entry = call?.peers[peerUid];
  if (!entry) return;
  for (const cand of entry.pending.splice(0)) {
    try { await entry.pc.addIceCandidate(cand); } catch (e) { /* stale */ }
  }
}

function destroyPeer(peerUid) {
  if (!call) return;
  const entry = call.peers[peerUid];
  if (!entry) return;
  try { entry.pc.close(); } catch (e) {}
  if (entry.audio) entry.audio.remove();
  if (entry.tile) entry.tile.remove();
  delete call.peers[peerUid];
  delete call.roster[peerUid];
  if (call.stageUid === peerUid) refreshStage();
}

// ============ SCREEN SHARING ============
async function renegotiate(peerUid) {
  const entry = call?.peers[peerUid];
  if (!entry || !call.alive) return;
  if (entry.pc.signalingState !== "stable") {
    setTimeout(() => {
      if (call?.alive) renegotiate(peerUid).catch(() => {});
    }, 600);
    return;
  }
  try {
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    await push(ref(db, `voiceSignals/${call.roomId}/${peerUid}`), {
      from: call.uid,
      fromName: myName(),
      type: "offer",
      sdp: offer.sdp
    });
  } catch (err) {
    console.error("Renegotiation failed:", err);
  }
}

function paintShareBtn() {
  const btn = document.getElementById("voice-share-btn");
  if (btn) btn.textContent = call?.screenTrack ? "⏹️ Sharing" : "🖥️ Share";
}

export async function toggleShare() {
  if (!call || !call.alive) return;
  if (call.screenTrack) {
    stopShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    const showToast = window.__toast || (() => {});
    showToast("Screen sharing isn't supported in this browser.", "error");
    return;
  }
  let screen;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    return; // user cancelled the picker
  }
  if (!call || !call.alive) {
    try { screen.getTracks().forEach(t => t.stop()); } catch (e) {}
    return;
  }
  const track = screen.getVideoTracks()[0];
  if (!track) {
    try { screen.getTracks().forEach(t => t.stop()); } catch (e) {}
    return;
  }
  call.screenStream = screen;
  call.screenTrack = track;
  track.onended = () => {
    if (call?.screenTrack === track) stopShare();
  };
  for (const peerUid of Object.keys(call.peers)) {
    try {
      call.peers[peerUid].pc.addTrack(track, screen);
    } catch (err) {
      console.error("Share addTrack failed:", err);
    }
  }
  update(ref(db, `voicePeers/${call.roomId}/${call.uid}`), { sharing: true }).catch(() => {});
  for (const peerUid of Object.keys(call.peers)) renegotiate(peerUid).catch(() => {});
  refreshStage();
  paintShareBtn();
}

function stopShare() {
  if (!call) return;
  const track = call.screenTrack;
  call.screenTrack = null;
  if (call.screenStream) {
    try { call.screenStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    call.screenStream = null;
  }
  if (track) {
    for (const peerUid of Object.keys(call.peers)) {
      const entry = call.peers[peerUid];
      try {
        const sender = entry.pc.getSenders().find(s => s.track === track);
        if (sender) entry.pc.removeTrack(sender);
      } catch (e) { /* already gone */ }
      renegotiate(peerUid).catch(() => {});
    }
  }
  update(ref(db, `voicePeers/${call.roomId}/${call.uid}`), { sharing: false }).catch(() => {});
  refreshStage();
  paintShareBtn();
}

// Stage shows my screen first, otherwise the latest sharing peer
function refreshStage() {
  const stage = document.getElementById("voice-stage");
  const video = document.getElementById("voice-stage-video");
  const label = document.getElementById("voice-stage-label");
  if (!call || !call.alive || !stage || !video) return;
  if (call.screenTrack && call.screenStream) {
    if (video.srcObject !== call.screenStream) video.srcObject = call.screenStream;
    if (label) label.textContent = `${myName()} (you)`;
    stage.classList.remove("hidden");
    call.stageUid = call.uid;
    return;
  }
  let pick = null;
  for (const [peerUid, entry] of Object.entries(call.peers)) {
    if (call.roster[peerUid]?.sharing && entry.screenStream) pick = { uid: peerUid, entry };
  }
  if (pick) {
    if (video.srcObject !== pick.entry.screenStream) video.srcObject = pick.entry.screenStream;
    if (label) label.textContent = pick.entry.name || "Someone";
    stage.classList.remove("hidden");
    call.stageUid = pick.uid;
  } else {
    video.srcObject = null;
    stage.classList.add("hidden");
    call.stageUid = null;
  }
}

// ============ UI ============
function showVoiceScreen() {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById("voice-screen").classList.add("active");
}

function paintVoiceClose(roomId) {
  // Visibility + action provided by app.js (it knows admin status)
  const btn = document.getElementById("voice-close-btn");
  const createdBy = roomCache[roomId]?.createdBy;
  const can = window.__canCloseVoice ? window.__canCloseVoice(roomId, createdBy) : false;
  btn.classList.toggle("hidden", !can);
  btn.onclick = () => window.__closeVoiceRoom && window.__closeVoiceRoom(roomId);
}

function addTile(uid, name, isSelf) {
  const tiles = document.getElementById("voice-tiles");
  const old = tiles.querySelector(`[data-voice-uid="${uid}"]`);
  if (old) old.remove();
  const tile = document.createElement("div");
  tile.className = "voice-tile";
  tile.dataset.voiceUid = uid;
  tile.dataset.voiceName = name;
  tiles.appendChild(tile);
  paintTileContent(tile, uid, name, isSelf);
  const entry = call?.peers[uid];
  if (entry) entry.tile = tile;
  return tile;
}

function makeAnalyser(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    return { ctx, analyser };
  } catch (err) {
    return null;
  }
}

function levelOf(a) {
  if (!a) return 0;
  const buf = new Uint8Array(a.analyser.fftSize);
  a.analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length) * 100;
}

function speakLoop() {
  if (!call || !call.alive) return;
  const tiles = document.getElementById("voice-tiles");
  const selfTile = tiles.querySelector(`[data-voice-uid="${call.uid}"]`);
  if (selfTile) selfTile.classList.toggle("speaking", !call.muted && !call.deafened && levelOf(call.analyser) > SPEAK_THRESHOLD);
  for (const [uid, entry] of Object.entries(call.peers)) {
    const tile = entry.tile || tiles.querySelector(`[data-voice-uid="${uid}"]`);
    if (tile) tile.classList.toggle("speaking", levelOf(entry.analyser) > SPEAK_THRESHOLD);
  }
  call.raf = requestAnimationFrame(speakLoop);
}

function applyDeafen() {
  if (!call) return;
  const tiles = document.getElementById("voice-tiles");
  for (const entry of Object.values(call.peers)) {
    if (entry.audio) entry.audio.muted = call.deafened;
  }
  void tiles;
}

function refreshControls() {
  if (!call) return;
  document.getElementById("voice-mute-btn").textContent = call.muted || call.deafened ? "🔇 Muted" : "🔊 Unmuted";
  document.getElementById("voice-deafen-btn").textContent = call.deafened ? "🔇 Deafened" : "👂 Hearing";
}

export function toggleMute() {
  if (!call) return;
  call.muted = !call.muted;
  applyMicState();
}

export function toggleDeafen() {
  if (!call) return;
  call.deafened = !call.deafened;
  if (call.deafened) call.muted = true;
  applyMicState();
  applyDeafen();
}

function applyMicState() {
  if (!call) return;
  const off = call.muted || call.deafened;
  for (const track of call.stream.getTracks()) track.enabled = !off;
  update(ref(db, `voicePeers/${call.roomId}/${call.uid}`), { muted: off }).catch(() => {});
  refreshControls();
  const tiles = document.getElementById("voice-tiles");
  const selfTile = tiles.querySelector(`[data-voice-uid="${call.uid}"]`);
  if (selfTile) selfTile.querySelector(".voice-state").textContent = off ? "🔇" : "";
}

export function leaveVoiceRoom() {
  if (!call) return;
  const { roomId, uid, stream, listeners } = call;
  call.alive = false;
  cancelAnimationFrame(call.raf);
  listeners.forEach(({ ref: r, event, cb }) => { try { off(r, event, cb); } catch (e) {} });
  for (const peerUid of Object.keys(call.peers)) destroyPeer(peerUid);
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch (e) {}
  try {
    if (call.screenStream) call.screenStream.getTracks().forEach(t => t.stop());
  } catch (e) {}
  remove(ref(db, `voicePeers/${roomId}/${uid}`)).catch(() => {});
  remove(ref(db, `voiceSignals/${roomId}/${uid}`)).catch(() => {});
  call = null;
  document.getElementById("voice-tiles").innerHTML = "";
  const stage = document.getElementById("voice-stage");
  if (stage) stage.classList.add("hidden");
  const video = document.getElementById("voice-stage-video");
  if (video) video.srcObject = null;
  paintShareBtn();
}
