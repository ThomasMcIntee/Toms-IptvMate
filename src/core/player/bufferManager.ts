import type { PlaybackBufferLevel, BufferPreset } from "./PlayerInterface";

/**
 * Buffer management utilities - shared across all player engines.
 */

const PLAYBACK_BUFFER_LEVEL_KEY = "iptvmate_playback_buffer_level";

export const PLAYBACK_BUFFER_PRESETS: Record<PlaybackBufferLevel, BufferPreset> = {
  off: { bufferingGoal: 1, rebufferingGoal: 0.1 },
  low: { bufferingGoal: 10, rebufferingGoal: 2 },
  medium: { bufferingGoal: 30, rebufferingGoal: 5 },
  high: { bufferingGoal: 60, rebufferingGoal: 10 }
};

let playbackBufferLevel: PlaybackBufferLevel = readPlaybackBufferLevel();

function readPlaybackBufferLevel(): PlaybackBufferLevel {
  try {
    const stored = localStorage.getItem(PLAYBACK_BUFFER_LEVEL_KEY);
    if (stored === "off" || stored === "low" || stored === "medium" || stored === "high") return stored;
  } catch {
    // Use the balanced default when storage is unavailable.
  }
  return "medium";
}

export function getPlaybackBufferLevel(): PlaybackBufferLevel {
  return playbackBufferLevel;
}

export function setPlaybackBufferLevel(level: PlaybackBufferLevel): void {
  playbackBufferLevel = level;

  try {
    localStorage.setItem(PLAYBACK_BUFFER_LEVEL_KEY, level);
  } catch {
    // Keep in-memory setting when storage is unavailable.
  }
}

export function getCurrentBufferPreset(): BufferPreset {
  return PLAYBACK_BUFFER_PRESETS[playbackBufferLevel];
}
