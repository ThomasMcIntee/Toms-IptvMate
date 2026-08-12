const fs = require("fs");
const path = require("path");

const root = process.cwd();
const packageJsonPath = path.join(root, "package.json");
const webosAppInfoPath = path.join(root, "webos", "appinfo.json");

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function syncWebOsVersion() {
  const pkg = readJson(packageJsonPath, "package.json");
  const appInfo = readJson(webosAppInfoPath, "webos appinfo.json");

  const version = String(pkg.version || "").trim();
  if (!version) {
    throw new Error("package.json version is empty.");
  }

  if (appInfo.version === version) {
    console.log(`webos/appinfo.json version already ${version}.`);
    return;
  }

  appInfo.version = version;
  fs.writeFileSync(webosAppInfoPath, `${JSON.stringify(appInfo, null, 2)}\n`, "utf8");
  console.log(`Synced webOS version to ${version}.`);
}

try {
  syncWebOsVersion();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
