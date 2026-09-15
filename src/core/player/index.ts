/**
 * Player Module - Multi-engine architecture for cross-platform IPTV playback.
 * 
 * This module provides platform-optimized player engines:
 * - WebOSPlayerEngine: LG webOS TVs (native HLS preference)
 * - CapacitorPlayerEngine: Android via Capacitor (HLS.js always)
 * - ElectronPlayerEngine: Desktop with relay/transcoder support
 * - BrowserPlayerEngine: Standard web browsers
 * 
 * Use createPlayerEngine() to get the appropriate engine for the current platform.
 */

export type { IPlayerEngine, PlaybackBufferLevel, BufferPreset, PlatformRuntime } from "./PlayerInterface";
export { createPlayerEngine, getCurrentPlatform } from "./PlayerFactory";
export { 
  getPlaybackBufferLevel, 
  setPlaybackBufferLevel, 
  getCurrentBufferPreset,
  PLAYBACK_BUFFER_PRESETS 
} from "./bufferManager";
export { 
  detectPlatformRuntime, 
  isWebOsRuntime,
  isWebOsSimulator,
  webOsSupportsNativeHls,
  isCapacitorRuntime, 
  isElectronRuntime, 
  isAndroidRuntime,
  isLikelyLocalRuntime 
} from "./platformDetection";
export { WebOSPlayerEngine } from "./engines/WebOSPlayerEngine";
export { CapacitorPlayerEngine } from "./engines/CapacitorPlayerEngine";
export { ElectronPlayerEngine } from "./engines/ElectronPlayerEngine";
export { BrowserPlayerEngine } from "./engines/BrowserPlayerEngine";
