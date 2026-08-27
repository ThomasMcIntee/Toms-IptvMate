const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const iosDir = path.join(rootDir, "ios");
const appDir = path.join(iosDir, "App");

// Check if iOS platform has been added
if (!fs.existsSync(iosDir)) {
  console.error("iOS platform not found. Run 'npx cap add ios' first.");
  process.exit(1);
}

// Check for xcodebuild
const xcodeCheck = spawnSync("xcodebuild", ["-version"], {
  stdio: "pipe",
  shell: false
});

if (xcodeCheck.error || xcodeCheck.status !== 0) {
  console.error("Xcode not found. Please install Xcode from the Mac App Store.");
  console.error("After installation, run: sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer");
  process.exit(1);
}

// Find the .xcworkspace file
const workspaceFiles = fs.readdirSync(appDir).filter(f => f.endsWith(".xcworkspace"));
if (workspaceFiles.length === 0) {
  console.error("No .xcworkspace file found in ios/App directory.");
  process.exit(1);
}

const workspace = workspaceFiles[0];
const scheme = "App";

console.log(`Building iOS app with workspace: ${workspace}`);

// Build for simulator (debug)
const result = spawnSync("xcodebuild", [
  "-workspace", path.join(appDir, workspace),
  "-scheme", scheme,
  "-sdk", "iphonesimulator",
  "-configuration", "Debug",
  "-destination", "platform=iOS Simulator,name=iPhone 15",
  "clean", "build",
  "CODE_SIGN_IDENTITY=",
  "CODE_SIGNING_REQUIRED=NO",
  "CODE_SIGNING_ALLOWED=NO"
], {
  cwd: appDir,
  stdio: "inherit",
  shell: false
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status === 0) {
  console.log("\n✅ iOS build completed successfully!");
  console.log("To open in Xcode: npm run cap:ios");
}

process.exit(result.status ?? 1);