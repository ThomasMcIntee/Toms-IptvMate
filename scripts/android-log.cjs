const { spawn, spawnSync } = require("child_process");

const PACKAGE = "tv.toms.iptvmate";
const TAGS = [
  "Capacitor/Console:I",
  "Capacitor:I",
  "IPTVMate_Native:V",
  "IPTVMate_ExoPlayer:V",
  "IPTVMate_NativePlayer:V",
  "IPTVMate_NativeExo:V",
  "AndroidRuntime:E",
  "*:S"
];

function runAdb(serial, args, extra = {}) {
  const full = serial ? ["-s", serial, ...args] : args;
  return spawnSync("adb", full, {
    encoding: "utf8",
    shell: process.platform === "win32",
    ...extra
  });
}

function firstDeviceSerial() {
  const fromEnv = String(process.env.ANDROID_SERIAL || "").trim();
  if (fromEnv) return fromEnv;

  const listed = runAdb("", ["devices", "-l"]);
  const lines = String(listed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"));
  const ready = lines.find((line) => /\sdevice(\s|$)/.test(line));
  if (!ready) {
    console.error("No Android/Fire TV device found. Connect with adb first.");
    process.exit(1);
  }
  return ready.split(/\s+/)[0];
}

const serial = firstDeviceSerial();
const pidRaw = String(runAdb(serial, ["shell", "pidof", PACKAGE]).stdout || "").trim();
const pid = pidRaw.split(/\s+/).filter(Boolean)[0] || "";

const args = ["-s", serial, "logcat", "-v", "time"];
if (pid) args.push("--pid", pid);
args.push(...TAGS);

console.error(
  pid
    ? `IPTVmate log filter: ${PACKAGE} pid=${pid} (${serial})`
    : `IPTVmate log filter: ${PACKAGE} not running — tags only (${serial})`
);
console.error("Showing Capacitor/Console + IPTVMate_* only. Ctrl+C to stop.\n");

const child = spawn("adb", args, {
  stdio: "inherit",
  shell: process.platform === "win32"
});
child.on("exit", (code) => process.exit(code ?? 1));
