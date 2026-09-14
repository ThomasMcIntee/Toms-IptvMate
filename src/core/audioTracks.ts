import { useSyncExternalStore } from "react";
import {
  audioTrackDisplayLabel,
  readPreferredAudioLanguage,
  savePreferredAudioLanguage,
  type PlaybackAudioTrack
} from "./audioLanguage";
import {
  getActiveHlsPlayer,
  getActiveShakaPlayer,
  getActiveVideoElement,
  getCurrentAudioStreamOrder,
  getLastRootSourceUrl,
  getSourceAudioTracksProbeOrigin,
  playAudioStreamOrder
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

function htmlAudioTrackList(
  video: (HTMLVideoElement & {
    audioTracks?: BrowserAudioTrackList;
    webkitAudioTracks?: BrowserAudioTrackList;
  }) | null
): BrowserAudioTrackList | null {
  if (!video) return null;
  const list = video.audioTracks || video.webkitAudioTracks;
  return list && list.length ? list : null;
}

function collectHtmlAudioTracks(): PlaybackAudioTrack[] {
  const video = getActiveVideoElement() as (HTMLVideoElement & {
    audioTracks?: BrowserAudioTrackList;
    webkitAudioTracks?: BrowserAudioTrackList;
  }) | null;
  const list = htmlAudioTrackList(video);
  if (!list || !list.length) return [];

  const tracks: PlaybackAudioTrack[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const track = list[index];
    if (!track) continue;
    tracks.push({
      id: `html:${track.id || index}`,
      language: track.language || "",
      label: audioTrackDisplayLabel(track.label, track.language, index),
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
    label: audioTrackDisplayLabel(track.name, (track as { lang?: string }).lang, index),
    selected: index === selected
  }));
}

function collectShakaAudioTracks(): PlaybackAudioTrack[] {
  const player = getActiveShakaPlayer();
  if (!player) return [];

  try {
    const variants =
      typeof player.getVariantTracks === "function"
        ? (player.getVariantTracks() as Array<{
            language?: string;
            audioLanguage?: string;
            label?: string;
            audioId?: number;
            id?: number;
            active?: boolean;
          }>)
        : [];
    const seen = new Map<string, PlaybackAudioTrack>();
    for (const track of variants) {
      const language = String(track.audioLanguage || track.language || "");
      const key = language || String(track.audioId ?? track.id ?? seen.size);
      if (seen.has(key)) {
        if (track.active) {
          const current = seen.get(key);
          if (current) current.selected = true;
        }
        continue;
      }
      seen.set(key, {
        id: `shaka:${language}:${track.audioId ?? track.id ?? seen.size}`,
        language,
        label: audioTrackDisplayLabel(track.label, language, seen.size),
        selected: !!track.active
      });
    }
    if (seen.size) return Array.from(seen.values());
  } catch {
    // Fall through to language/role list.
  }

  if (!player.getAudioLanguagesAndRoles) return [];
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
        label: audioTrackDisplayLabel("", language, index),
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

function canProbeLocalSourceAudioTracks(): boolean {
  if (typeof window === "undefined") return false;
  if (isNativePlaybackActive()) return false;
  return !!getSourceAudioTracksProbeOrigin();
}

type SourceAudioTrackPayload = { order?: number; language?: string; title?: string; default?: boolean };
const sourceTrackPromises = new Map<string, Promise<SourceAudioTrackPayload[]>>();
let allowSourceAudioProbe = false;

async function collectLocalSourceAudioTracks(): Promise<PlaybackAudioTrack[]> {
  if (!allowSourceAudioProbe) return [];
  if (!canProbeLocalSourceAudioTracks()) return [];
  const root = getLastRootSourceUrl();
  const probeOrigin = getSourceAudioTracksProbeOrigin();
  if (!root || !probeOrigin || !/^https?:\/\//i.test(root)) return [];
  let pending = sourceTrackPromises.get(root);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(
          `${probeOrigin}/__audio-tracks?url=${encodeURIComponent(root)}`
        );
        if (!response.ok) return [];
        const payload = (await response.json()) as { tracks?: SourceAudioTrackPayload[] };
        return Array.isArray(payload.tracks) ? payload.tracks : [];
      } catch {
        return [];
      }
    })();
    sourceTrackPromises.set(root, pending);
  }
  const tracks = await pending;
  if (tracks.length < 2) return [];
  const fallbackIndex = tracks.findIndex((track) => track.default);
  const selectedOrder =
    getCurrentAudioStreamOrder() ??
    (fallbackIndex >= 0 ? Number(tracks[fallbackIndex].order ?? fallbackIndex) : 0);
  return tracks.map((track, index) => {
    const order = Number.isInteger(track.order) ? Number(track.order) : index;
    return {
      id: `source:${order}`,
      language: track.language || "",
      label: audioTrackDisplayLabel(track.title, track.language, index),
      selected: order === selectedOrder
    };
  });
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

function bindHtmlAudioTrackListeners(): void {
  const video = getActiveVideoElement() as (HTMLVideoElement & {
    audioTracks?: BrowserAudioTrackList & {
      addEventListener?: (name: string, listener: () => void) => void;
      __iptvBound?: boolean;
    };
    webkitAudioTracks?: BrowserAudioTrackList & {
      addEventListener?: (name: string, listener: () => void) => void;
      __iptvBound?: boolean;
    };
  }) | null;
  const list = video?.audioTracks || video?.webkitAudioTracks;
  if (!list || list.__iptvBound) return;
  const refresh = () => {
    void refreshAudioTracks();
  };
  list.addEventListener?.("addtrack", refresh);
  list.addEventListener?.("change", refresh);
  list.addEventListener?.("removetrack", refresh);
  list.__iptvBound = true;
}

export async function refreshAudioTracks(): Promise<PlaybackAudioTrack[]> {
  bindHtmlAudioTrackListeners();
  if (isNativePlaybackActive()) {
    const nativeTracks = await getNativeAudioTracks();
    cachedTracks = nativeTracks
      .filter((track) => track.id)
      .map((track, index) => ({
        id: String(track.id),
        language: track.language || "",
        label: audioTrackDisplayLabel(track.label, track.language, index),
        selected: !!track.selected
      }));
  } else {
    const sourceTracks = await collectLocalSourceAudioTracks();
    cachedTracks = sourceTracks.length >= 2 ? sourceTracks : collectWebAudioTracks();
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

  if (id.startsWith("source:")) {
    const order = Number(id.slice(7));
    if (!Number.isInteger(order) || order < 0) return false;
    const selected = cachedTracks.find((track) => track.id === id);
    savePreferredAudioLanguage(selected?.language || readPreferredAudioLanguage());
    const ok = playAudioStreamOrder(order);
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
    const video = getActiveVideoElement() as (HTMLVideoElement & {
      audioTracks?: BrowserAudioTrackList;
      webkitAudioTracks?: BrowserAudioTrackList;
    }) | null;
    const list = htmlAudioTrackList(video);
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
  window.addEventListener("playerStopped", () => {
    allowSourceAudioProbe = false;
  });
  window.addEventListener("playerPlaying", () => {
    allowSourceAudioProbe = true;
    refresh();
  });
  window.addEventListener("playerAudioTracks", refresh);
  window.addEventListener("playerEnded", refresh);
  window.addEventListener("playerError", refresh);
}
