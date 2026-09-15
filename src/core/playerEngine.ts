import type Hls from "hls.js";
import { ContentType } from "./channelStore";
import {
  isAndroidRuntime,
  isWebOsRuntime,
  isWebOsSimulator,
  webOsSupportsNativeHls,
  isCapacitorRuntime,
  isElectronRuntime,
  isLikelyLocalRuntime
} from "./player/platformDetection";
import {
  isNativePlayerAvailable,
  playNativeUrl,
  stopNativePlayback
} from "./nativePlayerBridge";
import { fetchWebOsRemote, isWebOsRelayUrl } from "./webosStreamRelay";

let hls: Hls | null = null;
type HlsConstructor = typeof import("hls.js").default;
let hlsModulePromise: Promise<HlsConstructor> | null = null;

function loadHlsModule(): Promise<HlsConstructor> {
  if (!hlsModulePromise) {
    hlsModulePromise = import("hls.js").then((module) => module.default);
  }
  return hlsModulePromise;
}
let shakaPlayer: any = null;
let skipShakaOnce = false;
let videoEl: HTMLVideoElement | null = null;
let playRequestToken = 0;
let lastRootSourceUrl: string | null = null;
let rapidRetryChain: { rootUrl: string | null; count: number; lastAt: number } = {
  rootUrl: null,
  count: 0,
  lastAt: 0
};
let blockedRootPlaybackUntil: Record<string, number> = {};
let rootAttemptWindowState: Record<string, { count: number; firstAt: number }> = {};
let suppressPlayerEventsUntil = 0;

export type PlaybackBufferLevel = "off" | "low" | "medium" | "high";

const PLAYBACK_BUFFER_LEVEL_KEY = "iptvmate_playback_buffer_level";
const PLAYBACK_BUFFER_PRESETS: Record<
  PlaybackBufferLevel,
  { bufferingGoal: number; rebufferingGoal: number }
> = {
  off: { bufferingGoal: 1, rebufferingGoal: 0.1 },
  low: { bufferingGoal: 10, rebufferingGoal: 2 },
  medium: { bufferingGoal: 30, rebufferingGoal: 5 },
  high: { bufferingGoal: 60, rebufferingGoal: 10 }
};

function readPlaybackBufferLevel(): PlaybackBufferLevel {
  try {
    const stored = localStorage.getItem(PLAYBACK_BUFFER_LEVEL_KEY);
    if (stored === "off" || stored === "low" || stored === "medium" || stored === "high") return stored;
  } catch {
    // Use the balanced default when storage is unavailable.
  }
  return "medium";
}

let playbackBufferLevel = readPlaybackBufferLevel();

export function getPlaybackBufferLevel(): PlaybackBufferLevel {
  return playbackBufferLevel;
}

export function setPlaybackBufferLevel(level: PlaybackBufferLevel): void {
  playbackBufferLevel = level;

  try {
    localStorage.setItem(PLAYBACK_BUFFER_LEVEL_KEY, level);
  } catch {
    // Keep the in-memory setting when storage is unavailable.
  }

  const preset = PLAYBACK_BUFFER_PRESETS[level];
  if (hls) {
    hls.config.maxBufferLength = preset.bufferingGoal;
    hls.config.maxMaxBufferLength = preset.bufferingGoal;
  }
  if (shakaPlayer) {
    shakaPlayer.configure({
      streaming: {
        rebufferingGoal: preset.rebufferingGoal,
        bufferingGoal: preset.bufferingGoal
      }
    });
  }
}

const RAPID_RETRY_GAP_MS = 1200;
const MAX_RAPID_RETRIES = 30;
const RETRY_COOLDOWN_MS = 1500;
const ATTEMPT_WINDOW_MS = 20000;
const MAX_ATTEMPTS_PER_WINDOW = 30;
const DEFAULT_ELECTRON_RELAY_ORIGIN = "http://127.0.0.1:4173";
const WEBOS_PC_RELAY_ORIGIN_KEY = "iptvmate_webos_relay_origin";

export function getWebOsPcRelayOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(WEBOS_PC_RELAY_ORIGIN_KEY)?.trim() || "";
    if (/^https?:\/\//i.test(stored)) return stored.replace(/\/$/, "");
  } catch {
    // Ignore storage errors on locked-down webOS builds.
  }
  const scoped = window as Window & { __IPTV_RELAY_ORIGIN__?: string; __IPTV_RELAY_CANDIDATES__?: string[] };
  const explicit = scoped.__IPTV_RELAY_ORIGIN__?.trim();
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit.replace(/\/$/, "");
  return null;
}

function webOsRelayCandidateOrigins(): string[] {
  const scoped = window as Window & { __IPTV_RELAY_ORIGIN__?: string; __IPTV_RELAY_CANDIDATES__?: string[] };
  const found: string[] = [];
  const push = (value: string | null | undefined) => {
    const origin = String(value || "").trim().replace(/\/$/, "");
    if (/^https?:\/\//i.test(origin) && !found.includes(origin)) found.push(origin);
  };
  push(getWebOsPcRelayOrigin());
  push(scoped.__IPTV_RELAY_ORIGIN__);
  const extra = scoped.__IPTV_RELAY_CANDIDATES__;
  if (Array.isArray(extra)) extra.forEach(push);
  return found;
}

async function probeWebOsPcRelayOrigin(origin: string): Promise<boolean> {
  const probeUrls = [`${origin}/__iptv_ping`, `${origin}/__stream`];
  for (const probeUrl of probeUrls) {
    const attempt = (mode: RequestMode) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(ok);
        };
        const timer = window.setTimeout(() => finish(false), 1800);
        fetch(probeUrl, { method: "GET", mode, cache: "no-store" })
          .then((res) => finish(mode === "no-cors" ? true : res.status > 0))
          .catch(() => finish(false));
      });
    if (await attempt("cors")) return true;
    if (await attempt("no-cors")) return true;
  }
  return false;
}

async function resolveWebOsPcRelayOrigin(): Promise<string | null> {
  const candidates = webOsRelayCandidateOrigins();
  for (const origin of candidates) {
    if (await probeWebOsPcRelayOrigin(origin)) {
      setWebOsPcRelayOrigin(origin);
      return origin;
    }
  }
  return null;
}

export function setWebOsPcRelayOrigin(origin: string | null): string | null {
  const normalized = String(origin || "").trim().replace(/\/$/, "");
  const value = /^https?:\/\//i.test(normalized) ? normalized : "";
  try {
    if (value) window.localStorage.setItem(WEBOS_PC_RELAY_ORIGIN_KEY, value);
    else window.localStorage.removeItem(WEBOS_PC_RELAY_ORIGIN_KEY);
  } catch {
    // Ignore storage errors on locked-down webOS builds.
  }
  (window as Window & { __IPTV_RELAY_ORIGIN__?: string }).__IPTV_RELAY_ORIGIN__ = value || undefined;
  return value || null;
}

function getRelayBaseOrigin(): string | null {
  if (isWebOsRuntime()) return getWebOsPcRelayOrigin();

  const protocol = window.location.protocol;

  if (protocol === "http:" || protocol === "https:") {
    // For Capacitor/Android in development, allow access to the dev server's relay/transcode
    // The app must be loaded from the dev server (e.g., http://192.168.1.100:4000)
    if (isCapacitorRuntime()) {
      // If running from a network IP (not localhost), use that origin
      const host = window.location.hostname;
      if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "app") {
        return window.location.origin;
      }
      // For localhost/app on Android (e.g., Firestick), the native proxy intercepts
      // requests on the same origin via WebView's shouldInterceptRequest
      const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
      const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
      if (explicitRelayOrigin) {
        return explicitRelayOrigin;
      }
      // Use the app's own origin - the native Android proxy intercepts /__stream requests
      return window.location.origin;
    }
    // Only local dev/preview hosts expose the Vite relay/transcode middleware.
    return isLikelyLocalRuntime() ? window.location.origin : null;
  }

  if (protocol === "file:") {
    // For Electron, use the explicit relay origin or default
    if (isElectronRuntime()) {
      const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
      const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
      return explicitRelayOrigin || DEFAULT_ELECTRON_RELAY_ORIGIN;
    }
    // For Capacitor/Android, the native proxy intercepts requests via WebView
    // Use explicit relay origin if set, otherwise try localhost:4173 as fallback
    if (isCapacitorRuntime()) {
      const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
      const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
      if (explicitRelayOrigin) {
        return explicitRelayOrigin;
      }
      // Fallback for file:// protocol - native proxy may listen on localhost:4173
      return "http://localhost:4173";
    }
    return null;
  }

  return null;
}

function toRelayUrl(pathWithQuery: string): string | null {
  const relayBase = getRelayBaseOrigin();
  if (!relayBase) return null;
  return `${relayBase}${pathWithQuery}`;
}

function nextGlobalPlayAttemptId(): number {
  const scopedWindow = window as Window & { __iptvGlobalPlayAttemptId?: number };
  scopedWindow.__iptvGlobalPlayAttemptId = (scopedWindow.__iptvGlobalPlayAttemptId || 0) + 1;
  return scopedWindow.__iptvGlobalPlayAttemptId;
}

function isCurrentGlobalPlayAttempt(id: number): boolean {
  const scopedWindow = window as Window & { __iptvGlobalPlayAttemptId?: number };
  return (scopedWindow.__iptvGlobalPlayAttemptId || 0) === id;
}

function invalidateGlobalPlayAttempts() {
  const scopedWindow = window as Window & { __iptvGlobalPlayAttemptId?: number };
  scopedWindow.__iptvGlobalPlayAttemptId = (scopedWindow.__iptvGlobalPlayAttemptId || 0) + 1;
}

function shouldSuppressPlayerEvents(): boolean {
  return Date.now() < suppressPlayerEventsUntil;
}

function emitPlayerError(message: string) {
  if (shouldSuppressPlayerEvents()) return;
  window.dispatchEvent(new CustomEvent("playerError", { detail: { message } }));
}

function emitPlayerReconnect(message: string) {
  if (shouldSuppressPlayerEvents()) return;
  window.dispatchEvent(new CustomEvent("playerReconnect", { detail: { message } }));
}

function emitPlayerPlaying() {
  if (shouldSuppressPlayerEvents()) return;
  // Successful playback should reset retry-chain protection.
  rapidRetryChain = { rootUrl: null, count: 0, lastAt: 0 };
  window.dispatchEvent(new CustomEvent("playerPlaying"));
}

function emitPlayerTranscoding(message: string) {
  if (shouldSuppressPlayerEvents()) return;
  window.dispatchEvent(new CustomEvent("playerTranscoding", { detail: { message } }));
}

function emitPlayerEnded() {
  if (shouldSuppressPlayerEvents()) return;
  window.dispatchEvent(new CustomEvent("playerEnded"));
}

async function teardownShakaPlayer() {
  if (!shakaPlayer) return;
  try {
    await shakaPlayer.destroy();
  } catch {
    // Ignore teardown errors while switching player engines.
  }
  shakaPlayer = null;
}

function selectPreferredHlsAudioTrack(hlsInstance: Hls) {
  const tracks = hlsInstance.audioTracks || [];
  if (!tracks.length) {
    return;
  }

  const preferredIndex = tracks.findIndex((track) => (track as { default?: boolean }).default) >= 0
    ? tracks.findIndex((track) => (track as { default?: boolean }).default)
    : 0;

  if (hlsInstance.audioTrack !== preferredIndex) {
    hlsInstance.audioTrack = preferredIndex;
  }
}

function isUnsupportedAudioDecoderError(mediaErr: MediaError | null | undefined): boolean {
  if (!mediaErr) return false;
  if (mediaErr.code !== MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return false;

  const msg = (mediaErr.message || "").toLowerCase();
  return (
    msg.includes("audio decoder initialization failed") ||
    msg.includes("decoder_error_not_supported") ||
    msg.includes("unsupportedconfig") ||
    msg.includes("unsupported config") ||
    msg.includes("audio") && (
      msg.includes("codec") || 
      msg.includes("decode") ||
      msg.includes("not support")
    )
  );
}

function normalizeStreamUrl(url: string): string {
  const trimmed = url.trim();

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }

  const hostLike = /^[^\s/]+\.[^\s/]+($|\/)/.test(trimmed);
  if (hostLike) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

function isLikelyLocalRuntime(): boolean {
  const host = window.location.hostname;
  const port = window.location.port;

  // Capacitor always runs on localhost, but usually without a port (or port 80/443).
  // Dev environments usually run on 5173 (Vite).
  if (port === "5173" || port === "3000" || port === "4173") return true;

  if (host === "localhost") return true;

  if (host === "127.0.0.1") return true;
  if (host.endsWith(".local") || host.endsWith(".lan")) return true;

  // Private network hosts (common when testing on TV/device via LAN IP).
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;

  // Vite/Capacitor dev usually runs on an explicit dev port.
  if (window.location.port === "5173") return true;

  return false;
}

/** FFmpeg /__transcode exists only on desktop dev/Electron — not in the Fire TV APK. */
function isTranscodeAvailable(): boolean {
  const relayBase = getRelayBaseOrigin();
  if (!relayBase) return false;

  if (isCapacitorRuntime()) {
    const host = window.location.hostname;
    // Production Capacitor serves from http://app — native proxy only, no transcode.
    if (host === "app") return false;
    if (host === "localhost" && !window.location.port) return false;
    // LAN dev against Vite (e.g. http://192.168.x.x:5173) can transcode.
    return isLikelyLocalRuntime();
  }

  return isLikelyLocalRuntime() || !!relayBase;
}

function isElectronRuntime(): boolean {
  return /\belectron\b/i.test(navigator.userAgent || "");
}

function hasQueryParam(url: string, key: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.searchParams.has(key);
  } catch {
    return new RegExp(`[?&]${key}=`).test(url);
  }
}

function isAlreadyRelayed(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (
    lower.includes("/__stream") ||
    lower.includes("/__playlist") ||
    lower.includes("/__transcode") ||
    lower.includes("corsproxy.io")
  ) {
    return true;
  }

  // Same-origin relay detection. On webOS file:// hostname is empty, and
  // checking `hostname + "/"` would be just "/", which matches every URL.
  const host = String(window.location.hostname || "").toLowerCase();
  if (!host || host === "localhost" || host === "127.0.0.1") return false;
  try {
    return new URL(url).hostname.toLowerCase() === host;
  } catch {
    return false;
  }
}








function isTranscodeBootstrapUrl(url: string): boolean {
  return url.includes("/__transcode?") && hasQueryParam(url, "url");
}

function isTranscodeSessionUrl(url: string): boolean {
  return url.includes("/__transcode/session/");
}

function isLikelyHlsManifestUrl(url: string): boolean {
  return /\.m3u8(?:\?|$)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url);
}

function isLikelyTransportStreamUrl(url: string): boolean {
  return /\.ts(?:\?|$)/i.test(url);
}

function listXtreamVodContainerUrls(url: string, preferBrowserSafe: boolean): string[] {
  const match = url.match(/^(https?:\/\/.+\/(?:movie|series)\/[^/]+\/[^/]+\/\d+)\.([a-z0-9]+)(?:\?|$)/i);
  if (!match) return [url];
  const base = match[1];
  const current = match[2].toLowerCase();
  const queryIndex = url.indexOf("?");
  const query = queryIndex >= 0 ? url.slice(queryIndex) : "";
  const preferred = preferBrowserSafe
    ? ["mp4", "m3u8", "ts", "mkv"]
    : [current, "mp4", "m3u8", "ts", "mkv"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ext of preferred) {
    if (seen.has(ext)) continue;
    seen.add(ext);
    out.push(`${base}.${ext}${query}`);
  }
  return out;
}

function isHlsManifestPlaybackUrl(url: string): boolean {
  if (url.startsWith("blob:")) return true;
  if (url.includes("/__transcode") || url.includes("/__playlist")) return true;
  if (isWebOsRelayUrl(url)) return true;
  if (url.includes("/__stream")) {
    try {
      const inner = new URL(url, "http://localhost").searchParams.get("url") || "";
      return /\.m3u8(?:\?|$)/i.test(inner);
    } catch {
      return false;
    }
  }
  return isLikelyHlsManifestUrl(url);
}

function toWebOsLiveHlsUrl(url: string): string {
  if (!url || isLikelyHlsManifestUrl(url)) return url;

  // Xtream live MPEG-TS is not playable by webOS native <video>. The same
  // endpoint almost always exposes a sibling HLS playlist.
  if (/\/live\/[^/]+\/[^/]+\/[^/?#]+\.ts(?:\?|$)/i.test(url)) {
    return url.replace(/\.ts(?=\?|$)/i, ".m3u8");
  }

  const liveLeaf = url.match(/\/live\/[^/]+\/[^/]+\/([^/?#]+)(?:\?|$)/i)?.[1] || "";
  if (liveLeaf && !/\.[a-z0-9]+$/i.test(liveLeaf)) {
    return url.replace(/(\/live\/[^/]+\/[^/]+\/[^/?#]+)(?=\?|$)/i, "$1.m3u8");
  }

  if (/\.ts(?:\?|$)/i.test(url)) {
    return url.replace(/\.ts(?=\?|$)/i, ".m3u8");
  }

  return url;
}

function wrapTransportStreamInHlsManifest(url: string, isLive: boolean = false): string {
  // webOS Chromium cannot demux blob:file:// sources (FFmpegDemuxer open context failed).
  // Keep the real HTTP(S) stream URL so native playback can open it.
  if (isWebOsRuntime()) {
    return url;
  }

  // On Android/Fire TV, use the native __playlist proxy instead of an in-memory blob manifest.
  if (isCapacitorRuntime() && isLive) {
    const playlistUrl = toProxyFallbackUrl(url, true);
    if (playlistUrl) {
      return playlistUrl;
    }
  }

  // Always relay the internal URL to bypass CORS/Mixed Content
  const relayedUrl = toProxyFallbackUrl(url) || url;

  // For live streams, create a live HLS manifest (no ENDLIST, with proper live tags)
  if (isLive) {
    const manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:60.0,
${relayedUrl}`;
    const blob = new Blob([manifest], { type: "application/vnd.apple.mpegurl" });
    const blobUrl = URL.createObjectURL(blob);
    return blobUrl;
  }

  // For VOD, create a static manifest
  const manifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:60.0,
${relayedUrl}
#EXT-X-ENDLIST`;
  const blob = new Blob([manifest], { type: "application/vnd.apple.mpegurl" });
  const blobUrl = URL.createObjectURL(blob);
  return blobUrl;
}

function normalizeProblematicXtreamSourceUrl(url: string): string {
  // On Android/Capacitor, don't force .m3u8 extension here.
  // We'll handle .ts streams by wrapping them in a local manifest later,
  // which is more compatible than assuming the server supports .m3u8.
  if (isCapacitorRuntime()) {
    return url;
  }

  // webOS must keep HLS playlists. Raw MPEG-TS fails with MEDIA_ELEMENT_ERROR Format error.
  if (isWebOsRuntime()) {
    return url;
  }

  // Some Xtream live endpoints expose a nominal .m3u8 URL that returns a broken
  // manifest while the sibling .ts stream is stable enough for relay/transcode.
  if (/\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(url)) {
    return url.replace(/\.m3u8(?=\?|$)/i, ".ts");
  }

  return url;
}

function inferContentTypeFromUrl(url: string, currentType: ContentType): ContentType {
  if (currentType !== "live") return currentType;

  if (/\/(movie|vod)\//i.test(url)) {
    return "movie";
  }

  if (/\/series\//i.test(url)) {
    return "series";
  }

  return currentType;
}

function unwrapWrappedUrl(url: string): string {
  try {
    if (url.includes("/corsproxy.io/?")) {
      const idx = url.indexOf("?");
      if (idx >= 0) {
        return decodeURIComponent(url.slice(idx + 1));
      }
    }

    const parsed = new URL(url);
    const wrapped = parsed.searchParams.get("url");
    if (wrapped) {
      return decodeURIComponent(wrapped);
    }
  } catch {
    // Not a parseable wrapped URL.
  }

  return url;
}

function resolveRootSourceUrl(url: string): string {
  if (isTranscodeSessionUrl(url)) {
    return normalizeProblematicXtreamSourceUrl(lastRootSourceUrl || url);
  }

  if (isTranscodeBootstrapUrl(url)) {
    try {
      const parsed = new URL(url, window.location.href);
      const wrapped = parsed.searchParams.get("url");
      if (wrapped) {
        return normalizeProblematicXtreamSourceUrl(decodeURIComponent(wrapped));
      }
    } catch {
      // Fall through to generic unwrap logic.
    }
  }

  let current = url;
  for (let i = 0; i < 4; i++) {
    const next = unwrapWrappedUrl(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return normalizeProblematicXtreamSourceUrl(current);
}

function withWebOsTranscodeHint(url: string): string {
  if (!isWebOsRuntime() || !url.includes("/__transcode")) return url;
  if (/[?&]webos=1(?:&|$)/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}webos=1`;
}

function toPrimaryPlaybackUrl(url: string, preferTranscode = true): string {
  if (!/^https?:\/\//i.test(url)) return url;
  if (isAlreadyRelayed(url)) return url;

  // On Android/Capacitor, we handle all relaying logic inside playUrl()
  // to avoid Stage 0 hardware playback being accidentally relayed.
  if (isCapacitorRuntime()) return url;
  // webOS live must stay on the real HTTP URL. A baked-in PC IP is not FFmpeg.
  if (isWebOsRuntime()) return url;

  if (isLikelyLocalRuntime() || !!getRelayBaseOrigin()) {

    const relayBase = getRelayBaseOrigin();
    if (!relayBase) return url;

    if (!preferTranscode) {
      return `${relayBase}/__stream?url=${encodeURIComponent(url)}`;
    }
    const isVodLike = /\/(movie|series)\//i.test(url);
    const compatSuffix = isVodLike ? "&amode=compat" : "";
    return withWebOsTranscodeHint(`${relayBase}/__transcode?url=${encodeURIComponent(url)}${compatSuffix}`);
  }

  return url;
}

function rewriteHttpsToHttpUrl(url: string): string {
  return url.replace(/^https:\/\//i, "http://");
}

const webOsCapturedMediaUrls: string[] = [];
let webOsResourceObserver: PerformanceObserver | null = null;

function isWebOsCdnMediaUrl(url: string): boolean {
  return (
    /\/live\/play\//i.test(url) ||
    /vod\d+\./i.test(url) ||
    /ip1-st\d+/i.test(url) ||
    /\.ip1-st/i.test(url)
  );
}

function restoreHttpsForCdnRelay(url: string): string {
  if (/^http:\/\//i.test(url) && isWebOsCdnMediaUrl(url)) {
    return url.replace(/^http:\/\//i, "https://");
  }
  return url;
}

function toWebOsPcStreamUrl(url: string): string | null {
  const origin = getWebOsPcRelayOrigin();
  if (!origin || !/^https?:\/\//i.test(url)) return null;
  if (url.includes("/__stream")) return url;
  const target = restoreHttpsForCdnRelay(toWebOsLiveHlsUrl(url));
  return `${origin}/__stream?url=${encodeURIComponent(target)}`;
}

function noteWebOsCapturedMediaUrl(url: string) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (/corsproxy\.io/i.test(url)) return;
  if (!isWebOsCdnMediaUrl(url)) return;
  const httpUrl = rewriteHttpsToHttpUrl(url);
  if (webOsCapturedMediaUrls[webOsCapturedMediaUrls.length - 1] !== httpUrl) {
    webOsCapturedMediaUrls.push(httpUrl);
  }
}

function ensureWebOsResourceObserver() {
  if (!isWebOsRuntime() || webOsResourceObserver) return;
  try {
    webOsResourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        noteWebOsCapturedMediaUrl(String(entry.name || ""));
      }
    });
    webOsResourceObserver.observe({ type: "resource", buffered: true });
  } catch {
    webOsResourceObserver = null;
  }
}

function collectWebOsCdnUrls(streamId?: string): string[] {
  ensureWebOsResourceObserver();
  const names = [
    ...webOsCapturedMediaUrls,
    ...((performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map((entry) => String(entry.name || "")))
  ];
  const matches: string[] = [];
  for (const name of names) {
    if (!name || /corsproxy\.io|allorigins\.win/i.test(name)) continue;
    if (!isWebOsCdnMediaUrl(name)) continue;
    if (streamId && !name.includes(streamId)) continue;
    const httpUrl = rewriteHttpsToHttpUrl(name);
    if (!matches.includes(httpUrl)) matches.push(httpUrl);
  }
  return matches;
}

function findWebOsDiscoveredMediaUrl(originalUrl: string): string | null {
  try {
    const streamId =
      originalUrl.match(/\/(\d+)\.(?:m3u8|ts)(?:\?|$)/i)?.[1] ||
      originalUrl.match(/\/(\d+)(?:\?|$)/)?.[1];
    const matches = collectWebOsCdnUrls(streamId);
    return matches.length ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function probeWebOsRedirectUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const start = rewriteHttpsToHttpUrl(url);
    const streamId = start.match(/\/(\d+)\.(?:m3u8|ts)(?:\?|$)/i)?.[1];
    xhr.open("GET", start, true);
    xhr.timeout = 8000;
    const pickRedirect = (): string | null => {
      const xhrUrl = rewriteHttpsToHttpUrl(String(xhr.responseURL || ""));
      noteWebOsCapturedMediaUrl(xhrUrl);
      if (xhrUrl && xhrUrl !== start && isWebOsCdnMediaUrl(xhrUrl)) return xhrUrl;
      if (xhrUrl && streamId && xhrUrl.includes(streamId) && isWebOsCdnMediaUrl(xhrUrl)) return xhrUrl;
      return collectWebOsCdnUrls(streamId).pop() || null;
    };
    const finish = (delayMs: number) => {
      window.setTimeout(() => {
        const found = pickRedirect();
        resolve(found);
      }, delayMs);
    };
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2) noteWebOsCapturedMediaUrl(String(xhr.responseURL || ""));
    };
    xhr.onerror = () => finish(50);
    xhr.onload = () => finish(50);
    xhr.ontimeout = () => finish(50);
    try {
      xhr.send();
    } catch {
      resolve(collectWebOsCdnUrls(streamId).pop() || null);
    }
  });
}

function toWebOsPlaylistProxyUrl(url: string): string {
  const httpUrl = rewriteHttpsToHttpUrl(url);
  if (/allorigins\.win|codetabs\.com|corsproxy\.org/i.test(httpUrl)) return httpUrl;
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(httpUrl)}`;
}

const WEBOS_PLAYLIST_PROXIES: Array<(url: string) => string> = [
  (url) => `http://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.org/?${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
];

async function loadWebOsProxiedResponse(
  url: string,
  asText: boolean,
  signal?: AbortSignal
): Promise<string | ArrayBuffer> {
  const httpUrl = rewriteHttpsToHttpUrl(url);
  let lastError: Error | null = null;
  for (const build of WEBOS_PLAYLIST_PROXIES) {
    const proxied = build(httpUrl);
    try {
      const res = await fetch(proxied, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return asText ? await res.text() : await res.arrayBuffer();
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError || new Error("all playlist proxies failed");
}

async function loadWebOsProxiedText(url: string, signal?: AbortSignal): Promise<string> {
  return (await loadWebOsProxiedResponse(url, true, signal)) as string;
}

async function resolveWebOsLivePlaybackUrl(url: string): Promise<string> {
  if (isAlreadyRelayed(url) || isWebOsRelayUrl(url)) return url;
  const start = rewriteHttpsToHttpUrl(url);
  try {
    const res = await fetch(start, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      mode: "cors"
    });
    const loc = res.headers.get("Location") || res.headers.get("location");
    if (loc) {
      const next = rewriteHttpsToHttpUrl(new URL(loc, start).href);
      noteWebOsCapturedMediaUrl(next);
      return next;
    }
    if (res.ok) {
      const text = await res.text();
      if (/#EXTM3U/i.test(text)) {
        const rewritten = text.replace(/https:\/\//gi, "http://");
        const firstUri = rewritten
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith("#"));
        if (firstUri && /^https?:\/\//i.test(firstUri)) {
          return rewriteHttpsToHttpUrl(firstUri);
        }
      }
    }
  } catch (err) {
  }

  const probed = await probeWebOsRedirectUrl(start);
  if (probed) return probed;
  return findWebOsDiscoveredMediaUrl(start) || start;
}

async function loadWebOsHttpResource(
  url: string,
  responseType: string,
  signal?: AbortSignal
): Promise<{ finalUrl: string; data: string | ArrayBuffer }> {
  const keepHttps = isWebOsSimulator() || url.includes("/__stream");
  const current = keepHttps ? restoreHttpsForCdnRelay(url) : rewriteHttpsToHttpUrl(url);
  const wantsText = responseType !== "arraybuffer";

  if (isWebOsRelayUrl(current)) {
    const res = await fetch(current, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal
    });
    if (!res.ok) throw new Error(`relay HTTP ${res.status}`);
    if (!wantsText) return { finalUrl: current, data: await res.arrayBuffer() };
    let text = await res.text();
    if (/#EXTM3U/i.test(text)) text = text.replace(/https:\/\//gi, "http://");
    return { finalUrl: current, data: text };
  }

  try {
    const res = await fetch(current, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal
    });
    if (res.ok) {
      const finalUrl = rewriteHttpsToHttpUrl(res.url || current);
      if (!wantsText) return { finalUrl, data: await res.arrayBuffer() };
      let text = await res.text();
      if (/#EXTM3U/i.test(text)) text = text.replace(/https:\/\//gi, "http://");
      return { finalUrl, data: text };
    }
  } catch (err) {
  }

  if (wantsText) {
    const remote = await fetchWebOsRemote(current);
    if (remote?.text) {
      let text = remote.text;
      if (/#EXTM3U/i.test(text)) text = text.replace(/https:\/\//gi, "http://");
      return { finalUrl: rewriteHttpsToHttpUrl(remote.url || current), data: text };
    }
    throw new Error("webOS playlist fetch failed");
  }

  const pcRelay = getWebOsPcRelayOrigin();
  if (pcRelay) {
    const target = restoreHttpsForCdnRelay(current);
    const relayed = `${pcRelay}/__stream?url=${encodeURIComponent(target)}`;
    const res = await fetch(relayed, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal
    });
    if (!res.ok) throw new Error(`PC relay HTTP ${res.status}`);
    return { finalUrl: relayed, data: await res.arrayBuffer() };
  }

  throw new Error("webOS media fetch failed");
}

function createWebOsHlsLoader() {
  return class WebOsHttpHlsLoader {
    stats = {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 }
    };
    context: { url?: string; responseType?: string } | null = null;
    private callbacks: {
      onSuccess?: (response: { url: string; data: string | ArrayBuffer }, stats: unknown, context: unknown, networkDetails: unknown) => void;
      onError?: (error: { code: number; text: string }, context: unknown, networkDetails: unknown, stats: unknown) => void;
    } | null = null;
    private abortCtrl: AbortController | null = null;

    destroy() {
      this.abort();
      this.callbacks = null;
    }

    abort() {
      this.stats.aborted = true;
      try {
        this.abortCtrl?.abort();
      } catch {
        // ignore
      }
    }

    load(
      context: { url?: string; responseType?: string },
      _config: unknown,
      callbacks: {
        onSuccess?: (response: { url: string; data: string | ArrayBuffer }, stats: unknown, context: unknown, networkDetails: unknown) => void;
        onError?: (error: { code: number; text: string }, context: unknown, networkDetails: unknown, stats: unknown) => void;
      }
    ) {
      this.context = context;
      this.callbacks = callbacks;
      this.stats.loading.start = performance.now();
      this.abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      void loadWebOsHttpResource(String(context.url || ""), context.responseType || "text", this.abortCtrl?.signal)
        .then((result) => {
          if (this.stats.aborted) return;
          this.stats.loading.first = this.stats.loading.first || performance.now();
          this.stats.loading.end = performance.now();
          const data = result.data;
          this.stats.loaded = this.stats.total = typeof data === "string" ? data.length : data.byteLength;
          callbacks.onSuccess?.({ url: result.finalUrl, data }, this.stats, context, null);
        })
        .catch((err: Error & { code?: number }) => {
          if (this.stats.aborted) return;
          callbacks.onError?.(
            { code: typeof err.code === "number" ? err.code : 0, text: String(err.message || err) },
            context,
            null,
            this.stats
          );
        });
    }
  };
}

function clearVideoSources(video: HTMLVideoElement) {
  while (video.firstChild) {
    video.removeChild(video.firstChild);
  }
}

const IPTV_MEDIA_USER_AGENT = "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)";

function webOsMediaOption(transport: "HLS" | "URI"): Record<string, unknown> {
  return {
    mediaTransportType: transport,
    option: {
      adaptiveStreaming: { seamlessPlay: true },
      transmission: {
        httpHeader: {
          "User-Agent": IPTV_MEDIA_USER_AGENT
        }
      }
    }
  };
}

function assignWebOsMediaSource(video: HTMLVideoElement, url: string, transport: "HLS" | "URI") {
  const playUrl = transport === "HLS" ? rewriteHttpsToHttpUrl(url) : url;
  clearVideoSources(video);
  if (video.src && video.src.startsWith("blob:")) {
    try { URL.revokeObjectURL(video.src); } catch { /* ignore */ }
  }
  video.removeAttribute("src");

  // Chromium (simulator) rejects `type="video/mp4;mediaOption=..."`.
  if (isWebOsSimulator()) {
    video.src = playUrl;
    video.setAttribute("preload", "auto");
    video.load();
    return;
  }

  const option = webOsMediaOption(transport);
  const mediaOption = encodeURIComponent(JSON.stringify(option));
  const inner = (() => {
    try {
      return new URL(playUrl, "http://localhost").searchParams.get("url") || playUrl;
    } catch {
      return playUrl;
    }
  })();
  const mime =
    transport === "HLS"
      ? "application/x-mpegURL"
      : /\.mkv(?:\?|$)/i.test(inner)
        ? "video/x-matroska"
        : /\.ts(?:\?|$)/i.test(inner)
          ? "video/mp2t"
          : "video/mp4";
  const source = document.createElement("source");
  source.src = playUrl;
  source.type = `${mime};mediaOption=${mediaOption}`;
  video.appendChild(source);
  video.setAttribute("preload", "auto");
  try {
    (video as HTMLVideoElement & { mediaOption?: string }).mediaOption = JSON.stringify(option);
  } catch {
    // Older webOS builds ignore the property and still honor the source type.
  }
  video.src = playUrl;
  video.load();
}

function assignWebOsHlsSource(video: HTMLVideoElement, url: string) {
  assignWebOsMediaSource(video, url, "HLS");
}

function toHttpFallbackUrl(url: string): string | null {
  if (url.startsWith("https://")) {
    return `http://${url.slice("https://".length)}`;
  }

  if (url.startsWith("//")) {
    return `http:${url}`;
  }

  const hostLike = /^[^\s/]+\.[^\s/]+($|\/)/.test(url);
  if (hostLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return `http://${url}`;
  }

  return null;
}

function toProxyFallbackUrl(url: string, isTsStream: boolean = false): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;

  if (isCapacitorRuntime()) {
    // For Capacitor/Android, use the native proxy
    // Use getRelayBaseOrigin() to handle both http:// and file:// protocols
    const relayBase = getRelayBaseOrigin();
    const origin = relayBase || (window.location.protocol === "http:" || window.location.protocol === "https:" ? window.location.origin : null);
    if (!origin) return null;
    const endpoint = isTsStream ? "/__playlist" : "/__stream";
    const proxyUrl = `${origin}${endpoint}?url=${encodeURIComponent(url)}`;
    return proxyUrl;
  }

  return toRelayUrl(`/__stream?url=${encodeURIComponent(url)}`);
}






function toExternalProxyFallbackUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;
  if (isCapacitorRuntime()) {
    // For Capacitor/Android, use the native proxy
    // Use getRelayBaseOrigin() to handle both http:// and file:// protocols
    const relayBase = getRelayBaseOrigin();
    const origin = relayBase || (window.location.protocol === "http:" || window.location.protocol === "https:" ? window.location.origin : null);
    if (!origin) return null;
    return `${origin}/__stream?url=${encodeURIComponent(url)}`;
  }
  if (isWebOsRuntime()) {
    return null;
  }
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}


function toTranscodeFallbackUrl(
  url: string,
  videoOnly = false,
  audioMode: "standard" | "compat" | "safe" = "standard",
  audioStreamOrder: number | null = null
): string | null {
  // The TV has no FFmpeg. Sending live to a stale PC __transcode URL only
  // produces "transcode failed" after native HLS already had a chance.
  if (isWebOsRuntime()) {
    return null;
  }
  if (!isTranscodeAvailable()) return null;
  const relayBase = getRelayBaseOrigin();
  if (!relayBase) return null;
  const isSessionUrl = isTranscodeSessionUrl(url);
  if (!/^https?:\/\//i.test(url) && !isSessionUrl) return null;

  if (isTranscodeBootstrapUrl(url)) {
    try {
      const parsed = new URL(url, window.location.href);

      if (videoOnly) {
        parsed.searchParams.set("audio", "0");
        parsed.searchParams.delete("amode");
        parsed.searchParams.delete("aidx");
      } else {
        parsed.searchParams.delete("audio");
        if (audioMode === "safe" || audioMode === "compat") {
          parsed.searchParams.set("amode", audioMode);
        } else {
          parsed.searchParams.delete("amode");
        }

        if (typeof audioStreamOrder === "number" && audioStreamOrder >= 0) {
          parsed.searchParams.set("aidx", String(audioStreamOrder));
        } else {
          parsed.searchParams.delete("aidx");
        }
      }

      const nextUrl = parsed.toString();
      const hinted = withWebOsTranscodeHint(nextUrl);
      return hinted !== url ? hinted : null;
    } catch {
      let nextUrl = url;
      if (videoOnly && !/[?&]audio=0(?:&|$)/.test(nextUrl)) {
        nextUrl = `${nextUrl}&audio=0`;
      }

      if (videoOnly) {
        nextUrl = nextUrl
          .replace(/[?&]aidx=\d+(?=&|$)/, "")
          .replace(/\?&/, "?")
          .replace(/[?&]$/, "");
      }

      if (
        !videoOnly &&
        (audioMode === "safe" || audioMode === "compat") &&
        !new RegExp(`[?&]amode=${audioMode}(?:&|$)`).test(nextUrl)
      ) {
        nextUrl = `${nextUrl}&amode=${audioMode}`;
      }

      if (!videoOnly && audioMode === "standard") {
        nextUrl = nextUrl
          .replace(/[?&]amode=safe(?=&|$)/, "")
          .replace(/[?&]amode=compat(?=&|$)/, "")
          .replace(/\?&/, "?")
          .replace(/[?&]$/, "");
      }

      if (!videoOnly && typeof audioStreamOrder === "number" && audioStreamOrder >= 0) {
        if (!new RegExp(`[?&]aidx=${audioStreamOrder}(?:&|$)`).test(nextUrl)) {
          nextUrl = `${nextUrl}&aidx=${audioStreamOrder}`;
        }
      }

      if (!videoOnly && (audioStreamOrder === null || audioStreamOrder < 0)) {
        nextUrl = nextUrl
          .replace(/[?&]aidx=\d+(?=&|$)/, "")
          .replace(/\?&/, "?")
          .replace(/[?&]$/, "");
      }

      const hinted = withWebOsTranscodeHint(nextUrl);
      return hinted !== url ? hinted : null;
    }
  }

  if (isSessionUrl) {
    const rootUrl = resolveRootSourceUrl(url);
    if (!/^https?:\/\//i.test(rootUrl)) return null;
    const audioSuffix = videoOnly ? "&audio=0" : "";
    const audioModeSuffix = !videoOnly && audioMode !== "standard" ? `&amode=${audioMode}` : "";
    const audioIndexSuffix = !videoOnly && typeof audioStreamOrder === "number" && audioStreamOrder >= 0 ? `&aidx=${audioStreamOrder}` : "";
    return withWebOsTranscodeHint(`${relayBase}/__transcode?url=${encodeURIComponent(rootUrl)}${audioSuffix}${audioModeSuffix}${audioIndexSuffix}`);
  }

  const audioSuffix = videoOnly ? "&audio=0" : "";
  const audioModeSuffix = !videoOnly && audioMode !== "standard" ? `&amode=${audioMode}` : "";
  const audioIndexSuffix = !videoOnly && typeof audioStreamOrder === "number" && audioStreamOrder >= 0 ? `&aidx=${audioStreamOrder}` : "";
  return withWebOsTranscodeHint(`${relayBase}/__transcode?url=${encodeURIComponent(url)}${audioSuffix}${audioModeSuffix}${audioIndexSuffix}`);
}

function getAudioStreamOrderHint(url: string): number | null {
  try {
    const parsed = new URL(url, window.location.href);
    const raw = parsed.searchParams.get("aidx");
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return null;
    return n;
  } catch {
    const match = url.match(/[?&]aidx=(\d+)(?:&|$)/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
}

async function safePlay(video: HTMLVideoElement) {
  let usedMutedAutoplayFallback = false;

  try {
    await video.play();
    return;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotSupportedError") {
      // Let the media element error pipeline handle fallback progression.
      // Emitting a hard failure here can short-circuit transcode/proxy retries.
      return;
    }
    // Autoplay is often blocked unless muted; retry muted.
  }

  video.muted = true;
  usedMutedAutoplayFallback = true;
  try {
    await video.play();
    emitPlayerPlaying();

    if (usedMutedAutoplayFallback) {
      window.setTimeout(() => {
        try {
          video.muted = false;
          void video.play();
        } catch {
          // Keep muted if browser still blocks audible autoplay.
        }
      }, 350);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "InvalidStateError")) {
      // Non-fatal startup condition: autoplay/user-gesture policy or source race.
      // Let subsequent user interaction retry playback instead of surfacing a hard error.
      return;
    }
    console.error("Playback failed", err);
    emitPlayerError("Playback was blocked or failed to start.");
  }
}

export function initPlayerEngine() {
  videoEl = document.getElementById("player-main") as HTMLVideoElement | null;

  if (videoEl) {
    videoEl.playsInline = true;
    videoEl.setAttribute("playsinline", "true");
    videoEl.setAttribute("webkit-playsinline", "true");
    videoEl.onplaying = () => emitPlayerPlaying();
    videoEl.onended = () => emitPlayerEnded();
  }
}

export function stopPlayback() {
  playRequestToken += 1;
  invalidateGlobalPlayAttempts();
  suppressPlayerEventsUntil = Date.now() + 3000;

  stopNativePlayback();

  if (hls) {
    try {
      hls.stopLoad();
      hls.detachMedia();
      hls.destroy();
    } catch {
      // Ignore teardown errors while stopping playback.
    }
    hls = null;
  }

  void teardownShakaPlayer();

  videoEl = document.getElementById("player-main") as HTMLVideoElement | null;
  if (!videoEl) return;

  try {
    videoEl.pause();
    videoEl.onplaying = null;
    videoEl.onended = null;
    videoEl.onerror = null;
    if (videoEl.src && videoEl.src.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(videoEl.src);
      } catch {
        // Ignore stale blob cleanup errors.
      }
    }
    videoEl.removeAttribute("src");
    clearVideoSources(videoEl);
    if (!isCapacitorRuntime()) {
      videoEl.load();
    }
  } catch {
    // Ignore media element reset errors while stopping playback.
  }
}

export function playUrl(
  url: string,
  hasRetriedHttpFallback = false,
  forceNativePlayback = false,
  proxyFallbackStage = 0,
  hasTriedNativeFallback = false,
  hasTriedTranscodeFallback = false,
  hasRetriedTranscodeBootstrap = false,
  contentType: ContentType = "live"
) {
  // Always re-bind to the current DOM element in case React re-rendered and
  // replaced the element reference since the last initPlayerEngine() call.
  videoEl = document.getElementById("player-main") as HTMLVideoElement | null;
  if (isWebOsRuntime()) ensureWebOsResourceObserver();
  let normalizedUrl = normalizeProblematicXtreamSourceUrl(normalizeStreamUrl(url));
  contentType = inferContentTypeFromUrl(normalizedUrl, contentType);
  if (isWebOsRuntime() && contentType === "live") {
    if (normalizedUrl.includes("/__transcode")) {
      normalizedUrl = resolveRootSourceUrl(normalizedUrl);
    }
    if (isWebOsSimulator()) {
      if (!normalizedUrl.includes("/__stream")) {
        normalizedUrl = toWebOsLiveHlsUrl(normalizedUrl);
      }
    } else {
      normalizedUrl = toWebOsLiveHlsUrl(rewriteHttpsToHttpUrl(normalizedUrl));
    }
  }
  const isLiveContent = contentType === "live";
  const rootSourceUrlEarly = resolveRootSourceUrl(normalizedUrl);

  const nativeBridgeReady = isNativePlayerAvailable();
  const isVodContent = contentType === "movie" || contentType === "series";
  // ExoPlayer has no AVI/WMV extractor — keep the WebView fallback chain for those.
  const isExoUnsupportedVodContainer = isVodContent && /\.(avi|wmv)(?:[?#]|$)/i.test(rootSourceUrlEarly);
  const isNativeContent = isLiveContent || (isVodContent && !isExoUnsupportedVodContainer);
  const canUseNativeExo =
    isCapacitorRuntime() &&
    isNativeContent &&
    nativeBridgeReady &&
    !hasTriedNativeFallback &&
    !isTranscodeBootstrapUrl(normalizedUrl) &&
    !isTranscodeSessionUrl(normalizedUrl);

  // Fire TV native ExoPlayer does not need a WebView <video>. Creating one on
  // the main menu starts MediaTek codecs and LMK-kills the Stick.
  if (!videoEl && !canUseNativeExo) return;

  const token = ++playRequestToken;
  const globalAttemptId = nextGlobalPlayAttemptId();
  const isStaleRequest = () => token !== playRequestToken || !isCurrentGlobalPlayAttempt(globalAttemptId);
  let hasPlaybackStarted = false;

  // webOS movies/series play from the provider URL on the TV. Do not block
  // VOD on a PC FFmpeg relay the TV may not have.

  if (isWebOsRuntime() && isVodContent && !normalizedUrl.includes("/__transcode")) {
    normalizedUrl = rewriteHttpsToHttpUrl(normalizedUrl);
    const variants = listXtreamVodContainerUrls(normalizedUrl, isWebOsSimulator());
    if (variants.length > 0) {
      normalizedUrl = variants[Math.min(Math.max(proxyFallbackStage, 0), variants.length - 1)];
    }
  }

  const markPlaybackStarted = () => {
    if (isStaleRequest()) return;
    hasPlaybackStarted = true;
  };

  const ensureAudibleOnPlaying = () => {
    if (!videoEl || isStaleRequest()) return;

    let attempt = 0;
    const tryUnmute = () => {
      if (!videoEl || isStaleRequest()) return;
      attempt += 1;

      if (videoEl.muted || videoEl.volume < 1) {
        videoEl.muted = false;
        videoEl.volume = 1;
      }

      if (attempt >= 5) return;
      if (!videoEl.muted && videoEl.volume >= 1) return;

      window.setTimeout(() => {
        if (videoEl && !isStaleRequest()) {
          void videoEl.play().catch(() => {
            // Ignore retries while source/player engine settles.
          });
        }
        tryUnmute();
      }, 500);
    };

    tryUnmute();
  };

  if (videoEl) {
    videoEl.addEventListener("playing", markPlaybackStarted, { once: true });
    videoEl.addEventListener("playing", ensureAudibleOnPlaying);
    videoEl.muted = false;
    videoEl.onerror = null;
  }

  // Fire TV / Android: ExoPlayer handles continuous MPEG-TS + hardware codecs
  // for live, and starts movies/series far faster than WebView progressive
  // probing (which also cannot play MKV at all). Live native failure must not
  // fall back to WebView — that path ANRs Fire TV. VOD may still fall back.
  if (canUseNativeExo) {
    if (hls) {
      try {
        hls.stopLoad();
        hls.detachMedia();
        hls.destroy();
      } catch {
        // Ignore teardown errors while switching player engines.
      }
      hls = null;
    }

    void teardownShakaPlayer();

    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.onerror = null;
        if (videoEl.src && videoEl.src.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(videoEl.src);
          } catch {
            // Ignore stale blob cleanup errors.
          }
        }
        videoEl.removeAttribute("src");
      } catch {
        // Ignore media element reset errors.
      }
    }

    stopNativePlayback();
    const nativeUrl = normalizeStreamUrl(rootSourceUrlEarly);
    if (playNativeUrl(nativeUrl, contentType)) {
      const onNativeExoError = (event: Event) => {
        if (token !== playRequestToken) return;
        const detail = (event as CustomEvent<{ source?: string; message?: string }>).detail;
        if (detail?.source !== "native-exo") return;
        window.removeEventListener("playerError", onNativeExoError as EventListener);
        // Live MPEG-TS in WebView is what ANRs Fire TV (unbounded buffer + main-thread GC).
        // Do not fall back to the HTML player for live; surface the native error instead.
        if (isLiveContent) {
          console.error("[playUrl-native-exo] Native ExoPlayer failed; not falling back to WebView for live");
          emitPlayerError(detail?.message || "Native playback failed");
          return;
        }
        console.warn("[playUrl-native-exo] Native ExoPlayer failed, falling back to WebView relay");
        emitPlayerTranscoding("Native player failed, trying relay playback...");
        playUrl(
          url,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          true,
          hasTriedTranscodeFallback,
          hasRetriedTranscodeBootstrap,
          contentType
        );
      };
      window.addEventListener("playerError", onNativeExoError as EventListener);
      window.addEventListener(
        "playerPlaying",
        () => window.removeEventListener("playerError", onNativeExoError as EventListener),
        { once: true }
      );
      return;
    }
    if (!isCapacitorRuntime()) {
      console.warn("[playUrl-native-exo] Native bridge unavailable, falling back to WebView player");
    }
  }

  if (!videoEl) return;

  const allowLiveVideoOnlyFallback = true;
  const isRequestedTranscode =
    isTranscodeBootstrapUrl(normalizedUrl) ||
    isTranscodeSessionUrl(normalizedUrl);
  const allowTranscodeFallback =
    !isLiveContent ||
    (hasTriedNativeFallback && !hasTriedTranscodeFallback) ||
    isRequestedTranscode;
  const rootSourceUrl = resolveRootSourceUrl(normalizedUrl);
  const now = Date.now();

  if (!isLiveContent) {
    const attemptState = rootAttemptWindowState[rootSourceUrl];
    if (!attemptState || now - attemptState.firstAt > ATTEMPT_WINDOW_MS) {
      rootAttemptWindowState[rootSourceUrl] = { count: 1, firstAt: now };
    } else {
      attemptState.count += 1;
      if (attemptState.count > MAX_ATTEMPTS_PER_WINDOW) {
        blockedRootPlaybackUntil[rootSourceUrl] = now + RETRY_COOLDOWN_MS;
        rapidRetryChain = { rootUrl: null, count: 0, lastAt: 0 };

        if (hls) {
          try {
            hls.stopLoad();
            hls.detachMedia();
            hls.destroy();
          } catch {
            // ignore cleanup errors
          }
          hls = null;
        }

        if (videoEl) {
          try {
            videoEl.pause();
            videoEl.removeAttribute("src");
            videoEl.load();
          } catch {
            // ignore media cleanup errors
          }
        }

        emitPlayerError("Stream failed to start after multiple attempts. Please choose another channel.");
        return;
      }
    }

    const blockedUntil = blockedRootPlaybackUntil[rootSourceUrl] || 0;
    if (now < blockedUntil) {
      emitPlayerTranscoding("Retrying stream startup...");
      return;
    }

    // Prevent rapid fallback ping-pong loops for a single stream while avoiding
    // false positives across normal user actions.
    const isSameRapidChain =
      rapidRetryChain.rootUrl === rootSourceUrl &&
      now - rapidRetryChain.lastAt <= RAPID_RETRY_GAP_MS;

    if (isSameRapidChain) {
      rapidRetryChain.count += 1;
    } else {
      rapidRetryChain = { rootUrl: rootSourceUrl, count: 1, lastAt: now };
    }
    rapidRetryChain.lastAt = now;

    if (rapidRetryChain.count > MAX_RAPID_RETRIES) {
      console.warn(`[playUrl] rapid retry loop blocked for ${rootSourceUrl.slice(0, 120)}...`);
      blockedRootPlaybackUntil[rootSourceUrl] = now + RETRY_COOLDOWN_MS;
      rapidRetryChain = { rootUrl: null, count: 0, lastAt: 0 };

      if (hls) {
        try {
          hls.stopLoad();
          hls.detachMedia();
          hls.destroy();
        } catch {
          // ignore cleanup errors
        }
        hls = null;
      }

      if (videoEl) {
        try {
          videoEl.pause();
          videoEl.removeAttribute("src");
          videoEl.load();
        } catch {
          // ignore media cleanup errors
        }
      }

      emitPlayerError("Stream failed to start. Please choose another channel.");
      return;
    }
  }

  const fallbackBaseUrl = /^https?:\/\//i.test(rootSourceUrl) ? rootSourceUrl : normalizedUrl;
  const tryWebOsVodVariant = (reason: string): boolean => {
    if (!isWebOsRuntime() || isLiveContent) return false;
    const variants = listXtreamVodContainerUrls(fallbackBaseUrl, isWebOsSimulator());
    const nextStage = proxyFallbackStage + 1;
    if (nextStage >= variants.length) return false;
    playUrl(
      fallbackBaseUrl,
      hasRetriedHttpFallback,
      false,
      nextStage,
      false,
      hasTriedTranscodeFallback,
      hasRetriedTranscodeBootstrap,
      contentType
    );
    return true;
  };
  if (!isTranscodeSessionUrl(normalizedUrl)) {
    lastRootSourceUrl = rootSourceUrl;
  }
  const shouldPreferTranscode = isRequestedTranscode;
  const rebootstrapVodSessionUrl =
    !isLiveContent && isTranscodeSessionUrl(normalizedUrl)
      ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat")
      : null;
  const initialVodTranscodeUrl =
    !forceNativePlayback &&
    !isRequestedTranscode &&
    !isLiveContent &&
    !isWebOsRuntime()
      ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat")
      : null;
  const initialLiveTranscodeUrl =
    !forceNativePlayback &&
    !isRequestedTranscode &&
    isLiveContent &&
    !hasTriedTranscodeFallback &&
    !isWebOsRuntime()
      ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat")
      : null;
  const isCap = isCapacitorRuntime();
  // For Live TV on localhost/dev, use transcode instead of relay.
  // The relay just pipes raw stream data, which doesn't work for MPEG-TS streams in the browser.
  // The transcode endpoint uses FFmpeg to convert the stream to HLS, which the browser can play.
  const shouldUseTranscodeForLive = isLiveContent && (isLikelyLocalRuntime() || !!getRelayBaseOrigin());
  const liveRelayUrl = !isCap && !forceNativePlayback && !isRequestedTranscode && isLiveContent && !shouldUseTranscodeForLive
    ? toProxyFallbackUrl(rootSourceUrl)
    : null;
  const isManifestLikeSource = isLikelyHlsManifestUrl(rootSourceUrl);
  const isTransportStreamSource = isLikelyTransportStreamUrl(rootSourceUrl);
  const directNativeRelayUrl =
    !isCap && forceNativePlayback && isLiveContent && isTransportStreamSource
      ? toProxyFallbackUrl(rootSourceUrl)
      : null;

  let playbackUrl =
    directNativeRelayUrl ||
    (forceNativePlayback ? rootSourceUrl : null) ||
    rebootstrapVodSessionUrl ||
    (isRequestedTranscode ? normalizedUrl : null) ||
    initialVodTranscodeUrl ||
    initialLiveTranscodeUrl ||
    liveRelayUrl ||
    toPrimaryPlaybackUrl(rootSourceUrl, shouldPreferTranscode);

  if (
    isWebOsRuntime() &&
    isLiveContent &&
    !forceNativePlayback &&
    !isRequestedTranscode &&
    !isAlreadyRelayed(rootSourceUrl) &&
    !isWebOsRelayUrl(normalizedUrl) &&
    proxyFallbackStage < 2 &&
    !hasTriedNativeFallback
  ) {
    if (isWebOsSimulator()) {
      const relayed = toWebOsPcStreamUrl(rootSourceUrl);
      playbackUrl = relayed || toWebOsLiveHlsUrl(rootSourceUrl);
    } else {
      playbackUrl = toWebOsLiveHlsUrl(rewriteHttpsToHttpUrl(rootSourceUrl));
    }
  } else if (isWebOsSimulator() && isLiveContent && !playbackUrl.includes("/__stream")) {
    const relayed = toWebOsPcStreamUrl(rootSourceUrl);
    if (relayed) playbackUrl = relayed;
  }

  // On Android/Capacitor, we have a clear split strategy:
  // 1. Stage 0: Direct Hardware Path (Native Player + ORIGINAL URL).
  //    This uses Fire TV hardware decoders directly.
  //    We set the system-wide User-Agent to TiviMate in MainActivity.java to ensure access.
  // 2. Stage 1: Software Path (HLS.js + Native Proxy).
  //    Fallback for streams that need custom header manipulation or CORS bypass.
  const isTsContainer = isLikelyTransportStreamUrl(playbackUrl) || playbackUrl.toLowerCase().includes(".ts");

  if (isCap) {
    if (playbackUrl.includes("/__transcode")) {
      // Transcode session: use the local relay
      const relayed = toProxyFallbackUrl(playbackUrl);
      if (relayed) playbackUrl = relayed;
    } else if (isLiveContent && !isAlreadyRelayed(playbackUrl) && !playbackUrl.startsWith("blob:")) {
      if (isLikelyTransportStreamUrl(rootSourceUrl)) {
        // Live MPEG-TS: stage 0 = progressive __stream (hardware decode), stage 1+ = __playlist + HLS.js
        const usePlaylist = proxyFallbackStage > 0 || hasTriedNativeFallback;
        const relayed = toProxyFallbackUrl(rootSourceUrl, usePlaylist);
        if (relayed) {
          playbackUrl = relayed;
        }
      } else {
        // Live .m3u8: proxy manifest through native relay for HLS.js
        const relayed = toProxyFallbackUrl(rootSourceUrl, false);
        if (relayed) {
          playbackUrl = relayed;
        }
      }
    } else if (!isAlreadyRelayed(playbackUrl) && !isLiveContent && (proxyFallbackStage > 0 || hasTriedNativeFallback)) {
      const relayed = toProxyFallbackUrl(playbackUrl, isTsContainer);
      if (relayed) playbackUrl = relayed;
    }
  } else if (!isWebOsRuntime()) {
    const needsRelay = !isAlreadyRelayed(playbackUrl);
    if (needsRelay) {
      const relayed = toProxyFallbackUrl(playbackUrl);
      if (relayed) playbackUrl = relayed;
    }
  } else if (
    isVodContent &&
    isWebOsSimulator() &&
    !isHlsManifestPlaybackUrl(playbackUrl) &&
    !playbackUrl.includes("/__stream")
  ) {
    const relayed = toWebOsPcStreamUrl(playbackUrl);
    if (relayed) playbackUrl = relayed;
  }

  // Wrap .ts streams in HLS manifest for ALL platforms (including Android/Capacitor)
  // Android WebView's <video> element cannot natively play raw MPEG-TS streams,
  // so we must wrap them in an HLS manifest for HLS.js to handle them.
  if (
    isTsContainer &&
    !isWebOsRuntime() &&
    !playbackUrl.startsWith("blob:") &&
    !playbackUrl.includes("/__transcode") &&
    !playbackUrl.includes("/__playlist") &&
    !playbackUrl.includes("/__stream") &&
    !(isCap && isLiveContent && isLikelyTransportStreamUrl(rootSourceUrl))
  ) {
    playbackUrl = wrapTransportStreamInHlsManifest(playbackUrl, contentType === "live");
  }

  const capLiveTsUseProgressive =
    isCap &&
    isLiveContent &&
    isLikelyTransportStreamUrl(rootSourceUrl) &&
    playbackUrl.includes("/__stream") &&
    !playbackUrl.includes("/__playlist") &&
    proxyFallbackStage === 0 &&
    !hasTriedNativeFallback;

  const currentIsManifest =
    isHlsManifestPlaybackUrl(playbackUrl) ||
    (isWebOsRuntime() && /\/live\/play\//i.test(playbackUrl));
  const currentIsTransportStream = !currentIsManifest && (isLikelyTransportStreamUrl(playbackUrl) || playbackUrl.toLowerCase().includes(".ts"));

  // On Android, we ONLY use HLS.js for transcode or relay fallbacks (Stage 1+).
  // Native (ExoPlayer) is mandatory for stability and hardware codec support (MPEG2/AC3).
  // Also use HLS.js for blob URLs containing HLS manifests (from .ts stream wrapping).
  const webOsUseNativeHls = webOsSupportsNativeHls(videoEl);
  const allowWebOsHlsJs =
    isWebOsRuntime() &&
    currentIsManifest &&
    !playbackUrl.startsWith("blob:") &&
    (!webOsUseNativeHls ||
      hasTriedNativeFallback ||
      (isLiveContent && (isWebOsRelayUrl(playbackUrl) || playbackUrl.includes("/__stream"))));
  const shouldUseHlsJs =
    (!isWebOsRuntime() || allowWebOsHlsJs) &&
    (playbackUrl.includes("/__transcode") ||
      (!isCap && currentIsManifest) ||
      (isCap && playbackUrl.includes("/__playlist")) ||
      (isCap && playbackUrl.includes("/__stream") && !capLiveTsUseProgressive) ||
      (isCap && currentIsManifest && playbackUrl.startsWith("blob:")) ||
      (isCap && isLiveContent && isLikelyHlsManifestUrl(rootSourceUrl) && !isLikelyTransportStreamUrl(rootSourceUrl)));









  // Never use WebView native HLS on Android/Capacitor — it lacks reliable HLS support.
  const shouldUseNativeHls = !isCap && (currentIsManifest || playbackUrl.includes(".m3u8"));

  const shouldUseHlsJsPath = shouldUseHlsJs;

  const isLocalTranscodePlayback = playbackUrl.includes("/__transcode");
  const isVideoOnlyPlaybackUrl = /[?&]audio=0(?:&|$)/.test(playbackUrl);

  // Relay-first startup: only escalate to transcode after decoder/append failures.

  if (hls) {
    try {
      hls.stopLoad();
      hls.detachMedia();
    } catch {
      // May fail if already stopped/detached
    }
    try {
      hls.destroy();
    } catch {
      // Ignore errors during destruction
    }
    hls = null;
  }

  // Force the video element out of any lingering error state.
  // Setting a blank src and calling load() resets the network/error state.
  // Revoking stale blob URLs avoids leaking MediaSource objects.
  if (videoEl.src && videoEl.src.startsWith("blob:")) {
    try { URL.revokeObjectURL(videoEl.src); } catch { /* ignore */ }
  }
  clearVideoSources(videoEl);
  videoEl.removeAttribute("src");
  videoEl.load();

  // On webOS TVs, prefer native HLS playback for network manifests only.
  // On Android (Capacitor), ALWAYS use HLS.js if supported, as it's much better
  // at handling the variety of codecs and stream errors common in IPTV.
  const isWebOS = isWebOsRuntime();
  const isCapacitor = isCapacitorRuntime();
  const isBlobManifest = playbackUrl.startsWith("blob:");
  const isRealManifest =
    isLikelyHlsManifestUrl(playbackUrl) ||
    isBlobManifest ||
    isWebOsRelayUrl(playbackUrl) ||
    playbackUrl.includes("/__stream") ||
    playbackUrl.includes("/__transcode");

  // Blob-backed manifests are generated locally to feed HLS.js and should not be
  // handed to the webOS native HLS pipeline.
  // Only use Native HLS on webOS for network manifests.
  // On Android/Capacitor, we always want HLS.js if it's available.
  const preferNativeHls =
    isWebOS &&
    webOsUseNativeHls &&
    !hasTriedNativeFallback &&
    proxyFallbackStage < 2 &&
    !isBlobManifest &&
    !isWebOsRelayUrl(playbackUrl) &&
    !playbackUrl.includes("/__stream") &&
    isRealManifest;
  const allowHlsJsDespiteNativeFlag = isCap && isLiveContent && shouldUseHlsJsPath;
  const shouldEnterHlsPath =
    (!forceNativePlayback || allowHlsJsDespiteNativeFlag) &&
    shouldUseHlsJsPath &&
    !preferNativeHls &&
    !capLiveTsUseProgressive;

  if (shouldEnterHlsPath) {
    void (async () => {
      const HlsRuntime = await loadHlsModule();
      if (isStaleRequest()) return;
      if (!HlsRuntime.isSupported()) {
        if (isWebOsRuntime() && isLiveContent && !forceNativePlayback) {
          playUrl(
            rootSourceUrl,
            hasRetriedHttpFallback,
            true,
            proxyFallbackStage,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        }
        return;
      }

    // Skip Shaka Player on webOS/Android - use HLS.js or Native instead
    const shouldTryShakaForVodTranscode =
      !isWebOS &&
      !isCapacitor &&
      isLocalTranscodePlayback &&
      contentType !== "live" &&
      !isVideoOnlyPlaybackUrl &&
      !skipShakaOnce;


    if (shouldTryShakaForVodTranscode) {
      const launchShaka = async () => {
        let shakaFallbackStarted = false;
        const fallbackToDefaultPlayer = async (message?: string) => {
          if (shakaFallbackStarted || isStaleRequest()) return;
          shakaFallbackStarted = true;

          await teardownShakaPlayer();
          if (isStaleRequest()) return;

          skipShakaOnce = true;
          if (message) {
            emitPlayerTranscoding(message);
          }
          playUrl(
            normalizedUrl,
            hasRetriedHttpFallback,
            forceNativePlayback,
            proxyFallbackStage,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        };

        try {
          const shakaModule = await import("shaka-player");
          const shakaLib = (shakaModule as any).default || (shakaModule as any);

          if (!shakaLib?.Player?.isBrowserSupported?.()) {
            throw new Error("Shaka Player not supported in this browser");
          }

          if (isStaleRequest()) return;
          await teardownShakaPlayer();

          let shakaStartedPlayback = false;
          const onShakaPlaying = () => {
            shakaStartedPlayback = true;
          };

          if (videoEl) {
            videoEl.addEventListener("playing", onShakaPlaying);
          }

          shakaPlayer = new shakaLib.Player();
          await shakaPlayer.attach(videoEl);
          const bufferPreset = PLAYBACK_BUFFER_PRESETS[playbackBufferLevel];
          shakaPlayer.configure({
            preferredAudioLanguage: "eng",
            preferredAudioChannelCount: 2,
            streaming: {
              rebufferingGoal: bufferPreset.rebufferingGoal,
              bufferingGoal: bufferPreset.bufferingGoal
            }
          });

          shakaPlayer.addEventListener("error", () => {
            void fallbackToDefaultPlayer("Alternate player failed, retrying with default player...");
          });

          await shakaPlayer.load(playbackUrl);

          if (isStaleRequest()) {
            if (videoEl) {
              videoEl.removeEventListener("playing", onShakaPlaying);
            }
            await teardownShakaPlayer();
            return;
          }

          window.setTimeout(() => {
            if (isStaleRequest()) return;
            if (shakaStartedPlayback) return;

            if (videoEl) {
              videoEl.removeEventListener("playing", onShakaPlaying);
            }

            void fallbackToDefaultPlayer("Alternate player startup stalled, retrying with default player...");
          }, 7000);

          skipShakaOnce = false;
          if (videoEl) {
            await safePlay(videoEl);
            videoEl.removeEventListener("playing", onShakaPlaying);
          }
        } catch {
          await fallbackToDefaultPlayer();
        }
      };

      void launchShaka();
      return;
    }

    if (skipShakaOnce) {
      skipShakaOnce = false;
    }

    // Prefer audio mode recovery (compat/safe) before picture-only fallback.
    const preferFastPictureOnlyRecovery = false;
    const isAudioEnabledTranscode = isLocalTranscodePlayback && !/[?&]audio=0(?:&|$)/.test(playbackUrl);
    const currentAudioMode: "standard" | "compat" | "safe" = /[?&]amode=compat(?:&|$)/.test(playbackUrl)
      ? "compat"
      : /[?&]amode=safe(?:&|$)/.test(playbackUrl)
      ? "safe"
      : "standard";
    const currentAudioStreamOrder = getAudioStreamOrderHint(playbackUrl);
    const nextAudioStreamOrder =
      isAudioEnabledTranscode && contentType === "live"
        ? currentAudioStreamOrder === null
          ? 0
          : currentAudioStreamOrder < 7
          ? currentAudioStreamOrder + 1
          : null
        : null;
    const nextAudioMode =
      currentAudioMode === "standard" ? "compat" : currentAudioMode === "compat" ? "safe" : null;
    const bufferPreset = PLAYBACK_BUFFER_PRESETS[playbackBufferLevel];
    const isCapLiveHlsRelay =
      isCapacitorRuntime() && contentType === "live" && playbackUrl.includes("/__playlist");
    const useLiveHlsTuning = (isLocalTranscodePlayback || isCapLiveHlsRelay) && contentType === "live";
    const useWebOsHttpLoader =
      isWebOsRuntime() &&
      contentType === "live" &&
      !isWebOsRelayUrl(playbackUrl) &&
      !playbackUrl.includes("/__stream") &&
      !playbackUrl.includes("/__transcode");
    const WebOsLoader = useWebOsHttpLoader ? createWebOsHlsLoader() : undefined;
    if (useWebOsHttpLoader) {
    } else if (isWebOsRuntime() && isWebOsRelayUrl(playbackUrl)) {
    }
    hls = new HlsRuntime({
      enableWorker: !isLocalTranscodePlayback && !isCapacitorRuntime() && !isWebOsRuntime(),
      defaultAudioCodec:
        isLocalTranscodePlayback && !/[?&]amode=safe(?:&|$)/.test(playbackUrl)
          ? "mp4a.40.2"
          : undefined,
      startPosition: isLocalTranscodePlayback && contentType !== "live" ? 0 : -1,
      lowLatencyMode: useLiveHlsTuning,

      liveDurationInfinity: useLiveHlsTuning,
      manifestLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 20000,
      levelLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 10000,
      fragLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 20000,
      manifestLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 1,
      levelLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 2,
      fragLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 2,
      manifestLoadingRetryDelay: 1000,
      levelLoadingRetryDelay: 1000,
      fragLoadingRetryDelay: 1000,
      maxBufferLength: bufferPreset.bufferingGoal,
      maxMaxBufferLength: bufferPreset.bufferingGoal,
      ...(WebOsLoader ? { loader: WebOsLoader, fLoader: WebOsLoader, pLoader: WebOsLoader } : {})
    });
    let fatalHandled = false;
    let mediaRecoveryTried = false;
    let startupFallbackTimer: number | null = null;
    let hasLoadedMetadata = false;
    let hasStartedPlayback = false;
    let hasManifestParsed = false;
    let noVideoFrameCheckTimer: number | null = null;
    let audioSilentCheckTimer: number | null = null;
    let hasEscalatedUnsupportedAudio = false;
    let audioDecodeStallStrikes = 0;
    let lastEscalationTime = 0; // Cooldown to prevent rapid decoder error restart loops
    let delayedLocalAudioEscalationTimer: number | null = null;
    let hasUsedLiveVideoOnlyFallback = false;

    const clearStartupFallbackTimer = () => {
      if (startupFallbackTimer !== null) {
        window.clearTimeout(startupFallbackTimer);
        startupFallbackTimer = null;
      }
    };

    const clearAudioSilentCheckTimer = () => {
      if (audioSilentCheckTimer !== null) {
        window.clearTimeout(audioSilentCheckTimer);
        audioSilentCheckTimer = null;
      }
    };

    const clearNoVideoFrameCheckTimer = () => {
      if (noVideoFrameCheckTimer !== null) {
        window.clearTimeout(noVideoFrameCheckTimer);
        noVideoFrameCheckTimer = null;
      }
    };

    const clearDelayedLocalAudioEscalationTimer = () => {
      if (delayedLocalAudioEscalationTimer !== null) {
        window.clearTimeout(delayedLocalAudioEscalationTimer);
        delayedLocalAudioEscalationTimer = null;
      }
    };

    const clearStartupWatchdogIfCurrent = () => {
      if (!isStaleRequest()) {
        hasLoadedMetadata = true;
        clearStartupFallbackTimer();
        clearAudioSilentCheckTimer();
        clearNoVideoFrameCheckTimer();
        clearDelayedLocalAudioEscalationTimer();
      }
    };

    // Watchdog only for relay (non-transcode) paths.
    // Escalate to transcode only when we see explicit unsupported-audio decoder errors.
    if (!isLocalTranscodePlayback) {
      const isCapWatchdog = isCapacitorRuntime();
      // Progressive TS relay can take longer on first connect (redirect + buffer).
      const startupTimeoutMs = contentType === "live" ? (isCapWatchdog ? 30000 : 8000) : 15000;
      startupFallbackTimer = window.setTimeout(() => {
        if (isStaleRequest()) return;
        if (hasStartedPlayback || (contentType !== "live" && hasLoadedMetadata)) return;
        if (hasManifestParsed && contentType === "live") return;

        const mediaErr = videoEl?.error;
        const isAudioDecoderUnsupported = isUnsupportedAudioDecoderError(mediaErr);

        if (!isAudioDecoderUnsupported) {
          // Live startup can stall with no explicit decoder error. In that case,
          // try one native fallback path only.
          if (contentType === "live" && !hasLoadedMetadata && !hasStartedPlayback && !hasTriedNativeFallback) {
            if (isCapWatchdog && isLikelyTransportStreamUrl(rootSourceUrl)) {
              emitPlayerTranscoding("Live startup stalled, trying HLS playlist relay...");
              playUrl(
                rootSourceUrl,
                hasRetriedHttpFallback,
                false,
                1,
                true,
                hasTriedTranscodeFallback,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
            if (isCapWatchdog) return;

            emitPlayerTranscoding("Live startup stalled, trying direct playback...");
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              true,
              proxyFallbackStage,
              true,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }

          // If live still does not start after native fallback, try one transcode rescue.
          if (contentType === "live" && !hasLoadedMetadata && !hasStartedPlayback && hasTriedNativeFallback && !hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "safe");
            if (transcodeUrl) {
              emitPlayerTranscoding("Native startup stalled, trying safe-audio transcoder...");
              playUrl(
                transcodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          // Avoid additional fallback transitions on generic startup stalls.
          return;
        }

        // If transcode was already attempted in this playback chain, don't escalate again.
        if (hasTriedTranscodeFallback) {
          return;
        }

        if (contentType === "live") {
          if (!hasTriedNativeFallback) {
            emitPlayerTranscoding("Native audio decoder rejected stream, trying direct playback...");
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              true,
              proxyFallbackStage,
              true,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
          } else if (isTransportStreamSource && !hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
            if (transcodeUrl) {
              emitPlayerTranscoding("Direct playback still failing, trying compat-audio transcoder...");
              playUrl(
                transcodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
            }
          } else if (!hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "safe");
            if (transcodeUrl) {
              emitPlayerTranscoding("Native decoder still failing, trying safe-audio transcoder...");
              playUrl(
                transcodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
            }
          }
          return;
        }

        const transcodeUrl = allowTranscodeFallback ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat") : null;
        if (transcodeUrl && !hasEscalatedUnsupportedAudio) {
          hasEscalatedUnsupportedAudio = true;
          emitPlayerTranscoding("Native audio decoder rejected stream, switching to local transcoder...");
          playUrl(
            transcodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        }
      }, startupTimeoutMs);
    } else if (isLocalTranscodePlayback) {
      // Give FFmpeg enough time to produce the initial manifest/segments before
      // falling through to alternate transcode recovery modes.
      const transcodeStartupTimeoutMs = contentType === "live" ? 15000 : 45000;
      startupFallbackTimer = window.setTimeout(() => {
        if (isStaleRequest()) {
          return;
        }
        if (videoEl?.readyState && videoEl.readyState >= 2) {
          return;
        }

        if (nextAudioMode) {
          const nextModeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, nextAudioMode);
          if (nextModeUrl) {
            emitPlayerTranscoding(`Transcode startup stalled, trying ${nextAudioMode}-audio transcoder...`);
            playUrl(
              nextModeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (contentType === "live") {
          const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
          if (videoOnlyTranscodeUrl && allowLiveVideoOnlyFallback) {
            emitPlayerTranscoding("Transcode startup stalled, trying video-only transcoder...");
            playUrl(
              videoOnlyTranscodeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }

          emitPlayerError("Live transcode startup failed.");
          return;
        }

        const relayFallbackUrl = toProxyFallbackUrl(rootSourceUrl);
        if (relayFallbackUrl) {
          console.warn(`[transcode-startup-timeout] switching to relay after 5s delay`);
          emitPlayerTranscoding("Transcoder startup taking too long, switching to relay playback...");
          playUrl(
            relayFallbackUrl,
            hasRetriedHttpFallback,
            false,
            1,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        }
      }, transcodeStartupTimeoutMs);
    }

    if (contentType !== "live") {
      videoEl.addEventListener("loadedmetadata", clearStartupWatchdogIfCurrent, { once: true });
      videoEl.addEventListener("canplay", clearStartupWatchdogIfCurrent, { once: true });
    }

    videoEl.addEventListener(
      "playing",
      () => {
        if (isStaleRequest()) return;
        hasStartedPlayback = true;
        hasPlaybackStarted = true;
        clearStartupWatchdogIfCurrent();

        // Some streams report playing but never produce video frames in browser decode path.
        // For live content, try one compat transcode fallback if dimensions stay zero.
        if (contentType === "live" && !hasTriedTranscodeFallback) {
          clearNoVideoFrameCheckTimer();
          noVideoFrameCheckTimer = window.setTimeout(() => {
            if (isStaleRequest()) return;
            if (!videoEl) return;
            const hasVideoFrame = videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
            if (hasVideoFrame) return;

            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "safe");
            if (!transcodeUrl) return;

            emitPlayerTranscoding("No video frame detected, trying safe-audio transcoder...");
            playUrl(
              transcodeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
          }, 1500);
        }
      },
      { once: true }
    );

    // Detect silent audio failures (video plays but no sound)
    // Use a conservative detector to avoid false positives while decoders warm up.
    const setupAudioSilentMonitor = () => {
      if (contentType !== "live" && !isWebOsRuntime()) return;
      if (audioSilentCheckTimer !== null) return; // Already monitoring
      
      audioSilentCheckTimer = window.setTimeout(() => {
        if (isStaleRequest()) return;
        if (!videoEl || videoEl.paused || videoEl.muted) return;
        
        const checkDecodedAudioProgress = (attempt: number) => {
          if (isStaleRequest()) return;
          if (!videoEl || videoEl.paused) return;

          const startTime = videoEl.currentTime;
          const decodedAudioStart = (videoEl as any).webkitAudioDecodedByteCount as number | undefined;

          window.setTimeout(() => {
            if (isStaleRequest()) return;
            if (!videoEl || videoEl.paused) return;

            const currentTime = videoEl.currentTime;
            const isPlaying = currentTime > startTime + 1.0; // Require clearer playback advancement
            const decodedAudioEnd = (videoEl as any).webkitAudioDecodedByteCount as number | undefined;
            const hasDecodeCounters =
              typeof decodedAudioStart === "number" && typeof decodedAudioEnd === "number";
            const isAudioDecodeStalled = hasDecodeCounters && decodedAudioEnd <= decodedAudioStart;

            if (isPlaying && hasDecodeCounters && isAudioDecodeStalled) {
              audioDecodeStallStrikes += 1;
            } else {
              audioDecodeStallStrikes = 0;
            }

            const likelySilentAudio =
              isPlaying &&
              audioDecodeStallStrikes >= 2 &&
              (isAudioEnabledTranscode || (isWebOsRuntime() && contentType !== "live"));

            if (!likelySilentAudio && attempt < 2) {
              checkDecodedAudioProgress(attempt + 1);
              return;
            }

            if (!likelySilentAudio) {
              return;
            }

            audioDecodeStallStrikes = 0;

            if (likelySilentAudio && nextAudioMode && !preferFastPictureOnlyRecovery) {
              const nextModeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, nextAudioMode);
              if (nextModeUrl) {
                clearAudioSilentCheckTimer();
                emitPlayerTranscoding(`Video plays but audio silent - trying ${nextAudioMode} audio mode...`);
                playUrl(
                  nextModeUrl,
                  hasRetriedHttpFallback,
                  false,
                  proxyFallbackStage,
                  hasTriedNativeFallback,
                  true,
                  hasRetriedTranscodeBootstrap,
                  contentType
                );
                return;
              }
            }

            if (likelySilentAudio && isLocalTranscodePlayback && !nextAudioMode) {
              if (contentType === "live") {
                if (nextAudioStreamOrder !== null) {
                  const alternateAudioTrackUrl = toTranscodeFallbackUrl(
                    rootSourceUrl,
                    false,
                    currentAudioMode,
                    nextAudioStreamOrder
                  );
                  if (alternateAudioTrackUrl) {
                    clearAudioSilentCheckTimer();
                    emitPlayerTranscoding(`Audio silent, trying alternate audio track ${nextAudioStreamOrder + 1}...`);
                    playUrl(
                      alternateAudioTrackUrl,
                      hasRetriedHttpFallback,
                      false,
                      proxyFallbackStage,
                      hasTriedNativeFallback,
                      true,
                      hasRetriedTranscodeBootstrap,
                      contentType
                    );
                    return;
                  }
                }

                clearAudioSilentCheckTimer();
                emitPlayerError("Live stream audio is not decoding on this device.");
                return;
              }

              const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
              if (videoOnlyTranscodeUrl) {
                clearAudioSilentCheckTimer();
                emitPlayerTranscoding("Transcoded audio appears silent in all modes, restoring picture with video-only playback...");
                playUrl(
                  videoOnlyTranscodeUrl,
                  hasRetriedHttpFallback,
                  false,
                  proxyFallbackStage,
                  hasTriedNativeFallback,
                  true,
                  hasRetriedTranscodeBootstrap,
                  contentType
                );
                return;
              }
            }

            if (likelySilentAudio && !nextAudioMode) {
              emitPlayerError("Video is playing but audio is not decoding in this browser.");
            }
          }, 1400);
        };

        checkDecodedAudioProgress(1);
      }, 3000); // Initial check at 3 seconds
    };

    videoEl.addEventListener("playing", setupAudioSilentMonitor);

    // If the media element reports unsupported audio decoder config, escalate audio compatibility.
    // This covers both relay and transcode paths where Hls fatal details may be too generic.
    videoEl.onerror = () => {
      if (isStaleRequest()) return;
      const mediaErr = videoEl?.error;
      console.error(`[video-error] code=${mediaErr?.code} message=${mediaErr?.message}`);
      const isUnsupportedAudio = isUnsupportedAudioDecoderError(mediaErr);

      // Check if it's an audio decoder error first - handle these even after playback started
      if (!isUnsupportedAudio) {
        // For non-audio-decoder errors, ignore after startup has progressed
        if (hasPlaybackStarted || hasLoadedMetadata || hasStartedPlayback) {
          return;
        }
      }

      if (!isUnsupportedAudio) return;

      if (
        isLocalTranscodePlayback &&
        isLiveContent &&
        allowLiveVideoOnlyFallback &&
        isAudioEnabledTranscode &&
        !nextAudioMode &&
        !/[?&]audio=0(?:&|$)/.test(playbackUrl) &&
        !hasUsedLiveVideoOnlyFallback
      ) {
        hasUsedLiveVideoOnlyFallback = true;
        clearStartupFallbackTimer();
        clearDelayedLocalAudioEscalationTimer();
        if (videoEl) {
          videoEl.onerror = null;
        }

        const videoOnlyUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
        if (videoOnlyUrl) {
          emitPlayerTranscoding("Audio decoder not supported, switching to video-only playback...");
          playUrl(
            videoOnlyUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      // Debounce rapid decoder errors to prevent restart loop (e.g., every ~30ms)
      const now = Date.now();
      const timeSinceLastEscalation = now - lastEscalationTime;
      if (timeSinceLastEscalation < 3000) {
        return;
      }

      clearStartupFallbackTimer();

      if (isLocalTranscodePlayback) {
        // For local transcode, first retry with audio compatibility modes before
        // dropping to video-only playback.
        if (isAudioEnabledTranscode && nextAudioMode) {
          const nextModeUrl = toTranscodeFallbackUrl(normalizedUrl, false, nextAudioMode);
          if (nextModeUrl) {
            lastEscalationTime = now;
            emitPlayerTranscoding(`Optimizing live audio (${nextAudioMode} mode)...`);
            playUrl(
              nextModeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (contentType === "live" && isAudioEnabledTranscode && nextAudioStreamOrder !== null) {
          const alternateAudioTrackUrl = toTranscodeFallbackUrl(
            normalizedUrl,
            false,
            currentAudioMode,
            nextAudioStreamOrder
          );
          if (alternateAudioTrackUrl) {
            lastEscalationTime = now;
            emitPlayerTranscoding(`Audio decoder rejected track, trying alternate audio track ${nextAudioStreamOrder + 1}...`);
            playUrl(
              alternateAudioTrackUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        const videoOnlyBootstrapUrl = toTranscodeFallbackUrl(normalizedUrl, true);
        if (videoOnlyBootstrapUrl && contentType === "live" && allowLiveVideoOnlyFallback) {
          lastEscalationTime = now;
          emitPlayerTranscoding("Audio decoder unsupported, restoring picture with video-only playback...");
          playUrl(
            videoOnlyBootstrapUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
        // Chromium can emit an early unsupported-audio media error during MSE startup
        // startup even when the manifest and init segment are valid. Let startup
        // continue unless the transcode still has not progressed after a grace period.
        if (isAudioEnabledTranscode && videoEl && videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          return;
        }

        clearDelayedLocalAudioEscalationTimer();
        const localEscalationDelayMs = 3500;
        delayedLocalAudioEscalationTimer = window.setTimeout(() => {
          if (isStaleRequest()) return;
          if (hasPlaybackStarted || hasStartedPlayback || hasLoadedMetadata) return;
          if (isAudioEnabledTranscode && videoEl && videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
            return;
          }

          if (isAudioEnabledTranscode && nextAudioMode) {
            const nextModeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, nextAudioMode);
            if (nextModeUrl) {
              lastEscalationTime = Date.now();
              emitPlayerTranscoding(`Optimizing live audio (${nextAudioMode} mode)...`);
              playUrl(
                nextModeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          if (contentType === "live" && isAudioEnabledTranscode && nextAudioStreamOrder !== null) {
            const alternateAudioTrackUrl = toTranscodeFallbackUrl(
              rootSourceUrl,
              false,
              currentAudioMode,
              nextAudioStreamOrder
            );
            if (alternateAudioTrackUrl) {
              lastEscalationTime = Date.now();
              emitPlayerTranscoding(`Audio decode still failing, trying alternate audio track ${nextAudioStreamOrder + 1}...`);
              playUrl(
                alternateAudioTrackUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
          if (videoOnlyTranscodeUrl && contentType === "live" && allowLiveVideoOnlyFallback) {
            lastEscalationTime = Date.now();
            emitPlayerTranscoding("Audio is not supported on this device for this stream, restoring picture-only playback...");
            playUrl(
              videoOnlyTranscodeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }

          if (videoOnlyTranscodeUrl && contentType !== "live" && !hasRetriedTranscodeBootstrap) {
            lastEscalationTime = Date.now();
            emitPlayerTranscoding("Audio decoder still unsupported, retrying with a fresh audio transcode session...");
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              true,
              contentType
            );
            return;
          }

          if (contentType === "live" && !hasRetriedTranscodeBootstrap) {
            emitPlayerTranscoding("Audio decode failed in current session, retrying with a fresh live transcode session...");
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              true,
              contentType
            );
            return;
          }

          if (contentType === "live" && !isVideoOnlyPlaybackUrl) {
            const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
            if (videoOnlyTranscodeUrl) {
              emitPlayerTranscoding("Audio decode failed in all modes, switching to picture-first playback...");
              playUrl(
                videoOnlyTranscodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                true,
                contentType
              );
              return;
            }
          }

          if (tryWebOsVodVariant("hls-audio-failed")) return;
          emitPlayerError("This stream format/codecs are not supported by your player.");
        }, localEscalationDelayMs);
        return;
      }

      if (!isLocalTranscodePlayback) {
        // Don't bounce back to transcode if this chain already tried it.
        if (hasTriedTranscodeFallback) {
          return;
        }

        if (contentType === "live") {
          if (!hasTriedNativeFallback) {
            emitPlayerTranscoding("Native audio decoder rejected stream, trying direct playback...");
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              true,
              proxyFallbackStage,
              true,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
          } else if (isTransportStreamSource && !hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
            if (transcodeUrl) {
              lastEscalationTime = now;
              emitPlayerTranscoding("Direct playback still failing, trying compat-audio transcoder...");
              playUrl(
                transcodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
            }
          }
          return;
        }

        const transcodeUrl = allowTranscodeFallback ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat") : null;
        if (transcodeUrl && !hasEscalatedUnsupportedAudio) {
          hasEscalatedUnsupportedAudio = true;
          lastEscalationTime = now;
          emitPlayerTranscoding("Native audio decoder rejected stream, switching to local transcoder...");
          playUrl(
            transcodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        }
        return;
      }

      // Local transcode sessions can still hit unsupported audio decoder configs
      // on some Chromium builds. Allow the fallback chain below to switch
      // audio mode (compat/safe) or drop to video-only playback.

      if (nextAudioMode) {
        const nextModeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, nextAudioMode);
        if (nextModeUrl) {
          lastEscalationTime = now;
          emitPlayerTranscoding(`Optimizing live audio (${nextAudioMode} mode)...`);
          playUrl(
            nextModeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
      if (videoOnlyTranscodeUrl && contentType === "live" && allowLiveVideoOnlyFallback) {
        lastEscalationTime = now;
        emitPlayerTranscoding("Audio decoder unsupported in all modes, restoring picture with video-only transcoder...");
        playUrl(
          videoOnlyTranscodeUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          hasTriedNativeFallback,
          true,
          hasRetriedTranscodeBootstrap,
          contentType
        );
        return;
      }

      if (videoOnlyTranscodeUrl && contentType !== "live" && !hasRetriedTranscodeBootstrap) {
        lastEscalationTime = now;
        emitPlayerTranscoding("Audio decoder unsupported in this session, retrying with a fresh audio transcode session...");
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          hasTriedNativeFallback,
          true,
          true,
          contentType
        );
        return;
      }

      if (!hasTriedNativeFallback) {
        emitPlayerTranscoding("Trying direct native playback fallback...");
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          true,
          proxyFallbackStage,
          true,
          hasTriedTranscodeFallback,
          hasRetriedTranscodeBootstrap,
          contentType
        );
        return;
      }

      if (contentType === "live" && !hasRetriedTranscodeBootstrap) {
        emitPlayerTranscoding("Live decode still failing, retrying with a fresh transcode session...");
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          hasTriedNativeFallback,
          true,
          true,
          contentType
        );
        return;
      }

      if (contentType === "live" && proxyFallbackStage <= 1) {
        const externalProxyUrl = toExternalProxyFallbackUrl(rootSourceUrl);
        if (externalProxyUrl) {
          emitPlayerTranscoding("Live decode still failing, trying external relay fallback...");
          playUrl(
            externalProxyUrl,
            hasRetriedHttpFallback,
            false,
            2,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType === "live" && !isVideoOnlyPlaybackUrl) {
        const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
        if (videoOnlyTranscodeUrl) {
          emitPlayerTranscoding("Live decode failed in all audio modes, switching to picture-first playback...");
          playUrl(
            videoOnlyTranscodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            true,
            contentType
          );
          return;
        }
      }

      if (tryWebOsVodVariant("hls-decode-failed")) return;
      emitPlayerError("This stream format/codecs are not supported by your player.");
    };


    hls.on(HlsRuntime.Events.ERROR, (_, data) => {
      // Ignore errors from stale playback sessions - check FIRST
      if (isStaleRequest()) return;

      if (hasPlaybackStarted && isLiveContent) {
        if (data.fatal) {
          emitPlayerReconnect("Live connection lost, reconnecting...");
        }
        return;
      }

      if (hasPlaybackStarted) return;
      if (hasStartedPlayback || hasLoadedMetadata) return;
      
      if (data.fatal) {
        const fatalDetails = String(data.details || "");
        clearStartupFallbackTimer();
        if (fatalHandled) return;

        const errorMsg = data.error?.message || "";
        const reasonMsg = String((data as { reason?: unknown }).reason || "");
        const combinedMsg = `${errorMsg} ${reasonMsg}`;
        const isStaleSourceBufferAppend =
          fatalDetails === "bufferAppendError" &&
          /SourceBuffer has been removed/i.test(combinedMsg);

        if (isStaleSourceBufferAppend && !hasTriedNativeFallback && !isLocalTranscodePlayback) {
          emitPlayerTranscoding("HLS append failed, trying direct playback...");
          playUrl(
            rootSourceUrl,
            hasRetriedHttpFallback,
            true,
            proxyFallbackStage,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }

        // Suppress harmless stale append errors that occur during source switches.
        if (isStaleSourceBufferAppend || /SourceBuffer has been removed/i.test(combinedMsg)) {
          return;
        }

        console.error(`[hls-fatal] details=${fatalDetails} message=${data.error?.message || "unknown"}`);

        fatalHandled = true;

        const sourceBufferName = typeof data.sourceBufferName === "string" ? data.sourceBufferName : "";
        const dataUrl = typeof data.url === "string" ? data.url : "";
        
        console.error(
          "HLS fatal error",
          `[${fatalDetails}]`,
          `sourceBuffer=${sourceBufferName}`,
          `error=${errorMsg}`,
          data
        );

        const isTranscodeSessionManifestError =
          fatalDetails === "manifestLoadError" && isTranscodeSessionUrl(dataUrl);

        if (isTranscodeSessionManifestError && !hasRetriedTranscodeBootstrap && rootSourceUrl) {
          emitPlayerTranscoding("Transcoder warming up, retrying session...");
          playUrl(
            rootSourceUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            true,
            contentType
          );
          return;
        }

        // If transcode session manifest fails after bootstrap retry, or any fatal error during transcode, fallback to relay
        if (isLocalTranscodePlayback) {
          const relayFallbackUrl = toProxyFallbackUrl(rootSourceUrl);
          if (relayFallbackUrl && !preferFastPictureOnlyRecovery) {
            console.warn(`[transcode-fatal] ${fatalDetails}, falling back to relay`);
            emitPlayerTranscoding("Transcoder failed, switching to relay playback...");
            playUrl(
              relayFallbackUrl,
              hasRetriedHttpFallback,
              false,
              1,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }

          if (preferFastPictureOnlyRecovery && isAudioEnabledTranscode) {
            const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
            if (videoOnlyTranscodeUrl) {
              emitPlayerTranscoding("Transcoded audio failed, switching to picture-first video-only playback...");
              playUrl(
                videoOnlyTranscodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }
        }

        const isCodecAppendFailure =
          fatalDetails === "bufferAppendError" ||
          fatalDetails === "bufferAddCodecError" ||
          fatalDetails === "bufferCodecError";

        const isAudioAppendFailure = isCodecAppendFailure && sourceBufferName === "audio";

        if (isAudioAppendFailure) {
          if (preferFastPictureOnlyRecovery) {
            const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
            if (videoOnlyTranscodeUrl) {
              emitPlayerTranscoding("Audio pipeline failed, restoring picture with video-only playback...");
              playUrl(
                videoOnlyTranscodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          if (nextAudioMode) {
            const audioModeTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, nextAudioMode);
            if (audioModeTranscodeUrl) {
              emitPlayerTranscoding(`Audio pipeline unstable, retrying ${nextAudioMode}-audio transcoder...`);
              playUrl(
                audioModeTranscodeUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          if (currentAudioMode !== "standard" && isLiveContent) {
            const standardAudioUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "standard");
            if (standardAudioUrl) {
              emitPlayerTranscoding("Audio pipeline unstable, retrying standard-audio transcoder...");
              playUrl(
                standardAudioUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
          if (videoOnlyTranscodeUrl) {
            if (contentType === "live") {
              emitPlayerError("Live stream audio pipeline failed in all modes.");
              return;
            }

            emitPlayerTranscoding("Audio pipeline failed in all modes, restoring picture with video-only playback...");
            playUrl(
              videoOnlyTranscodeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }

          if (isLocalTranscodePlayback) {
            const relayFallbackUrl = toProxyFallbackUrl(rootSourceUrl);
            if (relayFallbackUrl) {
              emitPlayerTranscoding("Transcoded audio append failed in all local modes, retrying relay playback...");
              playUrl(
                relayFallbackUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                true,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          emitPlayerError("Stream audio codec is unstable on this browser/device.");
          return;
        }

        if (isCodecAppendFailure) {
          if (!hasTriedTranscodeFallback && allowTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(normalizedUrl);
            if (transcodeUrl) {
              emitPlayerTranscoding("Codec unsupported, trying local transcoder...");
              playUrl(
                rootSourceUrl,
                hasRetriedHttpFallback,
                false,
                proxyFallbackStage,
                hasTriedNativeFallback,
                true,
                hasRetriedTranscodeBootstrap,
                contentType
              );
              return;
            }
          }

          if (!hasTriedNativeFallback && !isLocalTranscodePlayback) {
            playUrl(
              rootSourceUrl,
              hasRetriedHttpFallback,
              true,
              proxyFallbackStage,
              true,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            emitPlayerTranscoding("Codec error in HLS path, trying direct stream playback...");
            return;
          }

          emitPlayerError("Stream uses unsupported video/audio codecs for this browser/device.");
          return;
        }

        if (data.type === HlsRuntime.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried) {
          mediaRecoveryTried = true;
          fatalHandled = false;
          try {
            hls?.recoverMediaError();
            return;
          } catch {
            // Continue with fallback chain below.
          }
        }

        if (!hasRetriedHttpFallback) {
          const fallbackUrl = toHttpFallbackUrl(fallbackBaseUrl);
          if (fallbackUrl) {
            playUrl(
              fallbackUrl,
              true,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (!isLiveContent && proxyFallbackStage === 0) {
          const proxyUrl = toProxyFallbackUrl(fallbackBaseUrl);
          if (proxyUrl) {
            playUrl(
              proxyUrl,
              hasRetriedHttpFallback,
              false,
              1,
              hasTriedNativeFallback,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (!isLiveContent && proxyFallbackStage <= 1) {
          const externalProxyUrl = toExternalProxyFallbackUrl(fallbackBaseUrl);
          if (externalProxyUrl) {
            playUrl(
              externalProxyUrl,
              hasRetriedHttpFallback,
              false,
              2,
              hasTriedNativeFallback,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (isWebOsRuntime() && contentType === "live" && !isWebOsSimulator()) {
          const discovered = findWebOsDiscoveredMediaUrl(rootSourceUrl);
          if (discovered && discovered !== playbackUrl) {
            playUrl(
              discovered,
              hasRetriedHttpFallback,
              false,
              Math.max(proxyFallbackStage, 2),
              true,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }

        if (!hasTriedNativeFallback) {
          // Some endpoints are not standard HLS manifests; try direct video playback once.
          playUrl(
            rootSourceUrl,
            hasRetriedHttpFallback,
            true,
            proxyFallbackStage,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          emitPlayerTranscoding("HLS failed, trying direct stream playback.");
          return;
        }

        if (tryWebOsVodVariant("hls-failed")) return;
        const finalMsg = "Stream codecs are not supported by this browser/player.";
        console.error(`[playback-failed] ${finalMsg}`);
        emitPlayerError(finalMsg);
      }
    });
    hls.on(HlsRuntime.Events.AUDIO_TRACKS_UPDATED, () => {
      if (!hls || isStaleRequest()) return;
      selectPreferredHlsAudioTrack(hls);
    });
    hls.on(HlsRuntime.Events.MANIFEST_PARSED, () => {
      if (!videoEl || isStaleRequest()) return;
      hasManifestParsed = true;
      if (hls) {
        selectPreferredHlsAudioTrack(hls);
      }

      if (isLocalTranscodePlayback && contentType !== "live") {
        clearStartupWatchdogIfCurrent();
      }

      const tryPlay = () => {
        if (videoEl && !isStaleRequest()) {
          void safePlay(videoEl);
        }
      };

      if (isLocalTranscodePlayback && contentType !== "live") {
        tryPlay();
      }

      if (videoEl.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        tryPlay();
      } else {
        videoEl.addEventListener("canplay", tryPlay, { once: true });
        // Fallback: if canplay doesn't fire within 30s, attempt play anyway
        // (covers streams where canplay is delayed but data is present)
        window.setTimeout(() => {
          if (!isStaleRequest() && videoEl && videoEl.paused) {
            tryPlay();
          }
        }, 30000);
      }
    });
    hls.loadSource(playbackUrl);
    hls.attachMedia(videoEl);
    })();
    return;
  } else if (
    !playbackUrl.startsWith("blob:") &&
    (
      (isWebOsRuntime() && webOsUseNativeHls && (currentIsManifest || isManifestLikeSource)) ||
      ((shouldUseNativeHls || (isWebOsRuntime() && isManifestLikeSource)) &&
        !!String(videoEl.canPlayType("application/vnd.apple.mpegurl") || "").trim())
    )
  ) {
    // Prefer native HLS on webOS TVs for HLS manifests only
    const isWebOS = isWebOsRuntime();

    // On webOS, try HTTP instead of HTTPS
    let finalUrl = playbackUrl;
    if (isWebOS && playbackUrl.startsWith("https://")) {
      finalUrl = playbackUrl.replace("https://", "http://");
    }

    let nativeFailHandled = false;
    let nativeStartupWatchdog: number | null = null;
    const clearNativeStartupWatchdog = () => {
      if (nativeStartupWatchdog !== null) {
        window.clearTimeout(nativeStartupWatchdog);
        nativeStartupWatchdog = null;
      }
    };

    const failNativeHls = (_reason: string) => {
      if (isStaleRequest()) return;
      if (hasPlaybackStarted && isLiveContent) {
        emitPlayerReconnect("Live connection lost, reconnecting...");
        return;
      }
      if (hasPlaybackStarted || nativeFailHandled) return;
      nativeFailHandled = true;
      clearNativeStartupWatchdog();

      const isWebOS = isWebOsRuntime();

      if (isWebOS && playbackUrl.includes("/__transcode") && !hasTriedNativeFallback) {
        playUrl(
          playbackUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          true,
          true,
          hasRetriedTranscodeBootstrap,
          contentType
        );
        return;
      }

      if (!hasRetriedHttpFallback) {
        const fallbackUrl = toHttpFallbackUrl(fallbackBaseUrl);
        if (fallbackUrl) {
          playUrl(
            fallbackUrl,
            true,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (isWebOS && contentType === "live") {
        void (async () => {
          await new Promise((resolve) => window.setTimeout(resolve, 300));
          if (isStaleRequest() || hasPlaybackStarted) return;
          let discovered = findWebOsDiscoveredMediaUrl(rootSourceUrl);
          if (!discovered || discovered === playbackUrl) {
            const resolved = await resolveWebOsLivePlaybackUrl(rootSourceUrl);
            if (resolved && resolved !== playbackUrl && isWebOsCdnMediaUrl(resolved)) {
              discovered = resolved;
            }
          }
          if (discovered && discovered !== playbackUrl && proxyFallbackStage < 2) {
            playUrl(
              discovered,
              hasRetriedHttpFallback,
              false,
              2,
              false,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
          const nextUrl = discovered || toWebOsLiveHlsUrl(rootSourceUrl);
          playUrl(
            nextUrl,
            hasRetriedHttpFallback,
            false,
            Math.max(proxyFallbackStage, 2),
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
        })();
        return;
      }

      if (contentType !== "live" && proxyFallbackStage === 0) {
        const proxyUrl = toProxyFallbackUrl(fallbackBaseUrl);
        if (proxyUrl) {
          playUrl(
            proxyUrl,
            hasRetriedHttpFallback,
            false,
            1,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType === "live" && proxyFallbackStage === 0) {
        const relayUrl = toProxyFallbackUrl(fallbackBaseUrl);
        if (relayUrl && relayUrl !== playbackUrl) {
          emitPlayerTranscoding("Live stream network/protocol issue, trying relay playback...");
          playUrl(
            relayUrl,
            hasRetriedHttpFallback,
            false,
            1,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
        
        // On webOS, try external CORS proxy as last resort for live
        if (isWebOsRuntime() && proxyFallbackStage === 0) {
          const externalProxyUrl = toExternalProxyFallbackUrl(fallbackBaseUrl);
          if (externalProxyUrl) {
            emitPlayerTranscoding("Trying alternative stream path...");
            playUrl(
              externalProxyUrl,
              hasRetriedHttpFallback,
              false,
              2,
              hasTriedNativeFallback,
              hasTriedTranscodeFallback,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }
      }

      if (contentType !== "live" && proxyFallbackStage <= 1) {
        const externalProxyUrl = toExternalProxyFallbackUrl(fallbackBaseUrl);
        if (externalProxyUrl) {
          playUrl(
            externalProxyUrl,
            hasRetriedHttpFallback,
            false,
            2,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (!hasTriedTranscodeFallback) {
        const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
        if (transcodeUrl) {
          emitPlayerTranscoding(
            contentType === "live"
              ? "Preparing compatible live playback..."
              : "Network/protocol error, trying local transcoder..."
          );
          playUrl(
            transcodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (tryWebOsVodVariant("native-hls-failed")) return;
      emitPlayerError(isWebOsRuntime() 
        ? "Stream not available (server may block TV access)." 
        : "Stream failed to load (network/protocol error).");
    };

    videoEl.onerror = () => failNativeHls(videoEl.error?.message || "video-error");
    videoEl.addEventListener(
      "playing",
      () => {
        hasPlaybackStarted = true;
        clearNativeStartupWatchdog();
      },
      { once: true }
    );
    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        if (videoEl && !isStaleRequest()) {
          clearNativeStartupWatchdog();
          void safePlay(videoEl);
        }
      },
      { once: true }
    );

    const startNativePlayback = (urlToPlay: string) => {
      finalUrl = urlToPlay;
      if (isWebOS) {
        assignWebOsHlsSource(videoEl, finalUrl);
      } else {
        videoEl.src = finalUrl;
      }
      void safePlay(videoEl);
      if (isWebOS) {
        nativeStartupWatchdog = window.setTimeout(() => {
          failNativeHls("startup-timeout");
        }, 8000);
      }
    };

    if (isWebOS && contentType === "live" && isWebOsSimulator() && !isAlreadyRelayed(finalUrl) && !isWebOsRelayUrl(finalUrl)) {
      void (async () => {
        const resolved = await resolveWebOsLivePlaybackUrl(finalUrl);
        if (isStaleRequest()) return;
        startNativePlayback(resolved);
      })();
    } else {
      startNativePlayback(finalUrl);
    }
  } else {
    // Direct playback - used for non-HLS content (TS streams, MP4, etc.)
    const isWebOS = isWebOsRuntime();

    // On webOS, try to use HTTP instead of HTTPS to avoid mixed content issues
    let finalUrl = playbackUrl;
    if (isWebOS && playbackUrl.startsWith("https://")) {
      finalUrl = playbackUrl.replace("https://", "http://");
    }

    if (isWebOS && contentType === "live" && (!webOsUseNativeHls || playbackUrl.includes("/__stream"))) {
      if (!hasTriedNativeFallback) {
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          true,
          hasTriedTranscodeFallback,
          hasRetriedTranscodeBootstrap,
          contentType
        );
        return;
      }
      videoEl.src = finalUrl;
    } else if (isWebOS && contentType === "live") {
      assignWebOsHlsSource(videoEl, toWebOsLiveHlsUrl(finalUrl));
    } else if (isWebOS && !isLiveContent) {
      assignWebOsMediaSource(videoEl, finalUrl, isHlsManifestPlaybackUrl(finalUrl) ? "HLS" : "URI");
    } else {
      videoEl.src = finalUrl;
    }
    let vodStartupWatchdog: number | null = null;
    const clearVodStartupWatchdog = () => {
      if (vodStartupWatchdog !== null) {
        window.clearTimeout(vodStartupWatchdog);
        vodStartupWatchdog = null;
      }
    };
    if (!isLiveContent) {
      vodStartupWatchdog = window.setTimeout(() => {
        if (isStaleRequest() || hasPlaybackStarted) return;
        if (tryWebOsVodVariant("startup-timeout")) return;
      }, 10000);
    }
    videoEl.addEventListener(
      "playing",
      () => {
        hasPlaybackStarted = true;
        clearVodStartupWatchdog();
      },
      { once: true }
    );
    videoEl.onerror = () => {
      if (isStaleRequest()) return;
      clearVodStartupWatchdog();
      if (hasPlaybackStarted && isLiveContent) {
        emitPlayerReconnect("Live connection lost, reconnecting...");
        return;
      }
      if (hasPlaybackStarted) return;
      
      const isWebOS = isWebOsRuntime();

      if (isWebOS && !isLiveContent && !playbackUrl.includes("/__stream")) {
        const relayed = toWebOsPcStreamUrl(playbackUrl);
        if (relayed) {
          playUrl(
            relayed,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (isWebOS && contentType === "live") {
        const hlsUrl = toWebOsLiveHlsUrl(rootSourceUrl);
        if (hlsUrl !== playbackUrl) {
          playUrl(
            hlsUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
        if (!hasTriedNativeFallback && isLikelyHlsManifestUrl(playbackUrl)) {
          playUrl(
            playbackUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (
        isCapacitorRuntime() &&
        contentType === "live" &&
        isLikelyTransportStreamUrl(rootSourceUrl) &&
        proxyFallbackStage === 0 &&
        !hasTriedNativeFallback
      ) {
        emitPlayerTranscoding("Progressive relay failed, trying HLS playlist relay...");
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          false,
          1,
          true,
          hasTriedTranscodeFallback,
          hasRetriedTranscodeBootstrap,
          contentType
        );
        return;
      }

      if (!hasRetriedHttpFallback) {
        const fallbackUrl = toHttpFallbackUrl(fallbackBaseUrl);
        if (fallbackUrl) {
          playUrl(
            fallbackUrl,
            true,
            true,
            proxyFallbackStage,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType !== "live" && proxyFallbackStage === 0) {
        const proxyUrl = toProxyFallbackUrl(fallbackBaseUrl);
        if (proxyUrl) {
          playUrl(
            proxyUrl,
            hasRetriedHttpFallback,
            true,
            1,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType !== "live" && proxyFallbackStage <= 1) {
        const externalProxyUrl = toExternalProxyFallbackUrl(fallbackBaseUrl);
        if (externalProxyUrl) {
          playUrl(
            externalProxyUrl,
            hasRetriedHttpFallback,
            true,
            2,
            hasTriedNativeFallback,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (!hasTriedTranscodeFallback) {
        const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
        if (transcodeUrl) {
          emitPlayerTranscoding(
            contentType === "live"
              ? "Preparing compatible live playback..."
              : "Network/protocol error, trying local transcoder..."
          );
          playUrl(
            transcodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType === "live" && hasTriedTranscodeFallback) {
        const isSafeAudioMode = /[?&]amode=safe(?:&|$)/.test(playbackUrl);

        if (!isSafeAudioMode) {
          const safeAudioTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "safe");
          if (safeAudioTranscodeUrl && safeAudioTranscodeUrl !== playbackUrl) {
            emitPlayerTranscoding("Compatibility transcode failed, trying safe-audio transcoder...");
            playUrl(
              safeAudioTranscodeUrl,
              hasRetriedHttpFallback,
              false,
              proxyFallbackStage,
              hasTriedNativeFallback,
              true,
              hasRetriedTranscodeBootstrap,
              contentType
            );
            return;
          }
        }
      }

      if (contentType === "live" && proxyFallbackStage <= 1) {
        const externalProxyUrl = toExternalProxyFallbackUrl(rootSourceUrl);
        if (externalProxyUrl && externalProxyUrl !== playbackUrl) {
          emitPlayerTranscoding("Live playback still failing, trying external relay fallback...");
          playUrl(
            externalProxyUrl,
            hasRetriedHttpFallback,
            false,
            2,
            true,
            hasTriedTranscodeFallback,
            hasRetriedTranscodeBootstrap,
            contentType
          );
          return;
        }
      }

      if (contentType === "live" && hasTriedTranscodeFallback && !hasRetriedTranscodeBootstrap) {
        emitPlayerTranscoding("Live playback failed in current chain, retrying with a fresh transcode session...");
        playUrl(
          rootSourceUrl,
          hasRetriedHttpFallback,
          false,
          proxyFallbackStage,
          hasTriedNativeFallback,
          true,
          true,
          contentType
        );
        return;
      }

      if (contentType === "live" && !isVideoOnlyPlaybackUrl) {
        const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
        if (videoOnlyTranscodeUrl) {
          emitPlayerTranscoding("Live stream failed in all audio modes, switching to picture-first playback...");
          playUrl(
            videoOnlyTranscodeUrl,
            hasRetriedHttpFallback,
            false,
            proxyFallbackStage,
            hasTriedNativeFallback,
            true,
            true,
            contentType
          );
          return;
        }
      }

      if (tryWebOsVodVariant("direct-failed")) return;
      emitPlayerError(isWebOsRuntime()
        ? "Stream not available (server may block TV access)."
        : "Stream failed: unsupported codecs/format or network/protocol issue.");
    };
    videoEl.load();
    void safePlay(videoEl);
  }
}
