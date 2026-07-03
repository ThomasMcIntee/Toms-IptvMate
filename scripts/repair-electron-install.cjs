const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

async function main() {
  const rootDir = path.resolve(__dirname, "..");
  const electronDir = path.join(rootDir, "node_modules", "electron");
  const distDir = path.join(electronDir, "dist");
  const pathFile = path.join(electronDir, "path.txt");

  const { version } = require(path.join(electronDir, "package.json"));
  const { downloadArtifact } = require("@electron/get");

  const platform = process.env.npm_config_platform || process.platform;
  const arch = process.env.npm_config_arch || process.arch;

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform,
    arch,
    force: true,
    cacheRoot: process.env.electron_config_cache
  });

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (platform === "win32") {
    const ps = [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distDir.replace(/'/g, "''")}' -Force`
    ];
    const result = spawnSync("powershell", ps, { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`Expand-Archive failed with exit code ${result.status}`);
    }
  } else {
    const extract = require("extract-zip");
    await extract(zipPath, { dir: distDir });
  }

  const platformPath = getPlatformPath(platform);
  fs.writeFileSync(pathFile, platformPath, "utf8");

  const executable = path.join(distDir, platformPath);
  if (!fs.existsSync(executable)) {
    throw new Error(`Electron executable not found after repair: ${executable}`);
  }

  console.log(`[electron-repair] repaired electron ${version} (${platform}-${arch})`);
}

function getPlatformPath(platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

main().catch((err) => {
  console.error(`[electron-repair] ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
