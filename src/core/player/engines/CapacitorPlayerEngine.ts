import type { IPlayerEngine } from "../PlayerInterface";
import type { ContentType } from "../../channelStore";
import { getCurrentBufferPreset } from "../bufferManager";
import { isCapacitorRuntime } from "../platformDetection";
import Hls from "hls.js";

/**
 * Capacitor Player Engine - optimized for Android via Capacitor.
 * 
 * Key characteristics:
 * - Always uses HLS.js (never native HLS)
 * - Disables workers (Capacitor limitation)
 * - Uses relay/proxy for CORS-restricted streams
 * - Handles .ts streams via native proxy without HLS wrapping
 */
export class CapacitorPlayerEngine implements IPlayerEngine {
  private videoEl: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private playRequestToken = 0;

  init(video: HTMLVideoElement): void {
    this.videoEl = video;
  }

  playUrl(url: string, contentType: ContentType): void {
    if (!this.videoEl) return;

    const token = ++this.playRequestToken;
    const isStaleRequest = () => token !== this.playRequestToken;

    this.destroyHls();
    this.resetVideoElement();

    // Capacitor always uses HLS.js if supported
    if (Hls.isSupported()) {
      this.playWithHlsJs(url, contentType, isStaleRequest);
    } else {
      this.playDirect(url, contentType, isStaleRequest);
    }
  }

  stop(): void {
    this.playRequestToken++;
    this.destroyHls();
    this.resetVideoElement();
  }

  destroy(): void {
    this.stop();
    this.videoEl = null;
  }

  private playWithHlsJs(url: string, contentType: ContentType, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;

    const bufferPreset = getCurrentBufferPreset();
    const isTsContainer = this.isLikelyTransportStreamUrl(url);
    
    // On Capacitor, don't wrap .ts streams - native proxy handles them
    const shouldWrapTs = isTsContainer && !url.includes("/__transcode") && !isCapacitorRuntime();

    this.hls = new Hls({
      enableWorker: false, // Capacitor doesn't support workers well
      maxBufferLength: bufferPreset.bufferingGoal,
      maxMaxBufferLength: bufferPreset.bufferingGoal,
      manifestLoadingTimeOut: 20000,
      levelLoadingTimeOut: 10000,
      fragLoadingTimeOut: 20000
    });

    this.hls.on(Hls.Events.ERROR, (_, data) => {
      if (isStaleRequest()) return;
      
      if (data.fatal) {
        console.error("[capacitor-player] HLS fatal error", data);
        this.emitError("Stream failed to load on Android.");
      }
    });

    const playbackUrl = shouldWrapTs ? this.wrapTransportStream(url, contentType === "live") : url;
    this.hls.loadSource(playbackUrl);
    this.hls.attachMedia(this.videoEl);

    this.videoEl.addEventListener("loadedmetadata", () => {
      if (this.videoEl && !isStaleRequest()) void this.safePlay(this.videoEl);
    }, { once: true });
  }

  private playDirect(url: string, contentType: ContentType, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;

    this.videoEl.src = url;
    this.videoEl.onerror = () => {
      if (isStaleRequest()) return;
      this.emitError("Stream failed to load on Android.");
    };

    this.videoEl.addEventListener("loadedmetadata", () => {
      if (this.videoEl && !isStaleRequest()) void this.safePlay(this.videoEl);
    }, { once: true });
  }

  private destroyHls(): void {
    if (this.hls) {
      try { this.hls.stopLoad(); this.hls.detachMedia(); } catch { /* ignore */ }
      try { this.hls.destroy(); } catch { /* ignore */ }
      this.hls = null;
    }
  }

  private resetVideoElement(): void {
    if (!this.videoEl) return;
    if (this.videoEl.src?.startsWith("blob:")) {
      try { URL.revokeObjectURL(this.videoEl.src); } catch { /* ignore */ }
    }
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
  }

  private async safePlay(video: HTMLVideoElement): Promise<void> {
    try {
      video.muted = false;
      await video.play();
    } catch {
      try { video.muted = true; await video.play(); } catch { /* ignore */ }
    }
  }

  private isLikelyTransportStreamUrl(url: string): boolean {
    return /\.ts(?:\?|$)/i.test(url);
  }

  private wrapTransportStream(url: string, isLive: boolean): string {
    // Simplified - in real implementation this would create an HLS manifest
    return url;
  }

  private emitError(message: string): void {
    console.error(`[capacitor-player] ${message}`);
  }
}
