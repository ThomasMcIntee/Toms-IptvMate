const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const publicDir = path.join(rootDir, "android", "app", "src", "main", "assets", "public");

function verifyIndexAssets(webRoot, label) {
  const indexPath = path.join(webRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`${label} index.html not found: ${indexPath}`);
  }

  const html = fs.readFileSync(indexPath, "utf8");
  const refs = [...html.matchAll(/(?:src|href)=["'](?:\.\/)?([^"']+\.(?:js|css))["']/gi)].map((match) => match[1]);
  if (refs.length === 0) {
    throw new Error(`${label} index.html does not reference any js/css assets`);
  }

  const missing = refs.filter((relativePath) => !fs.existsSync(path.join(webRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`${label} index.html references missing files:\n  ${missing.join("\n  ")}`);
  }

  console.log(`${label}: verified ${refs.length} asset references`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function syncAndroidWeb() {
  verifyIndexAssets(distDir, "dist");

  if (fs.existsSync(publicDir)) {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }

  run("npx", ["cap", "sync", "android"]);
  verifyIndexAssets(publicDir, "android public");
}

if (require.main === module) {
  try {
    syncAndroidWeb();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { syncAndroidWeb, verifyIndexAssets };
