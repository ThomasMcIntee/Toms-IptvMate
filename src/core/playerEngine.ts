import Hls from "hls.js";
import { ContentType } from "./channelStore";

let hls: Hls | null = null;
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

const RAPID_RETRY_GAP_MS = 1200;
const MAX_RAPID_RETRIES = 30;
const RETRY_COOLDOWN_MS = 1500;
const ATTEMPT_WINDOW_MS = 20000;
const MAX_ATTEMPTS_PER_WINDOW = 30;
const DEFAULT_ELECTRON_RELAY_ORIGIN = "http://127.0.0.1:4173";

function getRelayBaseOrigin(): string | null {
  const protocol = window.location.protocol;

  if (protocol === "http:" || protocol === "https:") {
    // Only local dev/preview hosts expose the Vite relay/transcode middleware.
    return isLikelyLocalRuntime() ? window.location.origin : null;
  }

  if (protocol === "file:") {
    const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
    const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
    return explicitRelayOrigin || DEFAULT_ELECTRON_RELAY_ORIGIN;
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

function logAudioRuntimeState(video: HTMLVideoElement, context: string) {
  const tracks = (video as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks;
  const audioTrackCount = tracks ? tracks.length : 0;
  console.log(
    `[audio] ${context} muted=${video.muted} volume=${video.volume} paused=${video.paused} readyState=${video.readyState} tracks=${audioTrackCount}`
  );
}

function selectPreferredHlsAudioTrack(hlsInstance: Hls, reason: string) {
  const tracks = hlsInstance.audioTracks || [];
  if (!tracks.length) {
    console.log(`[hls-audio] reason=${reason} tracks=0`);
    return;
  }

  const preferredIndex = tracks.findIndex((track) => (track as { default?: boolean }).default) >= 0
    ? tracks.findIndex((track) => (track as { default?: boolean }).default)
    : 0;

  if (hlsInstance.audioTrack !== preferredIndex) {
    hlsInstance.audioTrack = preferredIndex;
  }

  console.log(
    `[hls-audio] reason=${reason} tracks=${tracks.length} selected=${hlsInstance.audioTrack} defaultIndex=${preferredIndex}`
  );
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
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".local") || host.endsWith(".lan")) return true;

  // Private network hosts (common when testing on TV/device via LAN IP).
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;

  // Vite/Capacitor dev usually runs on an explicit dev port.
  if (window.location.port === "5173") return true;

  return false;
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
  return (
    url.includes("/__stream?") ||
    isTranscodeBootstrapUrl(url) ||
    url.includes("/__transcode/session/") ||
    url.includes("corsproxy.io/?")
  );
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

function normalizeProblematicXtreamSourceUrl(url: string): string {
  // Some Xtream live endpoints expose a nominal .m3u8 URL that returns a broken
  // manifest while the sibling .ts stream is stable enough for relay/transcode.
  if (/\/live\/[^/]+\/[^/]+\/\d+\.m3u8(?:\?|$)/i.test(url)) {
    return url.replace(/\.m3u8(?=\?|$)/i, ".ts");
  }

  // Keep legacy movie m3u8 URLs untouched. Relay/transcode fallback logic now
  // resolves provider-specific container variants (mkv/mp4/ts) more reliably.

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

function toPrimaryPlaybackUrl(url: string, preferTranscode = true): string {
  if (!/^https?:\/\//i.test(url)) return url;
  if (isAlreadyRelayed(url)) return url;

  if (isLikelyLocalRuntime() || !!getRelayBaseOrigin()) {
    const relayBase = getRelayBaseOrigin();
    if (!relayBase) return url;

    if (!preferTranscode) {
      return `${relayBase}/__stream?url=${encodeURIComponent(url)}`;
    }
    const isVodLike = /\/(movie|series)\//i.test(url);
    const compatSuffix = isVodLike ? "&amode=compat" : "";
    return `${relayBase}/__transcode?url=${encodeURIComponent(url)}${compatSuffix}`;
  }

  return url;
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

function toProxyFallbackUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;

  return toRelayUrl(`/__stream?url=${encodeURIComponent(url)}`);
}

function toExternalProxyFallbackUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function toTranscodeFallbackUrl(
  url: string,
  videoOnly = false,
  audioMode: "standard" | "compat" | "safe" = "standard"
): string | null {
  if (!isLikelyLocalRuntime() && !getRelayBaseOrigin()) return null;
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
      } else {
        parsed.searchParams.delete("audio");
        if (audioMode === "safe" || audioMode === "compat") {
          parsed.searchParams.set("amode", audioMode);
        } else {
          parsed.searchParams.delete("amode");
        }
      }

      const nextUrl = parsed.toString();
      return nextUrl !== url ? nextUrl : null;
    } catch {
      let nextUrl = url;
      if (videoOnly && !/[?&]audio=0(?:&|$)/.test(nextUrl)) {
        nextUrl = `${nextUrl}&audio=0`;
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

      return nextUrl !== url ? nextUrl : null;
    }
  }

  if (isSessionUrl) {
    const rootUrl = resolveRootSourceUrl(url);
    if (!/^https?:\/\//i.test(rootUrl)) return null;
    const audioSuffix = videoOnly ? "&audio=0" : "";
    const audioModeSuffix = !videoOnly && audioMode !== "standard" ? `&amode=${audioMode}` : "";
    return `${relayBase}/__transcode?url=${encodeURIComponent(rootUrl)}${audioSuffix}${audioModeSuffix}`;
  }

  const audioSuffix = videoOnly ? "&audio=0" : "";
  const audioModeSuffix = !videoOnly && audioMode !== "standard" ? `&amode=${audioMode}` : "";
  return `${relayBase}/__transcode?url=${encodeURIComponent(url)}${audioSuffix}${audioModeSuffix}`;
}

async function safePlay(video: HTMLVideoElement) {
  let usedMutedAutoplayFallback = false;

  try {
    await video.play();
    logAudioRuntimeState(video, "play-success");
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
    logAudioRuntimeState(video, "muted-fallback-success");

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
  videoEl = document.getElementById("player-main") as HTMLVideoElement;

  if (videoEl) {
    videoEl.autoplay = true;
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
    videoEl.load();
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
  if (!videoEl) return;
  const token = ++playRequestToken;
  const globalAttemptId = nextGlobalPlayAttemptId();
  const isStaleRequest = () => token !== playRequestToken || !isCurrentGlobalPlayAttempt(globalAttemptId);
  let hasPlaybackStarted = false;

  const markPlaybackStarted = () => {
    if (isStaleRequest()) return;
    hasPlaybackStarted = true;
  };

  videoEl.addEventListener("playing", markPlaybackStarted, { once: true });
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
  videoEl.addEventListener("playing", ensureAudibleOnPlaying);
  videoEl.muted = false;
  videoEl.onerror = null;
  const normalizedUrl = normalizeProblematicXtreamSourceUrl(normalizeStreamUrl(url));
  contentType = inferContentTypeFromUrl(normalizedUrl, contentType);
  const isLiveContent = contentType === "live";
  const isRequestedTranscode =
    isTranscodeBootstrapUrl(normalizedUrl) ||
    isTranscodeSessionUrl(normalizedUrl);
  const allowTranscodeFallback =
    !isLiveContent ||
    (hasTriedNativeFallback && !hasTriedTranscodeFallback) ||
    isRequestedTranscode;
  const fallbackLabel = hasRetriedHttpFallback ? "http" : hasTriedTranscodeFallback ? "transcode" : proxyFallbackStage > 0 ? `proxy-stage-${proxyFallbackStage}` : hasTriedNativeFallback ? "native" : "primary";
  console.log(`[playUrl] attempt=${fallbackLabel} url=${normalizedUrl.slice(0, 100)}...`);
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
    !isLiveContent
      ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat")
      : null;
  const initialLiveTranscodeUrl =
    !forceNativePlayback &&
    !isRequestedTranscode &&
    isLiveContent &&
    !hasTriedTranscodeFallback &&
    false
      ? toTranscodeFallbackUrl(rootSourceUrl, false, "compat")
      : null;
  const liveRelayUrl = !forceNativePlayback && !isRequestedTranscode && isLiveContent ? toProxyFallbackUrl(rootSourceUrl) : null;
  const isManifestLikeSource = isLikelyHlsManifestUrl(rootSourceUrl);
  const isTransportStreamSource = isLikelyTransportStreamUrl(rootSourceUrl);
  const directNativeRelayUrl =
    forceNativePlayback && isLiveContent && isTransportStreamSource
      ? toProxyFallbackUrl(rootSourceUrl)
      : null;
  const playbackUrl =
    directNativeRelayUrl ||
    (forceNativePlayback ? rootSourceUrl : null) ||
    rebootstrapVodSessionUrl ||
    (isRequestedTranscode ? normalizedUrl : null) ||
    initialVodTranscodeUrl ||
    (isLiveContent && isTransportStreamSource ? initialLiveTranscodeUrl : null) ||
    liveRelayUrl ||
    toPrimaryPlaybackUrl(rootSourceUrl, shouldPreferTranscode);
  const shouldUseHlsJs =
    playbackUrl.includes("/__transcode") ||
    isManifestLikeSource ||
    (playbackUrl.includes("/__stream?") && isManifestLikeSource);
  const shouldUseNativeHls = shouldUseHlsJs;
  const shouldUseHlsJsPath = shouldUseHlsJs;

  console.log(`[playUrl-startup] isLocalTranscodePlayback=${playbackUrl.includes("/__transcode")}, shouldPreferTranscode=${shouldPreferTranscode}, hasTriedTranscodeFallback=${hasTriedTranscodeFallback}`);

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
  videoEl.removeAttribute("src");
  videoEl.load();

  if (Hls.isSupported() && !forceNativePlayback && shouldUseHlsJsPath) {
    const shouldTryShakaForVodTranscode = false;

    if (shouldTryShakaForVodTranscode) {
      const launchShaka = async () => {
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
          shakaPlayer.configure({
            preferredAudioLanguage: "eng",
            preferredAudioChannelCount: 2,
            streaming: {
              rebufferingGoal: 2,
              bufferingGoal: 10
            }
          });

          shakaPlayer.addEventListener("error", () => {
            if (isStaleRequest()) return;

            void teardownShakaPlayer();
            skipShakaOnce = true;
            emitPlayerTranscoding("Alternate player failed, retrying with default player...");
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

            void teardownShakaPlayer();
            skipShakaOnce = true;
            emitPlayerTranscoding("Alternate player startup stalled, retrying with default player...");
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
          }, 7000);

          skipShakaOnce = false;
          if (videoEl) {
            await safePlay(videoEl);
            logAudioRuntimeState(videoEl, "shaka-playing");
            videoEl.removeEventListener("playing", onShakaPlaying);
          }
        } catch {
          if (isStaleRequest()) return;

          void teardownShakaPlayer();
          skipShakaOnce = true;
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
        }
      };

      void launchShaka();
      return;
    }

    if (skipShakaOnce) {
      skipShakaOnce = false;
    }

    const isLocalTranscodePlayback = playbackUrl.includes("/__transcode");
    // Prefer audio mode recovery (compat/safe) before picture-only fallback.
    const preferFastPictureOnlyRecovery = false;
    const isAudioEnabledTranscode = isLocalTranscodePlayback && !/[?&]audio=0(?:&|$)/.test(playbackUrl);
    const currentAudioMode: "standard" | "compat" | "safe" = /[?&]amode=compat(?:&|$)/.test(playbackUrl)
      ? "compat"
      : /[?&]amode=safe(?:&|$)/.test(playbackUrl)
      ? "safe"
      : "standard";
    const nextAudioMode =
      currentAudioMode === "standard" ? "compat" : currentAudioMode === "compat" ? "safe" : null;
    hls = new Hls({
      enableWorker: !isLocalTranscodePlayback, // Disable worker for local transcode (avoid async append race)
      startPosition: isLocalTranscodePlayback && contentType !== "live" ? 0 : -1,
      lowLatencyMode: isLocalTranscodePlayback && contentType === "live",
      liveDurationInfinity: isLocalTranscodePlayback && contentType === "live",
      manifestLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 20000,
      levelLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 10000,
      fragLoadingTimeOut: isLocalTranscodePlayback ? 120000 : 20000,
      manifestLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 1,
      levelLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 2,
      fragLoadingMaxRetry: isLocalTranscodePlayback ? 3 : 2,
      manifestLoadingRetryDelay: 1000,
      levelLoadingRetryDelay: 1000,
      fragLoadingRetryDelay: 1000
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
      const startupTimeoutMs = contentType === "live" ? 1000 : 8000;
      startupFallbackTimer = window.setTimeout(() => {
        if (isStaleRequest()) return;
        if (hasStartedPlayback || (contentType !== "live" && hasLoadedMetadata)) return;

        const mediaErr = videoEl?.error;
        const isAudioDecoderUnsupported = isUnsupportedAudioDecoderError(mediaErr);

        if (!isAudioDecoderUnsupported) {
          // Live startup can stall with no explicit decoder error. In that case,
          // try one native fallback path only.
          if (contentType === "live" && !hasLoadedMetadata && !hasStartedPlayback && !hasTriedNativeFallback) {
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
          if (isTransportStreamSource && !hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
            if (transcodeUrl) {
              emitPlayerTranscoding("Relay audio decoder rejected stream, trying compat-audio transcoder...");
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
          } else if (!hasTriedNativeFallback) {
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
      console.log(`[transcode-startup-watchdog] setting ${Math.round(transcodeStartupTimeoutMs / 1000)}s timeout for transcode startup. rootSourceUrl=${rootSourceUrl.slice(0, 80)}...`);
      startupFallbackTimer = window.setTimeout(() => {
        console.log(`[transcode-startup-timeout] fired! token=${token}, playRequestToken=${playRequestToken}, videoReadyState=${videoEl?.readyState}`);
        if (isStaleRequest()) {
          console.log(`[transcode-startup-timeout] skipped: token mismatch`);
          return;
        }
        if (videoEl?.readyState && videoEl.readyState >= 2) {
          console.log(`[transcode-startup-timeout] skipped: video has loaded data (readyState=${videoEl.readyState})`);
          return;
        }

        if (contentType === "live") {
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

          const videoOnlyTranscodeUrl = toTranscodeFallbackUrl(rootSourceUrl, true);
          if (videoOnlyTranscodeUrl) {
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
        console.log(`[transcode-startup-timeout] relayFallbackUrl=${relayFallbackUrl}`);
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
              isAudioEnabledTranscode &&
              audioDecodeStallStrikes >= 2;

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
    videoEl.addEventListener(
      "playing",
      () => {
        if (videoEl) {
          logAudioRuntimeState(videoEl, "hls-playing");
        }
      },
      { once: true }
    );

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

      // Debounce rapid decoder errors to prevent restart loop (e.g., every ~30ms)
      const now = Date.now();
      const timeSinceLastEscalation = now - lastEscalationTime;
      if (timeSinceLastEscalation < 3000) {
        // Too soon - skip escalation attempt
        console.log(`[video-error-skip-debounce] time since last=${timeSinceLastEscalation}ms`);
        return;
      }

      clearStartupFallbackTimer();
      console.log(`[video-error-handling] isLocalTranscodePlayback=${isLocalTranscodePlayback} isAudioEnabledTranscode=${isAudioEnabledTranscode} currentAudioMode=${currentAudioMode} nextAudioMode=${nextAudioMode}`);

      if (isLocalTranscodePlayback) {
        // For local transcode, first retry with audio compatibility modes before
        // dropping to video-only playback.
        console.log(`[video-error] isAudioEnabledTranscode=${isAudioEnabledTranscode} currentAudioMode=${currentAudioMode} nextAudioMode=${nextAudioMode}`);
        if (isAudioEnabledTranscode && nextAudioMode) {
          console.log(`[video-error-attempt-audio-mode] attempting to build ${nextAudioMode} URL from normalizedUrl=${normalizedUrl.slice(0, 80)}`);
          const nextModeUrl = toTranscodeFallbackUrl(normalizedUrl, false, nextAudioMode);
          console.log(`[video-error-attempt-audio-mode] result=${nextModeUrl ? nextModeUrl.slice(0, 100) : "null"}`);
          if (nextModeUrl) {
            lastEscalationTime = now;
            console.log(`[video-error-fallback] trying ${nextAudioMode}-audio transcode: ${nextModeUrl.slice(0, 100)}...`);
            emitPlayerTranscoding(`Audio decoder rejected ${currentAudioMode} mode, trying ${nextAudioMode}-audio transcoder...`);
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

        console.log(`[video-error-attempt-videoonly] attempting video-only from normalizedUrl=${normalizedUrl.slice(0, 80)}`);
        const videoOnlyBootstrapUrl = toTranscodeFallbackUrl(normalizedUrl, true);
        console.log(`[video-error-attempt-videoonly] result=${videoOnlyBootstrapUrl ? videoOnlyBootstrapUrl.slice(0, 100) : "null"}`);
        if (videoOnlyBootstrapUrl) {
          lastEscalationTime = now;
          console.log(`[video-error-fallback] trying video-only transcode: ${videoOnlyBootstrapUrl.slice(0, 100)}...`);
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
              emitPlayerTranscoding(`Audio decoder rejected ${currentAudioMode} mode, trying ${nextAudioMode}-audio transcoder...`);
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
          if (videoOnlyTranscodeUrl && contentType === "live") {
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
          if (isTransportStreamSource && !hasTriedTranscodeFallback) {
            const transcodeUrl = toTranscodeFallbackUrl(rootSourceUrl, false, "compat");
            if (transcodeUrl) {
              lastEscalationTime = now;
              emitPlayerTranscoding("Relay audio decoder rejected stream, trying compat-audio transcoder...");
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
          } else if (!hasTriedNativeFallback) {
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
          emitPlayerTranscoding(`Audio decoder rejected ${currentAudioMode} mode, trying ${nextAudioMode}-audio transcoder...`);
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
      if (videoOnlyTranscodeUrl && contentType === "live") {
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

      emitPlayerError("This stream format/codecs are not supported by your player.");
    };


    hls.on(Hls.Events.ERROR, (_, data) => {
      // Ignore errors from stale playback sessions - check FIRST
      if (isStaleRequest()) return;
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

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryTried) {
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

        const finalMsg = "Stream codecs are not supported by this browser/player.";
        console.error(`[playback-failed] ${finalMsg}`);
        emitPlayerError(finalMsg);
      }
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      if (!hls || isStaleRequest()) return;
      selectPreferredHlsAudioTrack(hls, "audio-tracks-updated");
    });
    hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, data) => {
      if (isStaleRequest()) return;
      const switchedTo = (data as { id?: number }).id;
      console.log(`[hls-audio] event=audio-track-switched id=${typeof switchedTo === "number" ? switchedTo : "unknown"}`);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!videoEl || isStaleRequest()) return;
      hasManifestParsed = true;
      if (hls) {
        selectPreferredHlsAudioTrack(hls, "manifest-parsed");
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
  } else if (shouldUseNativeHls && videoEl.canPlayType("application/vnd.apple.mpegurl")) {
    videoEl.src = playbackUrl;
    videoEl.onerror = () => {
      if (isStaleRequest() || hasPlaybackStarted) return;

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
              ? "Stream format not supported, trying compatibility transcoder..."
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

      emitPlayerError("Stream failed to load (network/protocol error).");
    };
    videoEl.addEventListener(
      "loadedmetadata",
      () => {
        if (videoEl && !isStaleRequest()) {
          void safePlay(videoEl);
        }
      },
      { once: true }
    );
  } else {
    videoEl.src = playbackUrl;
    videoEl.onerror = () => {
      if (isStaleRequest() || hasPlaybackStarted) return;

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
              ? "Stream format not supported, trying compatibility transcoder..."
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

      emitPlayerError("Stream failed: unsupported codecs/format or network/protocol issue.");
    };
    videoEl.load();
    void safePlay(videoEl);
  }
}
