# VibeChat

A chill real-time chat room app. Deployed on GitHub Pages, powered by Firebase.

## Features

- Username + password accounts (Firebase Auth)
- Multiple rooms — create public or password-protected rooms
- Real-time messaging with message history
- Online users list (presence)
- Emoji picker + rich text (auto-linked URLs)
- Dark mode UI
- Admin panel for mods/devs (delete rooms/messages, manage admins)

## Local Dev

1. Clone the repo
2. Open `js/firebase-config.js` and paste your Firebase project keys
3. Open `index.html` in a browser (or use `npx serve`)

## Deploy to GitHub Pages

1. Push to the `main` branch
2. Go to **Settings → Pages** → Source: **GitHub Actions**
3. The deploy workflow runs automatically on every push

## Firebase Setup

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Authentication** → Enable **Email/Password**
3. **Realtime Database** → Create database
4. Add your web app → copy config to `js/firebase-config.js`
5. Add your UID to `ADMIN_UIDS` in `firebase-config.js` for admin access

## Admin Access

Add your Firebase Auth UID to the `ADMIN_UIDS` array in `js/firebase-config.js`. Find your UID in Firebase Console → Authentication → Users.
