const fs = require("fs");
const path = require("path");

const root = process.cwd();
const distDir = path.join(root, "dist");
const webosDir = path.join(root, "webos");
const distAssetsDir = path.join(distDir, "assets");
const webosAssetsDir = path.join(webosDir, "assets");

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function copyDirContents(sourceDir, targetDir) {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirContents(src, dst);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function syncWebOsBundle() {
  ensureExists(distDir, "dist directory");
  ensureExists(distAssetsDir, "dist assets directory");
  ensureExists(webosDir, "webos directory");

  copyDirContents(distAssetsDir, webosAssetsDir);

  const distIndex = path.join(distDir, "index.html");
  ensureExists(distIndex, "dist index.html");

  const webosIndex = path.join(webosDir, "index.html");
  fs.copyFileSync(distIndex, webosIndex);

  console.log("Synced dist bundle to webos/ (index.html + assets).");
}

try {
  syncWebOsBundle();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
