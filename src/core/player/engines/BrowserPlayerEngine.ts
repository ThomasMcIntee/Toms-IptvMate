import type { IPlayerEngine } from "../PlayerInterface";
import type { ContentType } from "../../channelStore";
import { getCurrentBufferPreset } from "../bufferManager";
import Hls from "hls.js";

/**
 * Browser Player Engine - default for web browsers.
 * 
 * Key characteristics:
 * - Uses HLS.js for HLS streams
 * - Falls back to native HLS on Safari
 * - Enables workers for better performance
 * - Standard buffer settings
 */
export class BrowserPlayerEngine implements IPlayerEngine {
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

    const canPlayNativeHls = this.videoEl.canPlayType("application/vnd.apple.mpegurl");
    const isHlsManifest = this.isLikelyHlsManifestUrl(url);

    // Use native HLS on Safari, HLS.js on other browsers
    if (isHlsManifest && canPlayNativeHls && !Hls.isSupported()) {
      this.playNativeHls(url, isStaleRequest);
    } else if (Hls.isSupported() && isHlsManifest) {
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

  private playNativeHls(url: string, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;

    this.videoEl.src = url;
    this.videoEl.onerror = () => {
      if (isStaleRequest()) return;
      this.emitError("Stream failed to load.");
    };

    this.videoEl.addEventListener("loadedmetadata", () => {
      if (this.videoEl && !isStaleRequest()) void this.safePlay(this.videoEl);
    }, { once: true });
  }

  private playWithHlsJs(url: string, contentType: ContentType, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;

    const bufferPreset = getCurrentBufferPreset();
    this.hls = new Hls({
      enableWorker: true,
      maxBufferLength: bufferPreset.bufferingGoal,
      maxMaxBufferLength: bufferPreset.bufferingGoal
    });

    this.hls.on(Hls.Events.ERROR, (_, data) => {
      if (isStaleRequest()) return;
      
      if (data.fatal) {
        console.error("[browser-player] HLS fatal error", data);
        this.emitError("Stream failed to load.");
      }
    });

    this.hls.loadSource(url);
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
      this.emitError("Stream failed to load.");
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

  private isLikelyHlsManifestUrl(url: string): boolean {
    return /\.m3u8(?:\?|$)/i.test(url);
  }

  private emitError(message: string): void {
    console.error(`[browser-player] ${message}`);
  }
}
