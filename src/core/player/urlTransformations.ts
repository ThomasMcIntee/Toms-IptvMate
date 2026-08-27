import type { ContentType } from "../channelStore";
import { isWebOsRuntime, isCapacitorRuntime, isElectronRuntime, isLikelyLocalRuntime } from "./platformDetection";

/**
 * URL transformation utilities for handling relay, proxy, and transcode URLs.
 * These are shared across all player engines.
 */

const DEFAULT_ELECTRON_RELAY_ORIGIN = "http://127.0.0.1:4173";

export function getRelayBaseOrigin(): string | null {
  if (isWebOsRuntime()) return null;

  const protocol = window.location.protocol;

  if (protocol === "http:" || protocol === "https:") {
    if (isCapacitorRuntime()) {
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
    return isLikelyLocalRuntime() ? window.location.origin : null;
  }

  if (protocol === "file:") {
    if (isElectronRuntime()) {
      const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
      const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
      return explicitRelayOrigin || DEFAULT_ELECTRON_RELAY_ORIGIN;
    }
    if (isCapacitorRuntime()) {
      const scopedWindow = window as Window & { __IPTV_RELAY_ORIGIN__?: string };
      const explicitRelayOrigin = scopedWindow.__IPTV_RELAY_ORIGIN__?.trim();
      if (explicitRelayOrigin) return explicitRelayOrigin;
      return "http://localhost:4173";
    }
    return null;
  }

  return null;
}

export function isAlreadyRelayed(url: string): boolean {
  return url.includes("/__stream?") || url.includes("/__transcode?");
}

export function toPrimaryPlaybackUrl(url: string, preferTranscode = true): string {
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

export function toHttpFallbackUrl(url: string): string | null {
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

export function toProxyFallbackUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;

  if (isCapacitorRuntime()) {
    const relayBase = getRelayBaseOrigin();
    if (relayBase) {
      return `${relayBase}/__stream?url=${encodeURIComponent(url)}`;
    }
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return `${window.location.origin}/__stream?url=${encodeURIComponent(url)}`;
    }
    return null;
  }

  const relayBase = getRelayBaseOrigin();
  if (relayBase) {
    return `${relayBase}/__stream?url=${encodeURIComponent(url)}`;
  }

  return null;
}

export function toExternalProxyFallbackUrl(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return null;
  if (isAlreadyRelayed(url)) return null;
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

export function isLikelyHlsManifestUrl(url: string): boolean {
  return /\.m3u8(?:\?|$)/i.test(url) || /application\/vnd\.apple\.mpegurl/i.test(url);
}

export function isLikelyTransportStreamUrl(url: string): boolean {
  return /\.ts(?:\?|$)/i.test(url);
}

export function normalizeProblematicXtreamSourceUrl(url: string): string {
  if (!url) return url;
  
  // Fix common Xtream Codes URL issues
  let normalized = url;
  
  // Remove trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  
  // Fix double protocols
  normalized = normalized.replace(/^(https?:\/\/)+/i, "http://");
  
  return normalized;
}
