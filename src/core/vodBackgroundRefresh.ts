import { isCapacitorRuntime } from "./player/platformDetection";
import { loadPlaylists, type PlaylistEntry } from "./playlistStore";
import { loadXtream, getXtreamCatalogIngestEpoch } from "./loaders/xtreamLoader";
import { loadEPGForPlaylist } from "./loaders/epgLoader";
import { waitForUploadSlot } from "./taskScheduler";
import type { CapacitorVodCacheScope } from "./channelStore";

const REFRESH_AT_KEY = "iptvmate_capacitor_vod_background_refresh_at";
const EPG_REFRESH_AT_KEY = "iptvmate_epg_background_refresh_at";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 25_000;
const CHECK_EVERY_MS = 60 * 60 * 1000;

type RefreshAtMap = Partial<Record<CapacitorVodCacheScope, number>>;

let started = false;
let inFlight = false;
let blockedScope: CapacitorVodCacheScope | null = null;
let epgStarted = false;
let epgInFlight = false;
let epgBlocked = false;

export function setVodRefreshBlockedScope(scope: CapacitorVodCacheScope | null): void {
  blockedScope = scope;
}

export function markVodScopeRefreshed(scope: CapacitorVodCacheScope): void {
  writeRefreshAt(scope);
}

function readRefreshAt(): RefreshAtMap {
  try {
    const raw = localStorage.getItem(REFRESH_AT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RefreshAtMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRefreshAt(scope: CapacitorVodCacheScope): void {
  try {
    const current = readRefreshAt();
    current[scope] = Date.now();
    localStorage.setItem(REFRESH_AT_KEY, JSON.stringify(current));
  } catch {
    // Ignore storage errors on locked-down TVs.
  }
}

function isScopeStale(scope: CapacitorVodCacheScope): boolean {
  const updatedAt = Number(readRefreshAt()[scope] || 0);
  return !Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt >= STALE_AFTER_MS;
}

function preferredXtreamPlaylist(): PlaylistEntry | null {
  const playlists = loadPlaylists().filter((playlist) => playlist.type === "xtream");
  return playlists[0] || null;
}

async function refreshScope(playlist: PlaylistEntry, scope: CapacitorVodCacheScope): Promise<void> {
  if (blockedScope === scope) return;
  await waitForUploadSlot();
  if (blockedScope === scope) return;
  const epoch = getXtreamCatalogIngestEpoch();
  await loadXtream(
    playlist.data.url,
    playlist.data.user,
    playlist.data.pass,
    scope,
    undefined,
    { keepExistingVodCatalog: true }
  );
  if (epoch !== getXtreamCatalogIngestEpoch()) return;
  if (blockedScope === scope) return;
  writeRefreshAt(scope);
}

async function refreshStaleVodCatalogs(): Promise<void> {
  if (!isCapacitorRuntime() || inFlight) return;
  const playlist = preferredXtreamPlaylist();
  if (!playlist?.data?.url || !playlist.data.user || !playlist.data.pass) return;

  const scopes: CapacitorVodCacheScope[] = [];
  if (isScopeStale("movies") && blockedScope !== "movies") scopes.push("movies");
  if (isScopeStale("series") && blockedScope !== "series") scopes.push("series");
  if (scopes.length === 0) return;

  inFlight = true;
  try {
    for (const scope of scopes) {
      try {
        await refreshScope(playlist, scope);
      } catch (error) {
        console.warn(`[vod-refresh] ${scope} failed:`, error);
      }
      await waitForUploadSlot();
    }
  } finally {
    inFlight = false;
  }
}

export function startCapacitorVodBackgroundRefresh(): () => void {
  if (!isCapacitorRuntime() || started) {
    return () => undefined;
  }
  started = true;

  const startTimer = window.setTimeout(() => {
    void refreshStaleVodCatalogs();
  }, START_DELAY_MS);
  const interval = window.setInterval(() => {
    void refreshStaleVodCatalogs();
  }, CHECK_EVERY_MS);

  const onPlaylistsChanged = () => {
    window.setTimeout(() => {
      void refreshStaleVodCatalogs();
    }, START_DELAY_MS);
  };
  window.addEventListener("playlistsChanged", onPlaylistsChanged);
  window.addEventListener("playlistsHydrationComplete", onPlaylistsChanged);

  return () => {
    started = false;
    window.clearTimeout(startTimer);
    window.clearInterval(interval);
    window.removeEventListener("playlistsChanged", onPlaylistsChanged);
    window.removeEventListener("playlistsHydrationComplete", onPlaylistsChanged);
  };
}

export function setEpgRefreshBlocked(blocked: boolean): void {
  epgBlocked = blocked;
}

export function markEpgRefreshed(): void {
  writeEpgRefreshAt();
}

function readEpgRefreshAt(): number {
  try {
    return Number(localStorage.getItem(EPG_REFRESH_AT_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function writeEpgRefreshAt(): void {
  try {
    localStorage.setItem(EPG_REFRESH_AT_KEY, String(Date.now()));
  } catch {
    // Ignore storage errors on locked-down TVs.
  }
}

function isEpgStale(): boolean {
  const updatedAt = readEpgRefreshAt();
  return !Number.isFinite(updatedAt) || updatedAt <= 0 || Date.now() - updatedAt >= STALE_AFTER_MS;
}

async function refreshStaleEpg(): Promise<void> {
  if (epgInFlight || epgBlocked || !isEpgStale()) return;
  const playlists = loadPlaylists();
  if (playlists.length === 0) return;

  epgInFlight = true;
  try {
    let anyOk = false;
    for (const playlist of playlists) {
      if (epgBlocked) return;
      await waitForUploadSlot();
      if (epgBlocked) return;
      try {
        await loadEPGForPlaylist(playlist, { forceRefresh: true });
        anyOk = true;
      } catch (error) {
        console.warn("[epg-refresh] failed:", error);
      }
      await waitForUploadSlot();
    }
    if (anyOk && !epgBlocked) writeEpgRefreshAt();
  } finally {
    epgInFlight = false;
  }
}

export function startEpgBackgroundRefresh(): () => void {
  if (epgStarted) {
    return () => undefined;
  }
  epgStarted = true;

  const startTimer = window.setTimeout(() => {
    void refreshStaleEpg();
  }, START_DELAY_MS);
  const interval = window.setInterval(() => {
    void refreshStaleEpg();
  }, CHECK_EVERY_MS);

  const onPlaylistsChanged = () => {
    window.setTimeout(() => {
      void refreshStaleEpg();
    }, START_DELAY_MS);
  };
  window.addEventListener("playlistsChanged", onPlaylistsChanged);
  window.addEventListener("playlistsHydrationComplete", onPlaylistsChanged);

  return () => {
    epgStarted = false;
    window.clearTimeout(startTimer);
    window.clearInterval(interval);
    window.removeEventListener("playlistsChanged", onPlaylistsChanged);
    window.removeEventListener("playlistsHydrationComplete", onPlaylistsChanged);
  };
}
