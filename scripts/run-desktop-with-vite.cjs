const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { mode: "preview", host: "127.0.0.1", port: 4173 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1]) {
      out.mode = String(argv[++i]).toLowerCase();
      continue;
    }
    if (arg === "--host" && argv[i + 1]) {
      out.host = String(argv[++i]);
      continue;
    }
    if (arg === "--port" && argv[i + 1]) {
      out.port = Number(argv[++i]) || out.port;
      continue;
    }
  }

  return out;
}

function waitForPort(host, port, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    const tryConnect = () => {
      const socket = new net.Socket();

      socket.setTimeout(1200);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });

      const onFailure = () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(tryConnect, 250);
      };

      socket.once("timeout", onFailure);
      socket.once("error", onFailure);
      socket.connect(port, host);
    };

    tryConnect();
  });
}

function spawnInherit(command, args, extraEnv = {}) {
  return spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: false,
    windowsHide: false
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const viteCliPath = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
  const viteArgs = options.mode === "dev"
    ? [viteCliPath, "--host", options.host, "--port", String(options.port)]
    : [viteCliPath, "preview", "--host", options.host, "--port", String(options.port)];

  const viteProc = spawnInherit(process.execPath, viteArgs);
  let electronProc = null;
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (electronProc && !electronProc.killed) {
      try { electronProc.kill(); } catch {}
    }

    if (viteProc && !viteProc.killed) {
      try { viteProc.kill(); } catch {}
    }

    process.exit(code);
  };

  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));

  viteProc.on("exit", (code) => {
    if (!shuttingDown) {
      shutdown(typeof code === "number" ? code : 1);
    }
  });

  try {
    await waitForPort(options.host, options.port);
  } catch (err) {
    console.error(`[desktop-launch] ${err instanceof Error ? err.message : String(err)}`);
    shutdown(1);
    return;
  }

  const electronBinary = require("electron");
  const startUrl = `http://${options.host}:${options.port}`;
  electronProc = spawnInherit(electronBinary, ["."], {
    ELECTRON_START_URL: startUrl
  });

  electronProc.on("exit", (code) => {
    shutdown(typeof code === "number" ? code : 0);
  });
}

main().catch((err) => {
  console.error(`[desktop-launch] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
