// Builds dist/VibeChat-win32-x64 (portable folder with VibeChat.exe).
// Run: npm run dist
const { packager } = require("@electron/packager");

packager({
  dir: ".",
  name: "VibeChat",
  platform: "win32",
  arch: "x64",
  out: "dist",
  overwrite: true,
  asar: true,
  prune: true,
  ignore: [/^\/.github/, /^\/.git/, /^\/dist/, /\/node_modules/]
}).then((paths) => {
  console.log("Built:", paths);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
