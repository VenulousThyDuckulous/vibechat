// Builds a portable auto-updating Windows exe via electron-builder.
// Run: npm run dist  →  dist/VibeChat <version>.exe + dist/latest.yml
const eb = require("electron-builder");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const buildFn = eb.build || (eb.default && eb.default.build) || eb;
if (typeof buildFn !== "function") {
  throw new Error("electron-builder API not found: " + Object.keys(eb).join(","));
}

async function main() {
  await buildFn({
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
      win: { icon: "icons/app.ico", target: [{ target: "portable", arch: ["x64"] }] },
      portable: { artifactName: "VibeChat-${version}.exe" },
      publish: [{ provider: "github", owner: "VenulousThyDuckulous", repo: "vibechat" }]
    }
  });

  // electron-builder doesn't emit update metadata for portable targets,
  // so write latest.yml ourselves in the exact format electron-updater
  // expects from the GitHub provider.
  const version = require("./package.json").version;
  const exeName = `VibeChat-${version}.exe`;
  const exePath = path.join("dist", exeName);
  const buf = fs.readFileSync(exePath);
  const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
  const yml = [
    `version: ${version}`,
    "files:",
    `  - url: ${exeName}`,
    `    sha512: ${sha512}`,
    `    size: ${buf.length}`,
    `path: ${exeName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ""
  ].join("\n");
  fs.writeFileSync(path.join("dist", "latest.yml"), yml);

  // Self-verify: re-read and confirm the hash matches the exe on disk.
  const checkHash = crypto.createHash("sha512").update(fs.readFileSync(exePath)).digest("base64");
  const written = fs.readFileSync(path.join("dist", "latest.yml"), "utf8");
  if (checkHash !== sha512 || !written.includes(`version: ${version}`)) {
    throw new Error("latest.yml verification failed");
  }
  console.log("latest.yml written and verified for", exeName);
}

main().then(
  () => console.log("Done"),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
