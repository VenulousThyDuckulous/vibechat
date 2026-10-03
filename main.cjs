// VibeChat desktop shell (Electron) — loads the local site files.
const { app, BrowserWindow } = require("electron");
const path = require("path");

let updateCheck = null;
try {
  updateCheck = require("electron-updater").autoUpdater;
} catch (e) {
  updateCheck = null;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#0f0f13",
    title: "VibeChat",
    webPreferences: {
      // Needed so file:// pages can load local ES modules
      webSecurity: false
    }
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // Auto-update from GitHub Releases (Windows portable build)
  try {
    if (updateCheck) {
      updateCheck.setFeedURL({ provider: "github", owner: "VenulousThyDuckulous", repo: "vibechat" });
      setTimeout(() => {
        updateCheck.checkForUpdatesAndNotify().catch(() => {});
      }, 15000);
    }
  } catch (e) {
    /* dev mode or offline — skip silently */
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
