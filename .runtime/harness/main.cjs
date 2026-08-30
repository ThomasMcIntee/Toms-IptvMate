// CDP harness main: reuse the user's live profile copy and load the app under test.
const path = require("path");
const { app, BrowserWindow } = require("electron");

const profileRoot = process.env.HARNESS_PROFILE_ROOT;
const startUrl = process.env.HARNESS_URL || "http://127.0.0.1:4000";

app.setPath("userData", path.join(profileRoot, "userData"));
app.setPath("sessionData", path.join(profileRoot, "sessionData"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false, // avoid disturbing the user's desktop; timers still run
    backgroundColor: "#000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.webContents.on("console-message", (_e, _level, message, _line, sourceId) => {
    console.log(`[page-console] ${message}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.log(`[harness] did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on("did-finish-load", () => {
    console.log(`[harness] did-finish-load ${win.webContents.getURL()}`);
  });

  win.loadURL(startUrl).catch((err) => {
    console.error(`[harness] load failed: ${err && err.message ? err.message : err}`);
  });
});