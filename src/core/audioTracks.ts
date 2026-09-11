import { useSyncExternalStore } from "react";
import {
  audioLanguageLabel,
  readPreferredAudioLanguage,
  savePreferredAudioLanguage,
  type PlaybackAudioTrack
} from "./audioLanguage";
import {
  getActiveHlsPlayer,
  getActiveShakaPlayer,
  getActiveVideoElement
} from "./playerEngine";
import { getNativeAudioTracks, isNativePlayerAvailable, setNativeAudioTrack } from "./nativePlayerBridge";
import { isCapacitorRuntime } from "./player/platformDetection";

type BrowserAudioTrack = {
  id?: string;
  label?: string;
  language?: string;
  enabled?: boolean;
};

type BrowserAudioTrackList = {
  length: number;
  [index: number]: BrowserAudioTrack;
};

let cachedTracks: PlaybackAudioTrack[] = [];
let pickerOpen = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function isNativePlaybackActive(): boolean {
  return isCapacitorRuntime() && isNativePlayerAvailable() && document.body.classList.contains("native-exo-active");
}

function collectHtmlAudioTracks(): PlaybackAudioTrack[] {
  const video = getActiveVideoElement() as (HTMLVideoElement & { audioTracks?: BrowserAudioTrackList }) | null;
  const list = video?.audioTracks;
  if (!list || !list.length) return [];

  const tracks: PlaybackAudioTrack[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const track = list[index];
    if (!track) continue;
    tracks.push({
      id: `html:${track.id || index}`,
      language: track.language || "",
      label: track.label || audioLanguageLabel(track.language, `Audio ${index + 1}`),
      selected: !!track.enabled
    });
  }
  return tracks;
}

function collectHlsAudioTracks(): PlaybackAudioTrack[] {
  const hls = getActiveHlsPlayer();
  const list = hls?.audioTracks || [];
  if (!list.length) return [];
  const selected = hls?.audioTrack ?? 0;
  return list.map((track, index) => ({
    id: `hls:${index}`,
    language: (track as { lang?: string }).lang || "",
    label:
      track.name ||
      audioLanguageLabel((track as { lang?: string }).lang, `Audio ${index + 1}`),
    selected: index === selected
  }));
}

function collectShakaAudioTracks(): PlaybackAudioTrack[] {
  const player = getActiveShakaPlayer();
  if (!player?.getAudioLanguagesAndRoles) return [];
  try {
    const options = player.getAudioLanguagesAndRoles() as Array<{ language?: string; role?: string }>;
    if (!Array.isArray(options) || !options.length) return [];
    const current =
      typeof player.getConfiguration === "function"
        ? String(player.getConfiguration()?.preferredAudioLanguage || "")
        : "";
    return options.map((option, index) => {
      const language = option.language || "";
      return {
        id: `shaka:${language}:${option.role || index}`,
        language,
        label: audioLanguageLabel(language, `Audio ${index + 1}`),
        selected: !!current && current === language
      };
    });
  } catch {
    return [];
  }
}

function collectWebAudioTracks(): PlaybackAudioTrack[] {
  const hlsTracks = collectHlsAudioTracks();
  if (hlsTracks.length) return hlsTracks;
  const htmlTracks = collectHtmlAudioTracks();
  if (htmlTracks.length) return htmlTracks;
  return collectShakaAudioTracks();
}

export function getAudioTracks(): PlaybackAudioTrack[] {
  return cachedTracks;
}

export function subscribeAudioTracks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAudioTracks(): PlaybackAudioTrack[] {
  return useSyncExternalStore(subscribeAudioTracks, getAudioTracks, getAudioTracks);
}

export function isAudioLanguagePickerOpen(): boolean {
  return pickerOpen;
}

export function setAudioLanguagePickerOpen(open: boolean): void {
  if (pickerOpen === open) return;
  pickerOpen = open;
  emit();
}

export async function refreshAudioTracks(): Promise<PlaybackAudioTrack[]> {
  if (isNativePlaybackActive()) {
    const nativeTracks = await getNativeAudioTracks();
    cachedTracks = nativeTracks
      .filter((track) => track.id)
      .map((track, index) => ({
        id: String(track.id),
        language: track.language || "",
        label: track.label || audioLanguageLabel(track.language, `Audio ${index + 1}`),
        selected: !!track.selected
      }));
  } else {
    cachedTracks = collectWebAudioTracks();
  }
  emit();
  return cachedTracks;
}

export async function selectAudioTrack(id: string): Promise<boolean> {
  if (!id) return false;

  if (isNativePlaybackActive()) {
    const ok = await setNativeAudioTrack(id);
    if (ok) {
      const selected = cachedTracks.find((track) => track.id === id);
      savePreferredAudioLanguage(selected?.language || id);
    }
    await refreshAudioTracks();
    return ok;
  }

  if (id.startsWith("hls:")) {
    const hls = getActiveHlsPlayer();
    const index = Number(id.slice(4));
    if (hls && Number.isInteger(index) && index >= 0 && index < (hls.audioTracks || []).length) {
      hls.audioTrack = index;
      const track = hls.audioTracks[index] as { lang?: string };
      savePreferredAudioLanguage(track?.lang || readPreferredAudioLanguage());
      await refreshAudioTracks();
      return true;
    }
  }

  if (id.startsWith("html:")) {
    const video = getActiveVideoElement() as (HTMLVideoElement & { audioTracks?: BrowserAudioTrackList }) | null;
    const list = video?.audioTracks;
    if (list) {
      const targetId = id.slice(5);
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        if (!track) continue;
        const match = String(track.id || index) === targetId;
        track.enabled = match;
        if (match) savePreferredAudioLanguage(track.language || "");
      }
      await refreshAudioTracks();
      return true;
    }
  }

  if (id.startsWith("shaka:")) {
    const player = getActiveShakaPlayer();
    const [, language, role] = id.split(":");
    if (player?.selectAudioLanguage && language) {
      try {
        player.selectAudioLanguage(language, role && role !== "undefined" ? role : undefined);
        savePreferredAudioLanguage(language);
        await refreshAudioTracks();
        return true;
      } catch {
        return false;
      }
    }
  }

  return false;
}

if (typeof window !== "undefined") {
  const refresh = () => {
    void refreshAudioTracks();
  };
  window.addEventListener("playerAudioTracks", refresh);
  window.addEventListener("playerPlaying", refresh);
  window.addEventListener("playerEnded", refresh);
  window.addEventListener("playerError", refresh);
}
