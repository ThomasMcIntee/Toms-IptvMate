import type { IPlayerEngine } from "./PlayerInterface";
import { detectPlatformRuntime } from "./platformDetection";
import { WebOSPlayerEngine } from "./engines/WebOSPlayerEngine";
import { CapacitorPlayerEngine } from "./engines/CapacitorPlayerEngine";
import { ElectronPlayerEngine } from "./engines/ElectronPlayerEngine";
import { BrowserPlayerEngine } from "./engines/BrowserPlayerEngine";

/**
 * Player Factory - creates the appropriate player engine based on the current platform.
 * 
 * This is the main entry point for the multi-engine architecture.
 * It detects the platform runtime and returns the optimized engine for that platform.
 */
export function createPlayerEngine(): IPlayerEngine {
  const platform = detectPlatformRuntime();

  switch (platform) {
    case "webos":
      return new WebOSPlayerEngine();
    
    case "capacitor":
    case "android":
      return new CapacitorPlayerEngine();
    
    case "electron":
      return new ElectronPlayerEngine();
    
    case "browser":
    default:
      return new BrowserPlayerEngine();
  }
}

/**
 * Get the current platform runtime name (for debugging/logging).
 */
export function getCurrentPlatform(): string {
  return detectPlatformRuntime();
}
