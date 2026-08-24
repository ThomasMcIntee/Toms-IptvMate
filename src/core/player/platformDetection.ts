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

export function isCapacitorRuntime(): boolean {
  const isCap = !!(window as any).Capacitor ||
               navigator.userAgent.includes("Capacitor") ||
               // Capacitor on Android typically runs on http://localhost (no port) or http://app
               // Desktop dev servers run on http://localhost:PORT (with port)
               (window.location.hostname === "localhost" && !window.location.port) ||
               (window.location.hostname === "app" && !window.location.port) ||
               (window.location.protocol === "http:" && !window.location.port && !/localhost/i.test(window.location.href));
  return isCap || isAndroidRuntime();
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
