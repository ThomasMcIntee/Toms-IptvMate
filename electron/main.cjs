const path = require("path");
const os = require("os");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const DEV_URL = process.env.ELECTRON_START_URL || "";

const runtimeDataRoot = path.join(app.getPath("appData"), "toms-iptvmate-electron");
const runtimeUserData = path.join(runtimeDataRoot, "userData");
const runtimeSessionData = path.join(runtimeDataRoot, "sessionData");
const legacyDataRoot = path.join(os.tmpdir(), "toms-iptvmate-electron");
const legacyUserData = path.join(legacyDataRoot, "userData");
const legacySessionData = path.join(legacyDataRoot, "sessionData");

function directoryHasFiles(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function migrateLegacyRuntimeData() {
  try {
    const shouldMigrateUserData = directoryHasFiles(legacyUserData) && !directoryHasFiles(runtimeUserData);
    const shouldMigrateSessionData = directoryHasFiles(legacySessionData) && !directoryHasFiles(runtimeSessionData);

    if (shouldMigrateUserData) {
      fs.mkdirSync(runtimeUserData, { recursive: true });
      fs.cpSync(legacyUserData, runtimeUserData, { recursive: true, force: false });
    }

    if (shouldMigrateSessionData) {
      fs.mkdirSync(runtimeSessionData, { recursive: true });
      fs.cpSync(legacySessionData, runtimeSessionData, { recursive: true, force: false });
    }
  } catch (err) {
    console.warn(`[electron] failed to migrate legacy runtime data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

try {
  migrateLegacyRuntimeData();
  fs.mkdirSync(runtimeUserData, { recursive: true });
  fs.mkdirSync(runtimeSessionData, { recursive: true });
  app.setPath("userData", runtimeUserData);
  app.setPath("sessionData", runtimeSessionData);
} catch (err) {
  console.warn(`[electron] failed to set runtime data paths: ${err instanceof Error ? err.message : String(err)}`);
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 576,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.webContents.setZoomFactor(1);

  const distIndex = path.join(__dirname, "..", "dist", "index.html");

  win.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    console.error(`[electron] did-fail-load code=${code} desc=${description} url=${validatedUrl}`);
  });

  win.webContents.on("did-finish-load", () => {
    console.log(`[electron] did-finish-load url=${win.webContents.getURL()}`);
  });

  if (!app.isPackaged && DEV_URL) {
    win.loadURL(DEV_URL).catch(() => {
      console.warn(`[electron] dev url unavailable, falling back to dist: ${DEV_URL}`);
      void win.loadFile(distIndex);
    });
    return;
  }

  void win.loadFile(distIndex);
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
