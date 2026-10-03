// Builds a portable auto-updating Windows exe via electron-builder.
// Run: npm run dist  →  dist/VibeChat <version>.exe + dist/latest.yml
const eb = require("electron-builder");
const buildFn = eb.build || (eb.default && eb.default.build) || eb;
if (typeof buildFn !== "function") {
  throw new Error("electron-builder API not found: " + Object.keys(eb).join(","));
}

buildFn({
  config: {
    appId: "com.venulous.vibechat",
    productName: "VibeChat",
    directories: { output: "dist" },
    files: [
      "package.json",
      "main.cjs",
      "index.html",
      "manifest.json",
      "404.html",
      "firebase-messaging-sw.js",
      "css/**/*",
      "js/**/*",
      "icons/**/*"
    ],
    win: { target: [{ target: "portable", arch: ["x64"] }] },
    portable: { artifactName: "VibeChat-${version}.exe" },
    publish: [{ provider: "github", owner: "VenulousThyDuckulous", repo: "vibechat" }]
  }
}).then((paths) => {
  console.log("Built:", paths);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
