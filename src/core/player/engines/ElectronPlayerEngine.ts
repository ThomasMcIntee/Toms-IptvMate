import type { IPlayerEngine } from "../PlayerInterface";
import type { ContentType } from "../../channelStore";
import { getCurrentBufferPreset } from "../bufferManager";
import { isElectronRuntime } from "../platformDetection";
import Hls from "hls.js";

/**
 * Electron Player Engine - optimized for desktop (Electron/Tauri).
 * 
 * Key characteristics:
 * - Uses relay/proxy for CORS-restricted streams
 * - Can use Shaka Player for VOD transcode playback
 * - Has access to local transcoder for codec conversion
 * - Enables HLS.js workers for better performance
 */
export class ElectronPlayerEngine implements IPlayerEngine {
  private videoEl: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private shakaPlayer: any = null;
  private playRequestToken = 0;

  init(video: HTMLVideoElement): void {
    this.videoEl = video;
  }

  playUrl(url: string, contentType: ContentType): void {
    if (!this.videoEl) return;

    const token = ++this.playRequestToken;
    const isStaleRequest = () => token !== this.playRequestToken;

    this.destroyPlayers();
    this.resetVideoElement();

    // Check if this is a transcode URL that should use Shaka
    const isTranscode = url.includes("/__transcode");
    const isVod = contentType !== "live";
    const shouldUseShaka = isTranscode && isVod && !url.includes("audio=0");

    if (shouldUseShaka) {
      this.playWithShaka(url, isStaleRequest);
    } else if (Hls.isSupported()) {
      this.playWithHlsJs(url, contentType, isStaleRequest);
    } else {
      this.playDirect(url, contentType, isStaleRequest);
    }
  }

  stop(): void {
    this.playRequestToken++;
    this.destroyPlayers();
    this.resetVideoElement();
  }

  destroy(): void {
    this.stop();
    this.videoEl = null;
  }

  private async playWithShaka(url: string, isStaleRequest: () => boolean): Promise<void> {
    if (!this.videoEl) return;

    try {
      const shakaModule = await import("shaka-player");
      const shakaLib = (shakaModule as any).default || (shakaModule as any);

      if (!shakaLib?.Player?.isBrowserSupported?.()) {
        throw new Error("Shaka Player not supported");
      }

      if (isStaleRequest()) return;

      const bufferPreset = getCurrentBufferPreset();
      this.shakaPlayer = new shakaLib.Player();
      await this.shakaPlayer.attach(this.videoEl);
      
      this.shakaPlayer.configure({
        preferredAudioLanguage: "eng",
        preferredAudioChannelCount: 2,
        streaming: {
          rebufferingGoal: bufferPreset.rebufferingGoal,
          bufferingGoal: bufferPreset.bufferingGoal
        }
      });

      this.shakaPlayer.addEventListener("error", () => {
        if (isStaleRequest()) return;
        this.emitError("Shaka Player failed, falling back to HLS.js...");
      });

      await this.shakaPlayer.load(url);

      if (isStaleRequest()) {
        await this.destroyShaka();
        return;
      }

      await this.safePlay(this.videoEl);
    } catch (err) {
      console.error("[electron-player] Shaka failed:", err);
      // Fall back to HLS.js
      if (!isStaleRequest()) {
        await this.destroyShaka();
        this.playWithHlsJs(url, "vod" as ContentType, isStaleRequest);
      }
    }
  }

  private playWithHlsJs(url: string, contentType: ContentType, isStaleRequest: () => boolean): void {
    if (!this.videoEl) return;

    const bufferPreset = getCurrentBufferPreset();
    const isTranscode = url.includes("/__transcode");

    this.hls = new Hls({
      enableWorker: true, // Electron supports workers
      maxBufferLength: bufferPreset.bufferingGoal,
      maxMaxBufferLength: bufferPreset.bufferingGoal,
      manifestLoadingTimeOut: isTranscode ? 120000 : 20000,
      levelLoadingTimeOut: isTranscode ? 120000 : 10000,
      fragLoadingTimeOut: isTranscode ? 120000 : 20000,
      lowLatencyMode: isTranscode && contentType === "live",
      liveDurationInfinity: isTranscode && contentType === "live"
    });

    this.hls.on(Hls.Events.ERROR, (_, data) => {
      if (isStaleRequest()) return;
      
      if (data.fatal) {
        console.error("[electron-player] HLS fatal error", data);
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

  private async destroyShaka(): Promise<void> {
    if (this.shakaPlayer) {
      try { await this.shakaPlayer.destroy(); } catch { /* ignore */ }
      this.shakaPlayer = null;
    }
  }

  private destroyPlayers(): void {
    if (this.hls) {
      try { this.hls.stopLoad(); this.hls.detachMedia(); } catch { /* ignore */ }
      try { this.hls.destroy(); } catch { /* ignore */ }
      this.hls = null;
    }
    void this.destroyShaka();
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

  private emitError(message: string): void {
    console.error(`[electron-player] ${message}`);
  }
}
