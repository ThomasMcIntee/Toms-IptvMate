import type { ContentType } from "../channelStore";

/**
 * Player engine interface - all platform-specific engines must implement this.
 */
export interface IPlayerEngine {
  /**
   * Initialize the player engine with a video element.
   */
  init(video: HTMLVideoElement): void;

  /**
   * Play a URL with the given content type.
   */
  playUrl(url: string, contentType: ContentType): void;

  /**
   * Stop playback and clean up resources.
   */
  stop(): void;

  /**
   * Destroy the engine and release all resources.
   */
  destroy(): void;
}

/**
 * Playback buffer level presets.
 */
export type PlaybackBufferLevel = "off" | "low" | "medium" | "high";

export interface BufferPreset {
  bufferingGoal: number;
  rebufferingGoal: number;
}

/**
 * Platform runtime types.
 */
export type PlatformRuntime = "webos" | "android" | "capacitor" | "electron" | "browser";
