import { Capacitor, registerPlugin } from "@capacitor/core";
import { isCapacitorRuntime } from "./player/platformDetection";

type NativePlayerCapPlugin = {
  isAvailable(): Promise<{ available: boolean }>;
  warmUp(): Promise<void>;
  play(options: { url: string }): Promise<void>;
  stop(): Promise<void>;
  setBounds(options: { left: number; top: number; width: number; height: number }): Promise<void>;
};

declare global {
  interface Window {
    NativePlayer?: {
      isAvailable?: () => boolean;
      play?: (url: string) => void;
      stop?: () => void;
      setBounds?: (left: number, top: number, width: number, height: number) => void;
    };
  }
}

const NativePlayerCap = registerPlugin<NativePlayerCapPlugin>("NativePlayer");

let boundsSyncTimer: number | null = null;
let lastBoundsPayload: { left: number; top: number; width: number; height: number } | null = null;
let lastBoundsSentAt = 0;
const BOUNDS_SYNC_MIN_INTERVAL_MS = 2000;

function legacyBridgeAvailable(): boolean {
  try {
    const bridge = window.NativePlayer;
    return !!bridge && typeof bridge.play === "function";
  } catch {
    return false;
  }
}

export function isNativePlayerAvailable(): boolean {
  if (!isCapacitorRuntime()) {
    return legacyBridgeAvailable();
  }
  try {
    return Capacitor.isPluginAvailable("NativePlayer");
  } catch {
    return false;
  }
}

function resolveNativePlayerTarget(): HTMLElement | null {
  const shell = document.querySelector(".live-preview-shell") as HTMLElement | null;
  if (shell) {
    const shellRect = shell.getBoundingClientRect();
    if (shellRect.width >= 2 && shellRect.height >= 2) return shell;
  }

  const video = document.getElementById("player-main");
  if (!video) return null;

  const videoRect = video.getBoundingClientRect();
  if (videoRect.width >= 2 && videoRect.height >= 2) return video;

  return null;
}

function sendNativePlayerBounds(left: number, top: number, width: number, height: number): void {
  if (isCapacitorRuntime()) {
    void NativePlayerCap.setBounds({ left, top, width, height }).catch((err) => {
      console.warn("[native-player] setBounds failed", err);
    });
    return;
  }

  if (window.NativePlayer?.setBounds) {
    window.NativePlayer.setBounds(left, top, width, height);
  }
}

function flushNativePlayerBounds(force = false): void {
  if (!lastBoundsPayload) return;

  const now = Date.now();
  if (!force && now - lastBoundsSentAt < BOUNDS_SYNC_MIN_INTERVAL_MS) {
    return;
  }

  const { left, top, width, height } = lastBoundsPayload;
  lastBoundsSentAt = now;
  console.log(`[native-player] setBounds ${left},${top} ${width}x${height}`);
  sendNativePlayerBounds(left, top, width, height);
}

function resolveNativePlayerBounds(rect: DOMRect): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  const viewport = window.visualViewport;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const offsetTop = viewport?.offsetTop ?? 0;
  const scale = viewport?.scale ?? 1;

  // Capacitor Android overlay is laid out in WebView CSS pixels — applying DPR
  // pushes the native surface off-screen on Fire TV (black video, audio OK).
  if (isCapacitorRuntime()) {
    return {
      left: Math.round((rect.left + offsetLeft) * scale),
      top: Math.round((rect.top + offsetTop) * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale)
    };
  }

  const dpr = window.devicePixelRatio || 1;
  return {
    left: Math.round((rect.left + offsetLeft) * scale * dpr),
    top: Math.round((rect.top + offsetTop) * scale * dpr),
    width: Math.round(rect.width * scale * dpr),
    height: Math.round(rect.height * scale * dpr)
  };
}

export function syncNativePlayerBounds(force = false): void {
  const target = resolveNativePlayerTarget();
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const bounds = resolveNativePlayerBounds(rect);
  const { left, top, width, height } = bounds;

  if (width < 2 || height < 2) return;

  lastBoundsPayload = { left, top, width, height };

  if (force) {
    if (boundsSyncTimer !== null) {
      window.clearTimeout(boundsSyncTimer);
      boundsSyncTimer = null;
    }
    flushNativePlayerBounds(true);
    return;
  }

  const now = Date.now();
  if (now - lastBoundsSentAt >= BOUNDS_SYNC_MIN_INTERVAL_MS) {
    flushNativePlayerBounds(true);
    return;
  }

  if (boundsSyncTimer !== null) return;
  boundsSyncTimer = window.setTimeout(() => {
    boundsSyncTimer = null;
    flushNativePlayerBounds(true);
  }, BOUNDS_SYNC_MIN_INTERVAL_MS);
}

function scheduleNativePlayerBoundsSync(): void {
  // Bounds are applied after play() when the native surface exists.
}

export function warmNativePlayer(): void {
  if (!isCapacitorRuntime() || !isNativePlayerAvailable()) return;
  void NativePlayerCap.warmUp().catch(() => {
    // Warm-up is best-effort.
  });
}

export function resolveNativeLiveUrl(url: string): string {
  const trimmed = String(url || "").trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.includes(".m3u8")) return trimmed;
  if (/\.ts(?:\?|$)/i.test(trimmed)) {
    return trimmed.replace(/\.ts(\?.*)?$/i, ".m3u8$1");
  }
  return trimmed;
}

export function playNativeUrl(url: string): boolean {
  if (!url || !isNativePlayerAvailable()) return false;

  const nativeUrl = resolveNativeLiveUrl(url);

  try {
    if (isCapacitorRuntime()) {
      document.body.classList.add("native-exo-active");
      document.querySelectorAll("video").forEach((element) => {
        const video = element as HTMLVideoElement;
        try {
          video.pause();
          video.muted = true;
          video.removeAttribute("src");
          video.load();
        } catch {
          // Ignore stale media element cleanup errors.
        }
      });
      void NativePlayerCap.play({ url: nativeUrl }).catch((err) => {
        console.error("[native-player] Capacitor play failed", err);
        document.body.classList.remove("native-exo-active");
        window.dispatchEvent(
          new CustomEvent("playerError", {
            detail: { source: "native-exo", message: String(err || "Native playback failed") }
          })
        );
      });
      return true;
    }

    scheduleNativePlayerBoundsSync();
    window.NativePlayer?.play?.(nativeUrl);
    document.body.classList.add("native-exo-active");
    return true;
  } catch (err) {
    console.error("[native-player] play failed", err);
    return false;
  }
}

export function stopNativePlayback(): void {
  try {
    if (isCapacitorRuntime()) {
      void NativePlayerCap.stop().catch(() => {
        // Ignore bridge teardown errors.
      });
    } else {
      window.NativePlayer?.stop?.();
    }
  } catch {
    // Ignore bridge teardown errors.
  }
  document.body.classList.remove("native-exo-active");
}

if (typeof window !== "undefined") {
  (window as Window & { syncNativePlayerBoundsFromNative?: () => void }).syncNativePlayerBoundsFromNative =
    () => syncNativePlayerBounds(true);
}
