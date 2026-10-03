// Copies the static site into www/ for Capacitor builds.
// Run: npm run cap:sync-www
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "www");
const entries = [
  "index.html",
  "manifest.json",
  "404.html",
  "firebase-messaging-sw.js",
  "css",
  "js",
  "icons"
];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const e of entries) {
  fs.cpSync(path.join(root, e), path.join(out, e), { recursive: true });
}
console.log("www synced");
