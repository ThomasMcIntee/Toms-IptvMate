import type { IPlayerEngine } from "../PlayerInterface";
import type { ContentType } from "../../channelStore";
import { getCurrentBufferPreset } from "../bufferManager";
import Hls from "hls.js";

/**
 * WebOS Player Engine - optimized for LG webOS TVs.
 * Prefers native HLS, uses HTTP instead of HTTPS.
 */
export class WebOSPlayerEngine implements IPlayerEngine {
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

    // Never feed blob:file:// URLs to webOS. Native FFmpeg cannot open them,
    // and HLS.js MediaSource blobs fail the same way.
    if (url.startsWith("blob:")) {
      this.emitError("webOS cannot play blob-backed live sources.");
      return;
    }

    let playableUrl = url;
    if (contentType === "live" && /\.ts(?:\?|$)/i.test(playableUrl)) {
      playableUrl = playableUrl.replace(/\.ts(?=\?|$)/i, ".m3u8");
    }

    const isRealManifest = this.isLikelyHlsManifestUrl(playableUrl);

    if (isRealManifest || contentType === "live") {
      if (!this.isLikelyHlsManifestUrl(playableUrl) && /\.ts(?:\?|$)/i.test(playableUrl) === false) {
        playableUrl = playableUrl.replace(/(\/live\/[^/]+\/[^/]+\/[^/?#]+)(?=\?|$)/i, "$1.m3u8");
      }
      this.playNativeHls(playableUrl, isStaleRequest);
    } else if (Hls.isSupported()) {
      this.playWithHlsJs(playableUrl, isStaleRequest);
    } else {
      this.playDirect(playableUrl, isStaleRequest);
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
    let finalUrl = url.startsWith("https://") ? url.replace("https://", "http://") : url;

    while (this.videoEl.firstChild) {
      this.videoEl.removeChild(this.videoEl.firstChild);
    }
    const mediaOption = encodeURIComponent(JSON.stringify({
      mediaTransportType: "HLS",
      option: { adaptiveStreaming: { seamlessPlay: true } }
    }));
    const source = document.createElement("source");
    source.src = finalUrl;
    source.type = `application/x-mpegURL;mediaOption=${mediaOption}`;
    this.videoEl.appendChild(source);
    this.videoEl.setAttribute("preload", "auto");
    try {
      (this.videoEl as HTMLVideoElement & { mediaOption?: string }).mediaOption = JSON.stringify({
        mediaTransportType: "HLS"
      });
    } catch {
      // ignore
    }
    this.videoEl.src = finalUrl;
    this.videoEl.load();
    
    this.videoEl.onerror = () => {
      if (isStaleRequest()) return;
      this.emitError("Stream not available (server may block TV access).");
    };

    this.videoEl.addEventListener("loadedmetadata", () => {
      if (this.videoEl && !isStaleRequest()) void this.safePlay(this.videoEl);
    }, { once: true });
  }

  private playWithHlsJs(url: string, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;
    const bufferPreset = getCurrentBufferPreset();
    this.hls = new Hls({
      enableWorker: false,
      maxBufferLength: bufferPreset.bufferingGoal,
      maxMaxBufferLength: bufferPreset.bufferingGoal
    });

    this.hls.on(Hls.Events.ERROR, (_, data) => {
      if (isStaleRequest()) return;
      if (data.fatal) this.emitError("Stream failed to load on webOS.");
    });

    this.hls.loadSource(url);
    this.hls.attachMedia(this.videoEl);
    this.videoEl.addEventListener("loadedmetadata", () => {
      if (this.videoEl && !isStaleRequest()) void this.safePlay(this.videoEl);
    }, { once: true });
  }

  private playDirect(url: string, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;
    let finalUrl = url.startsWith("https://") ? url.replace("https://", "http://") : url;
    this.videoEl.src = finalUrl;
    this.videoEl.onerror = () => {
      if (isStaleRequest()) return;
      this.emitError("Stream not available (server may block TV access).");
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
    while (this.videoEl.firstChild) {
      this.videoEl.removeChild(this.videoEl.firstChild);
    }
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
    console.error(`[webos-player] ${message}`);
  }
}
