// ============================================================
//  Firebase Config — paste your project's keys here
//  Firebase Console → Project Settings → Your apps → Web app
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyABcRHJYvAV75pQAieSzL5vTBTD52r8kRM",
  authDomain: "vibechat-a2d59.firebaseapp.com",
  databaseURL: "https://vibechat-a2d59-default-rtdb.firebaseio.com",
  projectId: "vibechat-a2d59",
  storageBucket: "vibechat-a2d59.firebasestorage.app",
  messagingSenderId: "1094675039349",
  appId: "1:1094675039349:web:64a3a3a22d46d93df2a43c"
};

// Admin UIDs — add Firebase Auth UIDs here for admin access.
// Find them in Firebase Console → Authentication → Users.
const ADMIN_UIDS = [
  // "your-admin-uid-here"
];

// Owner usernames — full access (admin panel + owner badge).
// Matched case-insensitively against the profile username.
const OWNER_USERNAMES = [
  "VenulousRG"
];

// Web Push (VAPID) key for background notifications — free, generate at:
// Firebase Console → Project settings → Cloud Messaging → Web Push certificates
const VAPID_KEY = "BO4_Vl4EIk3rInui70Epl_-Nq713sh4wvHdcTgDX-f47ohGu7xgWmeJBx9sW-CdczzbVFGMJtLaDA1egrsF1uVs";

// Giphy API key for the GIF picker — paste the key your friend sent you here.
// Until set, the GIF button shows a setup hint.
const GIPHY_API_KEY = "SsQEuKTZngEzv7PNVB6f7ZXjDGDU73rq";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { app, auth, db, ADMIN_UIDS, OWNER_USERNAMES, VAPID_KEY, GIPHY_API_KEY };
