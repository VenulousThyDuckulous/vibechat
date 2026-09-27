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

// Admin UIDs — add your Firebase Auth UID here for admin access.
// Find it in Firebase Console → Authentication → Users.
const ADMIN_UIDS = [
  // "your-admin-uid-here"
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { app, auth, db, ADMIN_UIDS };
