const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { syncAndroidWeb } = require("./sync-android-web.cjs");

const rootDir = path.resolve(__dirname, "..");
const androidDir = path.join(rootDir, "android");
const distDir = path.join(rootDir, "dist");

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate));
}

const androidSdk = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
    : path.join(os.homedir(), "Android", "Sdk")
]);

if (!androidSdk) {
  console.error("Android SDK not found. Set ANDROID_HOME or ANDROID_SDK_ROOT.");
  process.exit(1);
}

const javaHome = firstExisting([
  process.env.JAVA_HOME,
  process.platform === "win32" ? "C:\\Program Files\\Android\\Android Studio\\jbr" : null,
  process.platform === "darwin" ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home" : null
]);

if (!javaHome) {
  console.error("Compatible Java runtime not found. Set JAVA_HOME to JDK 17 or 21.");
  process.exit(1);
}

const sdkPath = androidSdk.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
fs.writeFileSync(path.join(androidDir, "local.properties"), `sdk.dir=${sdkPath}\n`, "ascii");

if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}

const webBuild = spawnSync("npm", ["run", "build"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: true
});
if (webBuild.error) {
  console.error(webBuild.error.message);
  process.exit(1);
}
if (webBuild.status !== 0) {
  process.exit(webBuild.status ?? 1);
}

try {
  syncAndroidWeb();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const wrapper = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
const result = spawnSync(wrapper, ["assembleDebug"], {
  cwd: androidDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidSdk,
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
  }
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);