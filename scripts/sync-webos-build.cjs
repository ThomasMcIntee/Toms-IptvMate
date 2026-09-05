const fs = require("fs");
const path = require("path");
const os = require("os");
const { verifyIndexAssets } = require("./sync-android-web.cjs");

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

function collectLanRelayOrigins() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== "IPv4" && net.family !== 4) continue;
      if (net.internal) continue;
      const ip = String(net.address || "");
      if (!ip || ip.startsWith("127.") || ip.startsWith("169.254.")) {
        continue;
      }
      // Skip Docker / WSL / Hyper-V virtual NICs (172.16/12). The simulator
      // hits those as Host: 172.x and Vite returns 403; the TV cannot use them.
      const octets = ip.split(".").map((part) => Number(part));
      if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
        continue;
      }
      ips.push(ip);
    }
  }
  ips.sort((a, b) => {
    const rank = (ip) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const origins = [];
  for (const ip of ips) {
    origins.push(`http://${ip}:5173`);
    origins.push(`http://${ip}:4173`);
  }
  return origins;
}

function syncWebOsBundle() {
  ensureExists(distDir, "dist directory");
  ensureExists(distAssetsDir, "dist assets directory");
  ensureExists(webosDir, "webos directory");
  verifyIndexAssets(distDir, "dist");

  copyDirContents(distAssetsDir, webosAssetsDir);

  const distIndex = path.join(distDir, "index.html");
  ensureExists(distIndex, "dist index.html");

  // Read dist index and inject webOS SDK script for proper Back key handling
  let indexHtml = fs.readFileSync(distIndex, "utf8");

  // Inject webOSTVjs SDK before the closing </head> tag.
  // This library is required for proper remote control handling on webOS TVs.
  const relayOrigins = collectLanRelayOrigins();
  const relayPrimary = relayOrigins[0] || "";
  const relayJson = JSON.stringify(relayOrigins);
  const webOsScript = `
    <script type="text/javascript">
      window.__IPTV_RELAY_ORIGIN__ = ${JSON.stringify(relayPrimary)};
      window.__IPTV_RELAY_CANDIDATES__ = ${relayJson};
    </script>
    <script type="text/javascript" src="webOSTVjs-1.2.4/webOSTV.js"></script>
    <script type="text/javascript" src="webOSTVjs-1.2.4/webOSTV-dev.js"></script>
    <script type="text/javascript">
      // Disable webOS native back handling - let the app handle navigation
      window.addEventListener('load', function() {
        if (window.webOS && window.webOS.platformBack) {
          // Prevent default back behavior
        }
        document.addEventListener('webOSRelaunch', function(e) {
          console.log('[webos] relaunch event', e);
        });
        // Register for visibility changes
        document.addEventListener('visibilitychange', function() {
          console.log('[webos] visibility:', document.visibilityState);
        });
      });
    </script>
`;

  if (indexHtml.includes("</head>")) {
    indexHtml = indexHtml.replace("</head>", webOsScript + "</head>");
  }

  const webosIndex = path.join(webosDir, "index.html");
  fs.writeFileSync(webosIndex, indexHtml, "utf8");

  console.log(
    relayPrimary
      ? `Synced dist bundle to webos/ (index.html + assets + webOS SDK injection). PC relay: ${relayOrigins.join(", ")}`
      : "Synced dist bundle to webos/ (index.html + assets + webOS SDK injection). No LAN IP found for PC relay."
  );
}

try {
  syncWebOsBundle();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
