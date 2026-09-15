import type { PlatformRuntime } from "./PlayerInterface";

/**
 * Platform detection utilities - shared across all player engines.
 */

export function isAndroidRuntime(): boolean {
  return /Android/i.test(navigator.userAgent);
}

export function isWebOsRuntime(): boolean {
  // Be specific to LG webOS to avoid misidentifying Android Smart TVs/Fire TVs.
  const agent = navigator.userAgent;
  const hasWebOsBrand = /Web0S|NetCast/i.test(agent);
  const hasLgSpecificApi = !!(window as any).PalmServiceBridge || !!(window as any).webOS;
  return (hasWebOsBrand || hasLgSpecificApi) && !isAndroidRuntime();
}

/** Chromium hosting the webOS SDK — no TV media pipeline. */
export function isWebOsSimulator(): boolean {
  if (!isWebOsRuntime()) return false;
  const ua = navigator.userAgent || "";
  const platform = String(navigator.platform || "");
  if (/Win32|Win64|Windows NT|MacIntel|emulator/i.test(`${ua} ${platform}`)) return true;
  // Real LG TVs report Web0S + Linux. Their HLS canPlayType is often empty,
  // but the TV media pipeline still plays natively. Do not treat that as a simulator.
  if (/Web0S/i.test(ua) && /Linux/i.test(`${ua} ${platform}`)) return false;
  if (typeof document !== "undefined") {
    const video = document.createElement("video");
    const hls =
      video.canPlayType("application/vnd.apple.mpegurl") ||
      video.canPlayType("application/x-mpegURL");
    if (!String(hls || "").trim()) return true;
  }
  return false;
}

export function webOsSupportsNativeHls(_video?: HTMLVideoElement | null): boolean {
  return isWebOsRuntime() && !isWebOsSimulator();
}

export function isCapacitorRuntime(): boolean {
  // Importing @capacitor/core always defines the window.Capacitor JS global —
  // even in plain browser/Electron/webOS bundles — so the bare global cannot
  // be trusted. Only a native-platform report means the app is really running
  // inside a Capacitor app shell (Fire TV/Android/iOS).
  const cap = (window as any).Capacitor;
  const isNativeCapacitor =
    !!cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() === true;
  if (isNativeCapacitor || navigator.userAgent.includes("Capacitor")) return true;

  // Capacitor Android/Fire TV WebViews serve the app on localhost or app
  // without a port. Desktop Vite (localhost:5173) and Android Chrome hitting
  // a LAN/dev server must stay on the browser storage path so favorites save.
  const host = String(window.location.hostname || "");
  const port = String(window.location.port || "");
  if (!port && (host === "localhost" || host === "app")) return true;
  return false;
}

export function isElectronRuntime(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("electron") || !!(window as any).electronAPI;
}

/**
 * Detect the current platform runtime.
 */
export function detectPlatformRuntime(): PlatformRuntime {
  if (isWebOsRuntime()) return "webos";
  if (isAndroidRuntime() && !isCapacitorRuntime()) return "android";
  if (isCapacitorRuntime()) return "capacitor";
  if (isElectronRuntime()) return "electron";
  return "browser";
}

/**
 * Check if running in a local runtime (Capacitor, WebOS, or Electron).
 * These runtimes typically need relay/proxy for CORS-restricted streams.
 */
export function isLikelyLocalRuntime(): boolean {
  return isCapacitorRuntime() || isWebOsRuntime() || isElectronRuntime();
}
