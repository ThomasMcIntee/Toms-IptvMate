export type ContentType = "live" | "movie" | "series";

export type Channel = {
  id: string;
  name: string;
  logo?: string;
  url: string;
  group?: string;
  contentType?: ContentType;
  epgChannelId?: string;
  parentGroup?: string; // For series: group that contains this series
  episodeInfo?: {
    season?: number;
    episode?: number;
    title?: string;
  };
};

import { isCapacitorRuntime } from "./player/platformDetection";
import { isWebOsDbAvailable, webosDbGetLarge, webosDbSetLarge } from "./webosStorage";

let channels: Channel[] = [];
let activeGroup: string = "All";
let roleChannelWriteLock: "adult" | "child" | null = null;
const VISIBILITY_KEY = "iptvmate_visibility";             // live/runtime — overwritten by reset
const ADULT_SAVED_KEY = "iptvmate_visibility_adult";       // admin-saved adult settings (never reset)
const CHILD_SAVED_KEY = "iptvmate_visibility_child";       // admin-saved child settings (never reset)
let activeVisibilityRole: "adult" | "child" = "adult";
const FAVORITES_KEY = "iptvmate_favorites";
const FAVORITES_GROUP = "Favorites";
const CHANNELS_CACHE_KEY = "iptvmate_channels_cache";
const CHANNELS_CACHE_META_KEY = "iptvmate_channels_cache_meta";
const CHANNELS_CACHE_DB = "iptvmate_cache";
const CHANNELS_CACHE_STORE = "channels";
const VISIBILITY_STORE = "visibility";
const CHANNELS_CACHE_RECORD_KEY = "latest";
const CHANNELS_CACHE_LIVE_RECORD_KEY = "latest-live";
// Fire TV / Capacitor cannot keep or serialize 100k+ channel records without ANR/OOM.
const CAPACITOR_MAX_IDB_CACHE_CHANNELS = 12000;
const CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD = 8000;
const CAPACITOR_MAX_GROUP_CHANNELS = 2500;
const CAPACITOR_BULK_GROUP_THRESHOLD = 150;
const CAPACITOR_IDB_PERSIST_BATCH_SIZE = 6;
const CAPACITOR_INGEST_CHUNK_SIZE = 350;
const CAPACITOR_LIVE_GROUPS_KEY = "iptvmate_capacitor_live_groups";
const CAPACITOR_LIVE_GROUP_COUNTS_KEY = "iptvmate_capacitor_live_group_counts";
// Tracks which catalog group each favorited live channel lives in, so the
// Favorites view can aggregate starred channels across the hundreds of split
// catalog groups without loading the whole catalog into memory.
const CAPACITOR_FAVORITES_INDEX_KEY = "iptvmate_capacitor_favorites_index";
const CAPACITOR_TRANSIENT_SOURCES = new Set<string>([
  "capacitor-live-trim",
  "capacitor-playback-trim",
  "capacitor-live-ingest",
  "capacitor-group-load",
  "capacitor-favorites-load",
  "capacitor-vod-cache-load"
]);
let capacitorLiveGroupNames: string[] = [];
let capacitorLiveGroupCounts: Record<string, number> = {};
type CapacitorFavoriteIndexEntry = {
  group: string;
  url: string;
  name?: string;
};
type CapacitorFavoriteIndex = Record<string, CapacitorFavoriteIndexEntry>;
let capacitorFavoriteIndex: CapacitorFavoriteIndex = loadCapacitorFavoriteIndex();
let capacitorFavoriteIndexScanStarted = false;
// Signature of the favorite id set currently held in memory by
// loadCapacitorFavoriteChannels(). Cleared whenever another source writes the
// channel list, so the Favorites view knows it must re-aggregate from IDB.
let capacitorFavoritesViewSignature = "";
let restoreChannelsCacheInFlight: Promise<Channel[]> | null = null;
// webOS TV flash storage can take several seconds to open IndexedDB and read a
// multi-megabyte channel record at cold boot. Aggressive (~1.2s) timeouts made
// startup treat the cache as missing, so content never auto-loaded on TVs.
// When there is genuinely no cached record, reads still return quickly — this
// timeout only bites when the DB is truly hung.
const CHANNELS_CACHE_DB_TIMEOUT_MS = 10000;

export type ChannelCacheScope = "live" | "movies" | "series";

export type ChannelCacheMeta = {
  playlistId: string;
  scopes: ChannelCacheScope[];
  updatedAt: number;
};

type VisibilityState = {
  groups: Record<string, boolean>;
  channels: Record<string, boolean>;
  /** Capacitor/Fire TV: compact hide-all without storing 900+ group keys. */
  allGroupsHidden?: boolean;
};

type FavoriteEntry = {
  key: string;
  id: string;
  url: string;
  name?: string;
};

export type ChannelVisibilitySnapshot = {
  groups: Record<string, boolean>;
  channels: Record<string, boolean>;
  allGroupsHidden?: boolean;
};

export type ChannelWriteTrace = {
  source: string;
  applied: boolean;
  channelCount: number;
  roleLock: "adult" | "child" | null;
  at: number;
};

const ROLE_LOCK_ALLOWED_SOURCES = new Set<string>([
  "role-restore",
  "role-clear",
  "playlist-manager-role-load",
  "playlist-manager-generic-load"
]);

let lastChannelWriteTrace: ChannelWriteTrace = {
  source: "init",
  applied: false,
  channelCount: 0,
  roleLock: null,
  at: Date.now()
};

function recordChannelWriteTrace(source: string, applied: boolean, channelCount: number) {
  lastChannelWriteTrace = {
    source,
    applied,
    channelCount,
    roleLock: roleChannelWriteLock,
    at: Date.now()
  };

  dispatchStoreEvent("channelsWriteTrace", lastChannelWriteTrace);
}

export function getLastChannelWriteTrace(): ChannelWriteTrace {
  return lastChannelWriteTrace;
}

let visibilityState: VisibilityState = loadVisibilityState();
let saveVisibilityStateTimer: number | null = null;
let favoriteEntries = loadFavoriteEntries();
let favoriteChannelIds = buildFavoriteIdSet(favoriteEntries);

function dispatchStoreEvent(name: string, detail?: unknown): void {
  if (typeof window === "undefined") return;

  try {
    if (typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(name, { detail }));
      return;
    }
  } catch {
    // Fall through to legacy event creation.
  }

  try {
    const legacyEvent = document.createEvent("CustomEvent");
    legacyEvent.initCustomEvent(name, false, false, detail);
    window.dispatchEvent(legacyEvent);
  } catch {
    // Keep dispatch best-effort to avoid runtime crashes on older engines.
  }
}

function normalizeFavoriteUrl(value: string): string {
  return String(value || "").trim();
}

function buildFavoriteKey(input: Partial<Channel> | null | undefined): string {
  if (!input) return "";
  const id = String(input.id || "").trim();
  if (!id) return "";
  const url = normalizeFavoriteUrl(String(input.url || ""));
  return url ? `id:${id}|url:${url}` : `id:${id}`;
}

function buildFavoriteIdSet(entries: Map<string, FavoriteEntry>): Set<string> {
  const result = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.id) result.add(entry.id);
  }
  return result;
}

function loadFavoriteEntries(): Map<string, FavoriteEntry> {
  const result = new Map<string, FavoriteEntry>();

  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return result;

    for (const item of parsed) {
      if (typeof item === "string") {
        const id = String(item || "").trim();
        if (!id) continue;
        const key = `id:${id}`;
        result.set(key, { key, id, url: "" });
        continue;
      }

      if (!item || typeof item !== "object") continue;
      const record = item as Partial<FavoriteEntry>;
      const id = String(record.id || "").trim();
      if (!id) continue;
      const url = normalizeFavoriteUrl(String(record.url || ""));
      const key = String(record.key || "").trim() || (url ? `id:${id}|url:${url}` : `id:${id}`);

      result.set(key, {
        key,
        id,
        url,
        name: typeof record.name === "string" ? record.name : undefined
      });
    }
  } catch {
    return result;
  }

  return result;
}

function saveFavoriteEntries() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favoriteEntries.values())));
  } catch {
    // Ignore persistence errors.
  }
}

function dispatchFavoritesChanged() {
  dispatchStoreEvent("favoritesChanged");
}

function hasLegacyIdOnlyFavorite(id: string): boolean {
  const entry = favoriteEntries.get(`id:${id}`);
  return !!entry && !String(entry.url || "").trim();
}

function hasFavoriteEntryWithId(id: string): boolean {
  for (const entry of favoriteEntries.values()) {
    if (entry.id === id) {
      return true;
    }
  }
  return false;
}

function hasFavoriteEntryWithUrl(url: string): boolean {
  const normalizedUrl = normalizeFavoriteUrl(url);
  if (!normalizedUrl) return false;
  for (const entry of favoriteEntries.values()) {
    if (normalizeFavoriteUrl(entry.url || "") === normalizedUrl) {
      return true;
    }
  }
  return false;
}

function isSeriesLikeFavoriteChannel(channel: Partial<Channel> | null | undefined): boolean {
  if (!channel) return false;

  const contentType = String(channel.contentType || "").trim().toLowerCase();
  if (contentType === "series") {
    return true;
  }

  const id = String(channel.id || "").trim();
  return /^series_\d+(?:_episode_\d+)?$/i.test(id);
}

function hasUniqueCurrentChannelId(id: string): boolean {
  let count = 0;
  for (const channel of channels) {
    if (String(channel.id || "") !== id) continue;
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

function migrateLegacyFavoritesForCurrentChannels() {
  let changed = false;

  for (const [key, entry] of favoriteEntries.entries()) {
    if (!key.startsWith("id:")) continue;
    if (String(entry.url || "").trim()) continue;

    const id = String(entry.id || "").trim();
    if (!id) continue;
    if (!hasUniqueCurrentChannelId(id)) continue;

    const channel = channels.find((candidate) => String(candidate.id || "") === id);
    if (!channel) continue;

    const nextKey = buildFavoriteKey(channel);
    if (!nextKey) continue;

    favoriteEntries.delete(key);
    favoriteEntries.set(nextKey, {
      key: nextKey,
      id,
      url: normalizeFavoriteUrl(String(channel.url || "")),
      name: String(channel.name || "").trim() || undefined
    });
    changed = true;
  }

  if (!changed) return;

  favoriteChannelIds = buildFavoriteIdSet(favoriteEntries);
  saveFavoriteEntries();
  dispatchFavoritesChanged();
}

function toCacheChannel(item: Channel): Channel {
  const result: Channel = {
    id: String(item.id),
    name: String(item.name),
    url: String(item.url)
  };

  if (typeof item.logo === "string") result.logo = item.logo;
  if (typeof item.group === "string") result.group = item.group;
  if (item.contentType === "live" || item.contentType === "movie" || item.contentType === "series") {
    result.contentType = item.contentType;
  }
  if (typeof item.epgChannelId === "string") result.epgChannelId = item.epgChannelId;
  if (typeof item.parentGroup === "string") result.parentGroup = item.parentGroup;

  if (item.episodeInfo && typeof item.episodeInfo === "object") {
    const episodeInfo: Channel["episodeInfo"] = {};
    if (typeof item.episodeInfo.season === "number") episodeInfo.season = item.episodeInfo.season;
    if (typeof item.episodeInfo.episode === "number") episodeInfo.episode = item.episodeInfo.episode;
    if (typeof item.episodeInfo.title === "string") episodeInfo.title = item.episodeInfo.title;
    if (Object.keys(episodeInfo).length > 0) {
      result.episodeInfo = episodeInfo;
    }
  }

  return result;
}

function toValidChannel(item: unknown): Channel | null {
  if (!item || typeof item !== "object") return null;

  const candidate = item as Partial<Channel>;
  if (typeof candidate.id !== "string") return null;
  if (typeof candidate.name !== "string") return null;
  if (typeof candidate.url !== "string") return null;

  return toCacheChannel({
    id: candidate.id,
    name: candidate.name,
    url: candidate.url,
    logo: typeof candidate.logo === "string" ? candidate.logo : undefined,
    group: typeof candidate.group === "string" ? candidate.group : undefined,
    contentType:
      candidate.contentType === "live" ||
      candidate.contentType === "movie" ||
      candidate.contentType === "series"
        ? candidate.contentType
        : undefined,
      epgChannelId: typeof candidate.epgChannelId === "string" ? candidate.epgChannelId : undefined,
    parentGroup: typeof candidate.parentGroup === "string" ? candidate.parentGroup : undefined,
    episodeInfo:
      candidate.episodeInfo && typeof candidate.episodeInfo === "object"
        ? {
            season:
              typeof candidate.episodeInfo.season === "number"
                ? candidate.episodeInfo.season
                : undefined,
            episode:
              typeof candidate.episodeInfo.episode === "number"
                ? candidate.episodeInfo.episode
                : undefined,
            title:
              typeof candidate.episodeInfo.title === "string"
                ? candidate.episodeInfo.title
                : undefined
          }
        : undefined
  });
}

function normalizeChannels(list: Channel[]): Channel[] {
  return list.map((item) => ({
    ...item,
    group: normalizeGroupName(item.group)
  }));
}

function applyCachedChannels(list: Channel[]) {
  channels = normalizeChannels(list);
  // Any channel-list write invalidates the aggregated Favorites memory view.
  capacitorFavoritesViewSignature = "";
  const firstGroup = channels.find((c) => c.group && c.group !== "All")?.group;
  activeGroup = firstGroup || "All";
}

function applyRestoredChannels(list: Channel[]) {
  if (
    isCapacitorRuntime() &&
    list.length > CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD &&
    list.some(isLiveChannel)
  ) {
    ingestCapacitorLiveChannelCatalog(list);
    return;
  }

  applyCachedChannels(list);
}

export function clearCurrentChannels(source: string = "unknown") {
  channels = [];
  capacitorFavoritesViewSignature = "";
  activeGroup = "All";
  recordChannelWriteTrace(source, false, 0);
}

function loadCachedChannelsWithPresence(): { hasValue: boolean; channels: Channel[] } {
  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_KEY);
    debugLog(`cache-load: raw=${raw ? raw.length + ' chars' : 'null'}`);
    if (raw === null) return { hasValue: false, channels: [] };

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      debugLog('cache-load: not array');
      return { hasValue: true, channels: [] };
    }

    const result = {
      hasValue: true,
      channels: parsed
        .map(toValidChannel)
        .filter((item): item is Channel => !!item)
    };
    debugLog(`cache-load: ${result.channels.length} channels`);
    return result;
  } catch (e) {
    debugLog(`cache-load error: ${e}`);
    return { hasValue: true, channels: [] };
  }
}

function saveCachedChannels(list: Channel[]) {
  // Only use localStorage for small lists to avoid OOM and QuotaExceededError.
  // IndexedDB is the primary store for large IPTV playlists.
  if (list.length > 2000) {
    try {
      localStorage.removeItem(CHANNELS_CACHE_KEY);
    } catch {
      // Ignore
    }
    return;
  }
  try {
    localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(list.map(toCacheChannel)));
  } catch (err) {
    // Large channel lists routinely exceed the localStorage quota on TVs.
    // IndexedDB remains the durable store; surface the failure for on-TV debugging.
    const debugLog = (window as any).webosDebugLog;
    if (debugLog) debugLog(`cache-save: localStorage failed (${err instanceof Error ? err.name : "error"})`);
  }
}

export function loadChannelsCacheMeta(): ChannelCacheMeta | null {
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_META_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<ChannelCacheMeta>;
    const playlistId = String(parsed?.playlistId || "").trim();
    if (!playlistId) return null;

    const scopes = Array.isArray(parsed?.scopes)
      ? parsed.scopes.filter((scope): scope is ChannelCacheScope => scope === "live" || scope === "movies" || scope === "series")
      : [];

    return {
      playlistId,
      scopes,
      updatedAt: Number(parsed?.updatedAt || 0) || 0
    };
  } catch {
    return null;
  }
}

export function saveChannelsCacheMeta(meta: ChannelCacheMeta | null): void {
  try {
    if (!meta) {
      localStorage.removeItem(CHANNELS_CACHE_META_KEY);
      return;
    }

    localStorage.setItem(CHANNELS_CACHE_META_KEY, JSON.stringify({
      playlistId: String(meta.playlistId || "").trim(),
      scopes: Array.isArray(meta.scopes) ? meta.scopes : [],
      updatedAt: Number(meta.updatedAt || Date.now()) || Date.now()
    }));
  } catch {
    // Ignore persistence errors.
  }
}

async function openChannelsCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timeout = window.setTimeout(() => finish(null), CHANNELS_CACHE_DB_TIMEOUT_MS);

    try {
      const request = indexedDB.open(CHANNELS_CACHE_DB, 2);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHANNELS_CACHE_STORE)) {
          db.createObjectStore(CHANNELS_CACHE_STORE);
        }
        if (!db.objectStoreNames.contains(VISIBILITY_STORE)) {
          db.createObjectStore(VISIBILITY_STORE);
        }
      };

      request.onsuccess = () => {
        window.clearTimeout(timeout);
        finish(request.result);
      };
      request.onerror = () => {
        window.clearTimeout(timeout);
        finish(null);
      };
      request.onblocked = () => {
        window.clearTimeout(timeout);
        finish(null);
      };
    } catch {
      window.clearTimeout(timeout);
      finish(null);
    }
  });
}

function isLiveChannel(channel: Channel): boolean {
  const contentType = String(channel.contentType || "").trim().toLowerCase();
  if (contentType === "live") return true;
  if (contentType === "movie" || contentType === "series") return false;
  return !channel.parentGroup && !channel.episodeInfo;
}

function shouldSkipCapacitorFullIdbPersist(list: Channel[]): boolean {
  return isCapacitorRuntime() && list.length > CAPACITOR_MAX_IDB_CACHE_CHANNELS;
}

async function deleteCachedChannelsFromIndexedDb(
  db: IDBDatabase,
  recordKey: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CHANNELS_CACHE_STORE, "readwrite");
      tx.objectStore(CHANNELS_CACHE_STORE).delete(recordKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function readCachedChannelsFromIndexedDb(
  db: IDBDatabase,
  recordKey: string
): Promise<Channel[]> {
  return new Promise<Channel[]>((resolve) => {
    try {
      const tx = db.transaction(CHANNELS_CACHE_STORE, "readonly");
      const request = tx.objectStore(CHANNELS_CACHE_STORE).get(recordKey);
      request.onsuccess = () => {
        const value = request.result as unknown;
        if (!Array.isArray(value)) {
          resolve([]);
          return;
        }

        resolve(value.map(toValidChannel).filter((item): item is Channel => !!item));
      };
      request.onerror = () => resolve([]);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function writeCachedChannelsToIndexedDb(
  db: IDBDatabase,
  recordKey: string,
  list: Channel[],
  options?: { quiet?: boolean }
): Promise<boolean> {
  const debugLog = (window as any).webosDebugLog;
  const quiet = options?.quiet === true;

  return new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(CHANNELS_CACHE_STORE, "readwrite");
      tx.objectStore(CHANNELS_CACHE_STORE).put(list.map(toCacheChannel), recordKey);
      tx.oncomplete = () => {
        if (debugLog && !quiet) {
          debugLog(`cache-save: idb persisted ${list.length} channels (${recordKey})`);
        }
        resolve(true);
      };
      tx.onerror = () => {
        if (debugLog) debugLog(`cache-save: idb tx error (${recordKey})`);
        resolve(false);
      };
      tx.onabort = () => {
        if (debugLog) debugLog(`cache-save: idb tx abort (${recordKey})`);
        resolve(false);
      };
    } catch {
      if (debugLog) debugLog(`cache-save: idb tx exception (${recordKey})`);
      resolve(false);
    }
  });
}

async function saveCachedChannelsIndexedDb(list: Channel[]) {
  const debugLog = (window as any).webosDebugLog;
  const db = await openChannelsCacheDb();
  if (!db) {
    if (debugLog) debugLog("cache-save: idb open failed, channels NOT persisted");
    return;
  }

  if (shouldSkipCapacitorFullIdbPersist(list)) {
    if (debugLog) {
      debugLog(`cache-save: Capacitor skip idb full persist (${list.length} channels)`);
    }

    const liveOnly = list.filter(isLiveChannel);
    if (liveOnly.length > 0 && liveOnly.length <= CAPACITOR_MAX_IDB_CACHE_CHANNELS) {
      await writeCachedChannelsToIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY, liveOnly);
    }
    db.close();
    return;
  }

  await writeCachedChannelsToIndexedDb(db, CHANNELS_CACHE_RECORD_KEY, list);
  if (isCapacitorRuntime()) {
    const liveOnly = list.filter(isLiveChannel);
    if (liveOnly.length > 0 && liveOnly.length <= CAPACITOR_MAX_IDB_CACHE_CHANNELS) {
      await writeCachedChannelsToIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY, liveOnly);
    }
  }

  db.close();
}

// webOS DB8 mirror for the channel cache. localStorage/IndexedDB get purged
// on LG TVs when the app fully closes or the TV power-cycles; DB8 records
// survive, so cached channels can restore offline on the next launch.
// The save is debounced and single-flight: serializing megabytes and pushing
// chunked Luna calls must never compete with an in-progress playlist load.
let pendingWebosDbChannels: Channel[] | null = null;
let webosDbSaveTimer: number | null = null;
let webosDbSaveInFlight = false;

function saveCachedChannelsWebosDb(list: Channel[]): void {
  if (!isWebOsDbAvailable()) return;

  pendingWebosDbChannels = list;
  if (webosDbSaveTimer !== null || webosDbSaveInFlight) return;

  webosDbSaveTimer = window.setTimeout(() => {
    webosDbSaveTimer = null;
    const toSave = pendingWebosDbChannels;
    pendingWebosDbChannels = null;
    if (!toSave || !isWebOsDbAvailable()) return;

    webosDbSaveInFlight = true;
    void (async () => {
      const debugLog = (window as any).webosDebugLog;
      try {
        const payload = JSON.stringify(toSave.map(toCacheChannel));
        const ok = await webosDbSetLarge(CHANNELS_CACHE_KEY, payload);
        if (debugLog) debugLog(`cache-save: db8 ${ok ? "ok" : "FAILED"} (${toSave.length} channels)`);
      } catch (err) {
        if (debugLog) debugLog(`cache-save: db8 threw ${err instanceof Error ? err.message : "error"}`);
      } finally {
        webosDbSaveInFlight = false;
        // A newer list may have arrived while saving; queue it.
        if (pendingWebosDbChannels) saveCachedChannelsWebosDb(pendingWebosDbChannels);
      }
    })();
  }, 5000);
}

async function loadCachedChannelsWebosDb(): Promise<Channel[]> {
  if (!isWebOsDbAvailable()) return [];
  try {
    const raw = await webosDbGetLarge(CHANNELS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toValidChannel).filter((item): item is Channel => !!item);
  } catch {
    return [];
  }
}

async function loadCapacitorGroupChannelsFromIndexedDb(db: IDBDatabase): Promise<Channel[]> {
  const debugLog = (window as any).webosDebugLog;
  const groupNames = getCapacitorLiveGroupNames();
  if (groupNames.length === 0) {
    if (debugLog) debugLog("cache-load: Capacitor skip monolithic idb (no split groups yet)");
    return [];
  }

  for (const groupName of groupNames) {
    const normalized = normalizeGroupName(groupName);
    const groupChannels = await readCachedChannelsFromIndexedDb(db, idbLiveGroupRecordKey(normalized));
    if (groupChannels.length > 0) {
      if (debugLog) debugLog(`cache-load: idb group ${normalized} ${groupChannels.length} channels`);
      return groupChannels;
    }
  }

  if (debugLog) debugLog("cache-load: Capacitor group catalog present but no idb group records");
  return [];
}

async function loadCachedChannelsIndexedDb(): Promise<Channel[]> {
  const debugLog = (window as any).webosDebugLog;
  const db = await openChannelsCacheDb();
  if (!db) return [];

  const loadPromise = (async () => {
    if (isCapacitorRuntime()) {
      return loadCapacitorGroupChannelsFromIndexedDb(db);
    }

    const liveOnly = await readCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY);
    if (liveOnly.length > 0) {
      if (debugLog) debugLog(`cache-load: idb live-only ${liveOnly.length} channels`);
      return liveOnly;
    }

    const full = await readCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_RECORD_KEY);
    if (full.length > CAPACITOR_MAX_IDB_CACHE_CHANNELS) {
      const trimmedLive = full.filter(isLiveChannel);
      if (debugLog) {
        debugLog(`cache-load: trim idb ${full.length} -> ${trimmedLive.length} live channels`);
      }
      return trimmedLive;
    }

    return full;
  })();

  const result = await Promise.race([
    loadPromise,
    new Promise<Channel[]>((resolve) => {
      window.setTimeout(() => resolve([]), CHANNELS_CACHE_DB_TIMEOUT_MS);
    })
  ]);

  db.close();
  return result;
}

function loadVisibilityState(): VisibilityState {
  // On module init, activeVisibilityRole is always "adult" — read the adult key.
  const key = VISIBILITY_KEY;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return { groups: {}, channels: {} };
    }

    const parsed = JSON.parse(raw) as Partial<VisibilityState>;
    return {
      groups: parsed.groups ?? {},
      channels: parsed.channels ?? {},
      allGroupsHidden: parsed.allGroupsHidden === true
    };
  } catch {
    return { groups: {}, channels: {} };
  }
}

function saveVisibilityStateNow() {
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(visibilityState));
  } catch {
    // Ignore persistence errors.
  }
}

function saveVisibilityState() {
  // Always write to the live/runtime key. Saved role keys are only written
  // by saveRoleVisibility() so that resetVisibilityForCurrentChannels() can
  // never overwrite the admin's configured hide/show settings.
  if (isCapacitorRuntime()) {
    if (saveVisibilityStateTimer !== null) {
      window.clearTimeout(saveVisibilityStateTimer);
    }
    saveVisibilityStateTimer = window.setTimeout(() => {
      saveVisibilityStateTimer = null;
      saveVisibilityStateNow();
    }, 300);
    return;
  }

  saveVisibilityStateNow();
}

/** Persist the current visibility state as the saved settings for the given role.
 *  This is the ONLY function that writes to ADULT_SAVED_KEY / CHILD_SAVED_KEY. */
export function saveRoleVisibility(role: "adult" | "child") {
  const key = role === "child" ? CHILD_SAVED_KEY : ADULT_SAVED_KEY;
  try {
    localStorage.setItem(key, JSON.stringify(visibilityState));
  } catch {
    // Large visibility maps can exceed localStorage quota.
  }

  // Also persist to IndexedDB for reliability
  void (async () => {
    const db = await openChannelsCacheDb();
    if (!db) return;
    try {
      const tx = db.transaction(VISIBILITY_STORE, "readwrite");
      tx.objectStore(VISIBILITY_STORE).put(visibilityState, key);
    } catch {
      // Ignore
    }
  })();
}

/** Switch between adult (default) and child visibility states.
 *  Reads from the explicitly-saved role key so admin settings survive resets.
 *  Never mixes with the live key, which is reset on every playlist load. */
export function setActiveVisibilityRole(role: "adult" | "child") {
  activeVisibilityRole = role;
  const savedKey = role === "child" ? CHILD_SAVED_KEY : ADULT_SAVED_KEY;

  // Start with a fallback to empty state
  let nextState: VisibilityState = { groups: {}, channels: {} };

  try {
    const raw = localStorage.getItem(savedKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VisibilityState>;
      nextState = {
        groups: parsed.groups ?? {},
        channels: parsed.channels ?? {}
      };
      visibilityState = nextState;
      dispatchVisibilityChanged();
    }
  } catch {
    // Fall through to IDB
  }

  // Always attempt to refine from IndexedDB in case localStorage was truncated
  void (async () => {
    const db = await openChannelsCacheDb();
    if (!db) return;
    try {
      const tx = db.transaction(VISIBILITY_STORE, "readonly");
      const request = tx.objectStore(VISIBILITY_STORE).get(savedKey);
      request.onsuccess = () => {
        const val = request.result as VisibilityState | undefined;
        if (val && (Object.keys(val.groups).length > 0 || Object.keys(val.channels).length > 0)) {
          // If IDB has more data or we are currently empty, prefer it.
          visibilityState = val;
          dispatchVisibilityChanged();
        }
      };
    } catch {
      // Ignore
    }
  })();
}

function dispatchVisibilityChanged() {
  dispatchStoreEvent("visibilityChanged");
}

function normalizeGroupName(group?: string): string {
  return (group && group.trim()) || "Uncategorized";
}

export function setRoleChannelWriteLock(role: "adult" | "child" | null) {
  roleChannelWriteLock = role;
}

function groupLiveChannelsByName(list: Channel[]): Map<string, Channel[]> {
  const map = new Map<string, Channel[]>();
  for (const channel of list) {
    if (!isLiveChannel(channel)) continue;
    const group = normalizeGroupName(channel.group);
    const bucket = map.get(group) || [];
    bucket.push(channel);
    map.set(group, bucket);
  }
  return map;
}

function idbLiveGroupRecordKey(groupName: string): string {
  return `live-group:${groupName}`;
}

function readCapacitorLiveGroupNamesFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(CAPACITOR_LIVE_GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((group): group is string => typeof group === "string" && group.trim().length > 0);
  } catch {
    return [];
  }
}

function readCapacitorLiveGroupCountsFromStorage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CAPACITOR_LIVE_GROUP_COUNTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const counts: Record<string, number> = {};
    Object.entries(parsed || {}).forEach(([group, count]) => {
      const numeric = Number(count);
      if (group && Number.isFinite(numeric) && numeric > 0) {
        counts[group] = numeric;
      }
    });
    return counts;
  } catch {
    return {};
  }
}

function loadCapacitorFavoriteIndex(): CapacitorFavoriteIndex {
  const result: CapacitorFavoriteIndex = {};
  try {
    const raw = localStorage.getItem(CAPACITOR_FAVORITES_INDEX_KEY);
    if (!raw) return result;
    const parsed = JSON.parse(raw) as Record<string, Partial<CapacitorFavoriteIndexEntry>>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [id, entry] of Object.entries(parsed)) {
      const group = String(entry?.group || "").trim();
      if (!group) continue;
      result[id] = {
        group,
        url: String(entry?.url || "").trim(),
        name: typeof entry?.name === "string" ? (entry.name as string) : undefined
      };
    }
  } catch {
    // Ignore corruption.
  }
  return result;
}

function saveCapacitorFavoriteIndex() {
  try {
    localStorage.setItem(CAPACITOR_FAVORITES_INDEX_KEY, JSON.stringify(capacitorFavoriteIndex));
  } catch {
    // Ignore quota errors on TV storage.
  }
}

function getFavoriteIdSet(): Set<string> {
  const ids = new Set<string>();
  for (const entry of favoriteEntries.values()) {
    const id = String(entry?.id || "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

function buildCapacitorFavoritesSignature(favoriteIds: Set<string>): string {
  return Array.from(favoriteIds).sort().join("|");
}

/**
 * While ingesting the full live catalog, record which split group each
 * favorited channel lives in. This lets the Favorites group aggregate
 * starred channels from all 900+ groups without a full catalog load.
 */
function rebuildCapacitorFavoriteIndexFromCatalog(list: Channel[]): void {
  if (!isCapacitorRuntime() || favoriteEntries.size === 0) return;
  const ids = getFavoriteIdSet();
  if (ids.size === 0) return;

  let added = 0;
  for (const channel of list) {
    if (!isLiveChannel(channel)) continue;
    const id = String(channel?.id || "").trim();
    if (!ids.has(id)) continue;
    if (capacitorFavoriteIndex[id]) continue;
    capacitorFavoriteIndex[id] = {
      group: normalizeGroupName(channel.group),
      url: String(channel?.url || "").trim(),
      name: typeof channel?.name === "string" ? channel.name : undefined
    };
    added += 1;
  }
  if (added > 0) saveCapacitorFavoriteIndex();
}

function syncCapacitorFavoriteIndexForChannel(
  channel: Partial<Channel> | null | undefined,
  isFavorite: boolean
): void {
  if (!isCapacitorRuntime()) return;
  const id = String(channel?.id || "").trim();
  if (!id) return;

  if (isFavorite) {
    capacitorFavoriteIndex[id] = {
      group: normalizeGroupName(channel?.group),
      url: String(channel?.url || "").trim(),
      name: typeof channel?.name === "string" ? (channel?.name as string) : undefined
    };
  } else {
    delete capacitorFavoriteIndex[id];
  }
  saveCapacitorFavoriteIndex();
}

function saveCapacitorLiveGroupCatalog(groupNames: string[], counts: Record<string, number>) {
  capacitorLiveGroupNames = groupNames;
  capacitorLiveGroupCounts = counts;
  try {
    localStorage.setItem(CAPACITOR_LIVE_GROUPS_KEY, JSON.stringify(groupNames));
    localStorage.setItem(CAPACITOR_LIVE_GROUP_COUNTS_KEY, JSON.stringify(counts));
  } catch {
    // Ignore quota errors on TV storage.
  }
}

export function getCapacitorLiveGroupNames(): string[] {
  if (capacitorLiveGroupNames.length > 0) {
    return capacitorLiveGroupNames;
  }
  return readCapacitorLiveGroupNamesFromStorage();
}

export function getCapacitorLiveGroupCounts(): Record<string, number> {
  if (Object.keys(capacitorLiveGroupCounts).length > 0) {
    return capacitorLiveGroupCounts;
  }
  return readCapacitorLiveGroupCountsFromStorage();
}

/** Drop bloated per-channel visibility maps from pre-split-cache sessions (57k+ keys). */
export function pruneCapacitorVisibilityIfBloated(): void {
  if (!isCapacitorRuntime()) return;

  const channelKeyCount = Object.keys(visibilityState.channels).length;
  const groupKeyCount = Object.keys(visibilityState.groups).length;
  if (channelKeyCount <= 500 && groupKeyCount <= 2500) return;

  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  debugLog(
    `capacitor-visibility-trim: channels=${channelKeyCount} groups=${groupKeyCount} -> group-only`
  );

  const catalogGroups = new Set(getCapacitorLiveGroupNames());
  const nextGroups: Record<string, boolean> = {};
  Object.entries(visibilityState.groups).forEach(([group, visible]) => {
    if (visible === false || catalogGroups.has(group)) {
      nextGroups[group] = visible;
    }
  });

  visibilityState = {
    groups: nextGroups,
    channels: {}
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

/** Drop legacy monolithic IDB blobs that OOM Fire TV when parsed (100k+ live rows). */
export function scheduleCapacitorLegacyCachePurge(): void {
  if (!isCapacitorRuntime()) return;
  pruneCapacitorVisibilityIfBloated();
  if (getCapacitorLiveGroupNames().length > 0) return;

  window.setTimeout(() => {
    void (async () => {
      const debugLog = (window as any).webosDebugLog;
      const db = await openChannelsCacheDb();
      if (!db) return;
      await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY);
      await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_RECORD_KEY);
      db.close();
      if (debugLog) debugLog("cache-load: purged legacy monolithic idb on Capacitor");
    })();
  }, 1500);
}

async function persistCapacitorLiveGroupsToIdb(list: Channel[], groupNames: string[]): Promise<void> {
  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  const db = await openChannelsCacheDb();
  if (!db) return;

  const grouped = groupLiveChannelsByName(list);
  const writeOptions = { quiet: groupNames.length > CAPACITOR_BULK_GROUP_THRESHOLD };

  for (let index = 0; index < groupNames.length; index += CAPACITOR_IDB_PERSIST_BATCH_SIZE) {
    const batch = groupNames.slice(index, index + CAPACITOR_IDB_PERSIST_BATCH_SIZE);
    for (const groupName of batch) {
      const members = (grouped.get(groupName) || []).slice(0, CAPACITOR_MAX_GROUP_CHANNELS);
      if (members.length > 0) {
        await writeCachedChannelsToIndexedDb(db, idbLiveGroupRecordKey(groupName), members, writeOptions);
      }
    }

    // Yield the main thread between IDB batches — 900+ writes otherwise ANR Fire TV.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }

  await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY);
  await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_RECORD_KEY);

  db.close();
  if (debugLog) debugLog(`capacitor-ingest: persisted ${groupNames.length} live groups to idb`);
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function ingestCapacitorLiveChannelCatalogAsync(
  list: Channel[],
  preferredGroup?: string
): Promise<{ groupName: string; channelCount: number; totalLive: number }> {
  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  const groupCounts = new Map<string, number>();
  const groupBuckets = new Map<string, Channel[]>();
  let totalLive = 0;

  for (let offset = 0; offset < list.length; offset += CAPACITOR_INGEST_CHUNK_SIZE) {
    const end = Math.min(offset + CAPACITOR_INGEST_CHUNK_SIZE, list.length);
    for (let index = offset; index < end; index += 1) {
      const channel = list[index];
      if (!isLiveChannel(channel)) continue;
      totalLive += 1;
      const group = normalizeGroupName(channel.group);
      groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
      let bucket = groupBuckets.get(group);
      if (!bucket) {
        bucket = [];
        groupBuckets.set(group, bucket);
      }
      if (bucket.length < CAPACITOR_MAX_GROUP_CHANNELS) {
        bucket.push(channel);
      }
    }
    await yieldToMain();
  }

  const groupNames = Array.from(groupCounts.keys()).sort((a, b) => a.localeCompare(b));
  const counts: Record<string, number> = {};
  groupCounts.forEach((count, group) => {
    counts[group] = count;
  });
  saveCapacitorLiveGroupCatalog(groupNames, counts);
  // Record which split group each favorited channel lives in so the Favorites
  // view can aggregate them from IndexedDB without a full catalog load.
  rebuildCapacitorFavoriteIndexFromCatalog(list);

  const normalizedPreferred = preferredGroup ? normalizeGroupName(preferredGroup) : "";
  const targetGroup =
    (normalizedPreferred && groupCounts.has(normalizedPreferred) ? normalizedPreferred : "") ||
    groupNames[0] ||
    "Uncategorized";

  const memoryChannels = (groupBuckets.get(targetGroup) || []).slice(0, CAPACITOR_MAX_GROUP_CHANNELS);
  debugLog(
    `capacitor-ingest: ${list.length} total -> ${memoryChannels.length} in memory (${targetGroup}), ${groupNames.length} groups`
  );
  setChannelsWithoutSideEffects(memoryChannels, "capacitor-live-ingest");

  const db = await openChannelsCacheDb();
  if (db) {
    const writeOptions = { quiet: groupNames.length > CAPACITOR_BULK_GROUP_THRESHOLD };
    for (let index = 0; index < groupNames.length; index += CAPACITOR_IDB_PERSIST_BATCH_SIZE) {
      const batch = groupNames.slice(index, index + CAPACITOR_IDB_PERSIST_BATCH_SIZE);
      for (const groupName of batch) {
        const members = groupBuckets.get(groupName) || [];
        if (members.length > 0) {
          await writeCachedChannelsToIndexedDb(db, idbLiveGroupRecordKey(groupName), members, writeOptions);
        }
        groupBuckets.delete(groupName);
      }
      await yieldToMain();
    }

    await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_LIVE_RECORD_KEY);
    await deleteCachedChannelsFromIndexedDb(db, CHANNELS_CACHE_RECORD_KEY);
    db.close();
    if (debugLog) debugLog(`capacitor-ingest: persisted ${groupNames.length} live groups to idb`);
  }

  groupBuckets.clear();
  dispatchStoreEvent("channelsUpdated");

  return {
    groupName: targetGroup,
    channelCount: memoryChannels.length,
    totalLive
  };
}

let capacitorLiveIngestInFlight = false;

export function ingestCapacitorLiveChannelCatalog(
  list: Channel[],
  preferredGroup?: string
): { groupName: string; channelCount: number; totalLive: number } {
  if (isCapacitorRuntime() && list.length > CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD) {
    if (capacitorLiveIngestInFlight) {
      const debugLog = (window as any).webosDebugLog || console.log.bind(console);
      debugLog("capacitor-ingest: skipped duplicate while a catalog ingest is already running");
      const preferred = preferredGroup ? normalizeGroupName(preferredGroup) : "";
      return {
        groupName: preferred || "Uncategorized",
        channelCount: channels.length,
        totalLive: list.filter(isLiveChannel).length
      };
    }
    capacitorLiveIngestInFlight = true;
    void ingestCapacitorLiveChannelCatalogAsync(list, preferredGroup).finally(() => {
      capacitorLiveIngestInFlight = false;
    });
    const preferred = preferredGroup ? normalizeGroupName(preferredGroup) : "";
    return {
      groupName: preferred || "Uncategorized",
      channelCount: channels.length,
      totalLive: list.filter(isLiveChannel).length
    };
  }

  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  const groupCounts = new Map<string, number>();
  let totalLive = 0;

  for (const channel of list) {
    if (!isLiveChannel(channel)) continue;
    totalLive += 1;
    const group = normalizeGroupName(channel.group);
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }

  const groupNames = Array.from(groupCounts.keys()).sort((a, b) => a.localeCompare(b));
  const counts: Record<string, number> = {};
  groupCounts.forEach((count, group) => {
    counts[group] = count;
  });
  saveCapacitorLiveGroupCatalog(groupNames, counts);
  // Record which split group each favorited channel lives in so the Favorites
  // view can aggregate them from IndexedDB without a full catalog load.
  rebuildCapacitorFavoriteIndexFromCatalog(list);

  const normalizedPreferred = preferredGroup ? normalizeGroupName(preferredGroup) : "";
  const targetGroup =
    (normalizedPreferred && groupCounts.has(normalizedPreferred) ? normalizedPreferred : "") ||
    groupNames[0] ||
    "Uncategorized";

  const memoryChannels: Channel[] = [];
  for (const channel of list) {
    if (!isLiveChannel(channel)) continue;
    if (normalizeGroupName(channel.group) !== targetGroup) continue;
    memoryChannels.push(channel);
    if (memoryChannels.length >= CAPACITOR_MAX_GROUP_CHANNELS) break;
  }

  debugLog(
    `capacitor-ingest: ${list.length} total -> ${memoryChannels.length} in memory (${targetGroup}), ${groupNames.length} groups`
  );
  setChannelsWithoutSideEffects(memoryChannels, "capacitor-live-ingest");

  window.setTimeout(() => {
    void persistCapacitorLiveGroupsToIdb(list, groupNames);
  }, 300);

  return {
    groupName: targetGroup,
    channelCount: memoryChannels.length,
    totalLive
  };
}

export async function loadCapacitorLiveGroupChannels(groupName: string): Promise<Channel[]> {
  if (!isCapacitorRuntime()) return channels;

  const normalized = normalizeGroupName(groupName);
  const liveInMemory = channels.filter(isLiveChannel);
  const alreadyLoaded =
    liveInMemory.length > 0 &&
    liveInMemory.length <= CAPACITOR_MAX_GROUP_CHANNELS + 16 &&
    liveInMemory.every((channel) => normalizeGroupName(channel.group) === normalized);
  if (alreadyLoaded) {
    return channels;
  }

  const db = await openChannelsCacheDb();
  if (!db) return [];

  const loaded = await readCachedChannelsFromIndexedDb(db, idbLiveGroupRecordKey(normalized));
  db.close();

  if (loaded.length > 0) {
    setChannelsWithoutSideEffects(loaded, "capacitor-group-load");
  }

  return loaded.length > 0 ? loaded : channels;
}

// ---------------------------------------------------------------------------
// Capacitor VOD scope cache (movies/series)
//
// Fire TV/Android keeps only one live group in memory and never persists the
// lazy VOD loads (see setChannels), so every cold start used to require a full
// provider re-download on first entry into Movies/Series. This cache stores
// each VOD scope as chunked IndexedDB records keyed by playlist id, letting a
// background startup prefetch warm Movies/Series without touching the
// live-only in-memory catalog.
// ---------------------------------------------------------------------------
export type CapacitorVodCacheScope = "movies" | "series";

/** VOD catalogs change often; re-warm scopes older than this at startup. */
export const CAPACITOR_VOD_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CAPACITOR_VOD_CACHE_META_KEY = "iptvmate_capacitor_vod_cache_meta";
const CAPACITOR_VOD_RECORD_PREFIX = "capacitor-vod";
const CAPACITOR_VOD_PERSIST_BATCH_SIZE = 4000;

type CapacitorVodScopeMeta = {
  playlistId: string;
  count: number;
  chunks: number;
  updatedAt: number;
};

type CapacitorVodCacheMeta = Partial<Record<CapacitorVodCacheScope, CapacitorVodScopeMeta>>;

function idbVodScopeRecordKey(scope: CapacitorVodCacheScope, chunkIndex: number): string {
  return `${CAPACITOR_VOD_RECORD_PREFIX}-${scope}-chunk-${chunkIndex}`;
}

function loadCapacitorVodCacheMeta(): CapacitorVodCacheMeta {
  try {
    const raw = localStorage.getItem(CAPACITOR_VOD_CACHE_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CapacitorVodCacheMeta;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveCapacitorVodCacheMeta(meta: CapacitorVodCacheMeta): void {
  try {
    localStorage.setItem(CAPACITOR_VOD_CACHE_META_KEY, JSON.stringify(meta));
  } catch {
    // Ignore persistence errors.
  }
}

function normalizeVodScopePlaylistIds(acceptablePlaylistIds: string[]): Set<string> {
  return new Set(
    (Array.isArray(acceptablePlaylistIds) ? acceptablePlaylistIds : [])
      .map((id) => String(id || "").trim())
      .filter((id) => id.length > 0)
  );
}

function getCapacitorVodScopeMetaIfUsable(
  scope: CapacitorVodCacheScope,
  acceptablePlaylistIds: Set<string>
): CapacitorVodScopeMeta | null {
  const meta = loadCapacitorVodCacheMeta()[scope];
  if (!meta) return null;
  const playlistId = String(meta.playlistId || "").trim();
  if (!playlistId || (acceptablePlaylistIds.size > 0 && !acceptablePlaylistIds.has(playlistId))) {
    return null;
  }
  if (!Number.isFinite(meta.count) || meta.count <= 0 || !Number.isFinite(meta.chunks) || meta.chunks <= 0) {
    return null;
  }
  // A pre-cap Fire TV cache can be 40+ chunks / 100k+ titles. Reading it ANRs.
  if (meta.count > CAPACITOR_MAX_GROUP_CHANNELS || meta.chunks > 2) {
    return null;
  }
  return { ...meta, playlistId };
}

/** Fire TV cannot hold a 100k+ VOD catalog in RAM or IndexedDB. */
export function capCapacitorCatalogList<T>(list: T[]): T[] {
  if (!Array.isArray(list)) return [];
  if (!isCapacitorRuntime() || list.length <= CAPACITOR_MAX_GROUP_CHANNELS) return list;
  return list.slice(0, CAPACITOR_MAX_GROUP_CHANNELS);
}

/** True when a usable, non-stale VOD scope cache exists for one of the playlists. */
export function isCapacitorVodScopeCacheFresh(
  scope: CapacitorVodCacheScope,
  acceptablePlaylistIds: string[],
  maxAgeMs: number = CAPACITOR_VOD_CACHE_MAX_AGE_MS
): boolean {
  if (!isCapacitorRuntime()) return false;
  const meta = getCapacitorVodScopeMetaIfUsable(scope, normalizeVodScopePlaylistIds(acceptablePlaylistIds));
  if (!meta) return false;
  return Date.now() - Number(meta.updatedAt || 0) < maxAgeMs;
}

// Single-flight per scope: a second save request while one is still writing
// reuses the in-flight write — the catalogs come from the same playlist.
const capacitorVodScopeSaveInFlight: Partial<Record<CapacitorVodCacheScope, Promise<void>>> = {};

export async function saveCapacitorVodScopeCache(
  scope: CapacitorVodCacheScope,
  playlistId: string,
  list: Channel[]
): Promise<void> {
  if (!isCapacitorRuntime()) return;
  const normalizedPlaylistId = String(playlistId || "").trim();
  if (!normalizedPlaylistId || !Array.isArray(list) || list.length === 0) return;
  if (capacitorVodScopeSaveInFlight[scope]) return capacitorVodScopeSaveInFlight[scope];

  capacitorVodScopeSaveInFlight[scope] = (async () => {
    const debugLog = (window as any).webosDebugLog || console.log.bind(console);
    const expectedType = scope === "movies" ? "movie" : "series";
    const scopedChannels = capCapacitorCatalogList(
      list.filter((channel) => String(channel?.contentType || "").trim().toLowerCase() === expectedType)
    );
    if (scopedChannels.length === 0) return;

    const db = await openChannelsCacheDb();
    if (!db) return;

    try {
      const chunkCount = Math.ceil(scopedChannels.length / CAPACITOR_VOD_PERSIST_BATCH_SIZE);
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const chunk = scopedChannels.slice(
          chunkIndex * CAPACITOR_VOD_PERSIST_BATCH_SIZE,
          (chunkIndex + 1) * CAPACITOR_VOD_PERSIST_BATCH_SIZE
        );
        await writeCachedChannelsToIndexedDb(db, idbVodScopeRecordKey(scope, chunkIndex), chunk, { quiet: true });
        // Yield the main thread between chunks — large VOD catalogs otherwise ANR Fire TV.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      // Drop stale chunk records left over from a previously larger catalog.
      const previousMeta = loadCapacitorVodCacheMeta()[scope];
      const previousChunks = Number(previousMeta?.chunks || 0);
      for (let chunkIndex = chunkCount; chunkIndex < previousChunks; chunkIndex += 1) {
        await deleteCachedChannelsFromIndexedDb(db, idbVodScopeRecordKey(scope, chunkIndex));
      }

      // Write meta last: a crash mid-write leaves the previous meta pointing at
      // still-valid previous chunk records instead of a partial new catalog.
      const meta = loadCapacitorVodCacheMeta();
      meta[scope] = {
        playlistId: normalizedPlaylistId,
        count: scopedChannels.length,
        chunks: chunkCount,
        updatedAt: Date.now()
      };
      saveCapacitorVodCacheMeta(meta);
      debugLog(`vod-cache: persisted ${scopedChannels.length} ${scope} in ${chunkCount} chunks`);
    } finally {
      db.close();
    }
  })().finally(() => {
    capacitorVodScopeSaveInFlight[scope] = undefined;
  });

  return capacitorVodScopeSaveInFlight[scope];
}

/**
 * Loads a persisted VOD scope (movies or series) without touching the in-memory
 * channel list — the caller decides whether to apply it. Returns [] when no
 * usable cache exists for any of the acceptable playlist ids.
 */
export async function loadCapacitorVodScopeCache(
  scope: CapacitorVodCacheScope,
  acceptablePlaylistIds: string[]
): Promise<Channel[]> {
  if (!isCapacitorRuntime()) return [];
  const meta = getCapacitorVodScopeMetaIfUsable(scope, normalizeVodScopePlaylistIds(acceptablePlaylistIds));
  if (!meta) return [];

  const db = await openChannelsCacheDb();
  if (!db) return [];

  try {
    const result: Channel[] = [];
    for (let chunkIndex = 0; chunkIndex < meta.chunks; chunkIndex += 1) {
      if (result.length >= CAPACITOR_MAX_GROUP_CHANNELS) break;
      const chunk = await readCachedChannelsFromIndexedDb(db, idbVodScopeRecordKey(scope, chunkIndex));
      if (chunk.length === 0) {
        // A missing chunk means the cache is corrupt/partial — treat as no cache.
        return [];
      }
      for (const channel of chunk) {
        result.push(channel);
        if (result.length >= CAPACITOR_MAX_GROUP_CHANNELS) break;
      }
      // Keep the UI responsive while deserializing large catalogs on Fire TV.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * Aggregates every favorited live channel into memory on Capacitor. The live
 * catalog is split into per-group IndexedDB records (only one group is kept in
 * memory at a time), so the Favorites group cannot be rendered from memory
 * alone — starred channels may live in any of the catalog's groups. The
 * persisted favorites index tells us exactly which group records to read, and
 * a one-time-per-session full scan re-indexes legacy favorites that were saved
 * before the index existed (or whose group assignment went stale).
 */
export async function loadCapacitorFavoriteChannels(): Promise<Channel[]> {
  const favoriteIds = getFavoriteIdSet();

  if (!isCapacitorRuntime()) {
    return channels.filter((channel) => isFavoriteChannelRecord(channel));
  }

  if (favoriteIds.size === 0) {
    return [];
  }

  // Skip the IndexedDB aggregation when memory already holds exactly this
  // favorites set (e.g. the menu is re-opened without any favorite changes).
  const signature = buildCapacitorFavoritesSignature(favoriteIds);
  if (signature && capacitorFavoritesViewSignature === signature) {
    return channels;
  }

  // Bucket favorite ids by their catalog group so we only read the group
  // records that actually contain starred channels.
  const idsByGroup = new Map<string, Set<string>>();
  for (const id of favoriteIds) {
    const indexedGroup = String(capacitorFavoriteIndex[id]?.group || "").trim();
    if (!indexedGroup) continue;
    let bucket = idsByGroup.get(indexedGroup);
    if (!bucket) {
      bucket = new Set<string>();
      idsByGroup.set(indexedGroup, bucket);
    }
    bucket.add(id);
  }

  const favorites: Channel[] = [];
  const foundIds = new Set<string>();
  const seenKeys = new Set<string>();
  let indexChanged = false;

  const collect = (list: Channel[]) => {
    for (const channel of list) {
      if (favorites.length >= CAPACITOR_MAX_GROUP_CHANNELS) return;
      const id = String(channel?.id || "").trim();
      if (!id || foundIds.has(id) || !favoriteIds.has(id)) continue;
      if (!isFavoriteChannelRecord(channel)) continue;
      const dedupeKey = `${id}|${normalizeFavoriteUrl(String(channel?.url || ""))}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      foundIds.add(id);
      favorites.push(channel);
      // Keep the index fresh: fill gaps and correct stale group assignments.
      const group = normalizeGroupName(channel.group);
      const existing = capacitorFavoriteIndex[id];
      if (!existing || existing.group !== group) {
        capacitorFavoriteIndex[id] = {
          group,
          url: String(channel?.url || "").trim(),
          name: typeof channel?.name === "string" ? channel.name : undefined
        };
        indexChanged = true;
      }
    }
  };

  // Favorites already in memory (the currently loaded group, plus movies /
  // series favorites which are not split into per-group IDB records).
  collect(channels);

  const db = await openChannelsCacheDb();
  if (db) {
    try {
      // Fast path: read only the groups the favorites index points to.
      for (const groupName of idsByGroup.keys()) {
        if (favorites.length >= CAPACITOR_MAX_GROUP_CHANNELS) break;
        const members = await readCachedChannelsFromIndexedDb(db, idbLiveGroupRecordKey(groupName));
        collect(members);
        await yieldToMain();
      }

      // Slow path: some favorites are not indexed yet — scan the remaining
      // catalog groups once per session to locate and index them.
      const hasMissing = [...favoriteIds].some((id) => !foundIds.has(id));
      if (hasMissing && !capacitorFavoriteIndexScanStarted) {
        capacitorFavoriteIndexScanStarted = true;
        for (const groupName of getCapacitorLiveGroupNames()) {
          if (idsByGroup.has(groupName)) continue;
          if (favorites.length >= CAPACITOR_MAX_GROUP_CHANNELS) break;
          const members = await readCachedChannelsFromIndexedDb(db, idbLiveGroupRecordKey(groupName));
          collect(members);
          await yieldToMain();
          if ([...favoriteIds].every((id) => foundIds.has(id))) break;
        }
      }
    } finally {
      db.close();
    }
  }

  if (indexChanged) {
    saveCapacitorFavoriteIndex();
  }

  if (favorites.length === 0) {
    // Nothing resolvable yet (e.g. catalog not ingested). Keep the current
    // in-memory list rather than wiping it; the view will simply show the
    // favorites subset of whatever is loaded.
    return [];
  }

  setChannelsWithoutSideEffects(favorites, "capacitor-favorites-load");
  capacitorFavoritesViewSignature = signature;
  return favorites;
}

export function trimCapacitorChannelMemoryForLive(): number {
  if (!isCapacitorRuntime()) return channels.length;
  if (channels.length <= CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD) return channels.length;

  const liveOnly = channels.filter(isLiveChannel);
  if (liveOnly.length === 0) {
    return channels.length;
  }

  if (liveOnly.length < channels.length) {
    setChannelsWithoutSideEffects(liveOnly, "capacitor-live-trim");
    return liveOnly.length;
  }

  return channels.length;
}

export function releaseCapacitorMemoryForLivePlayback(
  activeGroupName: string,
  activeChannelId?: string
): number {
  if (!isCapacitorRuntime()) return channels.length;

  const normalizedActive = normalizeGroupName(activeGroupName);
  let trimmed = channels.filter((channel) => {
    if (!isLiveChannel(channel)) return false;
    if (activeChannelId && String(channel.id || "") === activeChannelId) return true;
    return normalizeGroupName(channel.group) === normalizedActive;
  });

  if (activeChannelId && !trimmed.some((channel) => String(channel.id || "") === activeChannelId)) {
    const activeChannel = channels.find((channel) => String(channel.id || "") === activeChannelId);
    if (activeChannel) {
      trimmed = [activeChannel, ...trimmed];
    }
  }

  if (trimmed.length > CAPACITOR_MAX_GROUP_CHANNELS) {
    const head = trimmed.slice(0, CAPACITOR_MAX_GROUP_CHANNELS);
    if (activeChannelId && !head.some((channel) => String(channel.id || "") === activeChannelId)) {
      const activeChannel = trimmed.find((channel) => String(channel.id || "") === activeChannelId);
      if (activeChannel) {
        trimmed = [activeChannel, ...head.slice(0, CAPACITOR_MAX_GROUP_CHANNELS - 1)];
      } else {
        trimmed = head;
      }
    } else {
      trimmed = head;
    }
  }

  if (trimmed.length === 0) {
    return channels.length;
  }

  if (trimmed.length >= channels.length && channels.length <= CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD) {
    return channels.length;
  }

  const debugLog = (window as any).webosDebugLog || console.log.bind(console);
  debugLog(`capacitor-playback-trim: ${channels.length} -> ${trimmed.length} (${normalizedActive})`);
  setChannelsWithoutSideEffects(trimmed, "capacitor-playback-trim");
  return trimmed.length;
}

function pruneVisibilityForCurrentChannels() {
  const currentIds = new Set(channels.map((c) => c.id));
  const nextChannelVisibility: Record<string, boolean> = {};

  Object.entries(visibilityState.channels).forEach(([id, visible]) => {
    if (currentIds.has(id)) {
      nextChannelVisibility[id] = visible;
    }
  });

  visibilityState = {
    ...visibilityState,
    channels: nextChannelVisibility
  };
  saveVisibilityState();
}

function setChannelsWithoutSideEffects(list: Channel[], source: string) {
  if (roleChannelWriteLock && !ROLE_LOCK_ALLOWED_SOURCES.has(source)) {
    recordChannelWriteTrace(source, false, channels.length);
    return;
  }

  if (
    isCapacitorRuntime() &&
    list.length > CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD &&
    list.some(isLiveChannel)
  ) {
    ingestCapacitorLiveChannelCatalog(list);
    recordChannelWriteTrace(source, true, channels.length);
    return;
  }

  applyCachedChannels(list);
  recordChannelWriteTrace(source, true, channels.length);

  const isLargeCapacitorUpdate = isCapacitorRuntime() && list.length > 3000;
  const finishHeavyWork = () => {
    migrateLegacyFavoritesForCurrentChannels();
    pruneVisibilityForCurrentChannels();
  };

  if (isLargeCapacitorUpdate) {
    window.setTimeout(finishHeavyWork, 0);
  } else {
    finishHeavyWork();
  }
}

export function setChannels(list: Channel[], source: string = "unknown") {
  if (roleChannelWriteLock && !ROLE_LOCK_ALLOWED_SOURCES.has(source)) {
    recordChannelWriteTrace(source, false, channels.length);
    return;
  }

  if (
    isCapacitorRuntime() &&
    list.length > CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD &&
    list.some(isLiveChannel)
  ) {
    ingestCapacitorLiveChannelCatalog(list);
    recordChannelWriteTrace(source, true, channels.length);
    return;
  }

  applyCachedChannels(list);
  recordChannelWriteTrace(source, true, channels.length);

  const isLargeCapacitorUpdate = isCapacitorRuntime() && list.length > 3000;
  const finishHeavyWork = () => {
    migrateLegacyFavoritesForCurrentChannels();
    pruneVisibilityForCurrentChannels();
  };

  if (isLargeCapacitorUpdate) {
    window.setTimeout(finishHeavyWork, 0);
  } else {
    finishHeavyWork();
  }

  // Preserve the last generic cache when role-clear intentionally empties runtime
  // channels (e.g., missing assigned role playlist). This avoids startup falling
  // back to an empty cached channel set.
  // On Capacitor, lazy VOD scope loads (movies/series) hold only a partial view
  // of the catalog — the live catalog already persists as per-group IndexedDB
  // records — so they must never overwrite the monolithic channel cache.
  const shouldPersistCache =
    !(source === "role-clear" && channels.length === 0) &&
    !CAPACITOR_TRANSIENT_SOURCES.has(source) &&
    !(
      isCapacitorRuntime() &&
      (source === "lazy-movies-load" || source === "lazy-series-load")
    );
  if (shouldPersistCache) {
    saveCachedChannels(channels);
    void saveCachedChannelsIndexedDb(channels);
    saveCachedChannelsWebosDb(channels);
  }
}

export async function restoreChannelsCache(): Promise<Channel[]> {
  if (restoreChannelsCacheInFlight) {
    return restoreChannelsCacheInFlight;
  }

  restoreChannelsCacheInFlight = restoreChannelsCacheInternal().finally(() => {
    restoreChannelsCacheInFlight = null;
  });
  return restoreChannelsCacheInFlight;
}

async function restoreChannelsCacheInternal(): Promise<Channel[]> {
  if (roleChannelWriteLock) {
    // During role-locked sessions, never restore generic global cache.
    recordChannelWriteTrace("restore-cache-locked", false, channels.length);
    return channels;
  }

  if (channels.length > 0) {
    return channels;
  }

  const fromLocalStorage = loadCachedChannelsWithPresence();
  if (fromLocalStorage.hasValue) {
    if (fromLocalStorage.channels.length > 0) {
      // Fire TV keeps only one live group in localStorage; skip a parallel IndexedDB
      // scan across the full group catalog — that blocks the WebView and can ANR.
      if (isCapacitorRuntime()) {
        applyRestoredChannels(fromLocalStorage.channels);
        recordChannelWriteTrace("restore-cache-local-capacitor", true, fromLocalStorage.channels.length);
        return channels;
      }

      const fromIndexedDb = await Promise.race([
        loadCachedChannelsIndexedDb(),
        new Promise<Channel[]>((resolve) => {
          window.setTimeout(() => resolve([]), CHANNELS_CACHE_DB_TIMEOUT_MS);
        })
      ]);
      if (roleChannelWriteLock) {
        recordChannelWriteTrace("restore-cache-indexeddb-locked", false, channels.length);
        return channels;
      }

      if (fromIndexedDb.length > fromLocalStorage.channels.length) {
        applyRestoredChannels(fromIndexedDb);
        recordChannelWriteTrace("restore-cache-indexeddb-preferred", true, fromIndexedDb.length);
        if (!isCapacitorRuntime() || fromIndexedDb.length <= CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD) {
          saveCachedChannels(fromIndexedDb);
        }
        return channels;
      }

      applyRestoredChannels(fromLocalStorage.channels);
      recordChannelWriteTrace("restore-cache-local", true, fromLocalStorage.channels.length);
      return channels;
    } else {
      recordChannelWriteTrace("restore-cache-local-empty", false, channels.length);
    }

    // If localStorage cache is empty, allow IndexedDB fallback. This recovers
    // from older sessions that accidentally persisted an empty local cache
    // while IndexedDB still has the last valid loaded channels.
  }

  const fromIndexedDb = await Promise.race([
    loadCachedChannelsIndexedDb(),
    new Promise<Channel[]>((resolve) => {
      window.setTimeout(() => resolve([]), CHANNELS_CACHE_DB_TIMEOUT_MS);
    })
  ]);
  if (roleChannelWriteLock) {
    // Role lock may have been enabled while awaiting IndexedDB.
    recordChannelWriteTrace("restore-cache-indexeddb-locked", false, channels.length);
    return channels;
  }

  if (fromIndexedDb.length > 0) {
    applyRestoredChannels(fromIndexedDb);
    recordChannelWriteTrace("restore-cache-indexeddb", true, fromIndexedDb.length);
    if (!isCapacitorRuntime() || fromIndexedDb.length <= CAPACITOR_LIVE_MEMORY_TRIM_THRESHOLD) {
      saveCachedChannels(fromIndexedDb);
    }
    return channels;
  }

  // Final fallback: webOS DB8 survives the storage purges that clear the
  // layers above on LG TVs.
  const fromWebosDb = await loadCachedChannelsWebosDb();
  if (roleChannelWriteLock) {
    recordChannelWriteTrace("restore-cache-webosdb-locked", false, channels.length);
    return channels;
  }
  if (fromWebosDb.length > 0) {
    applyRestoredChannels(fromWebosDb);
    recordChannelWriteTrace("restore-cache-webosdb", true, fromWebosDb.length);
    saveCachedChannels(fromWebosDb);
    void saveCachedChannelsIndexedDb(fromWebosDb);
    return channels;
  }

  recordChannelWriteTrace("restore-cache-none", false, channels.length);

  return [];
}

export function getChannels(): Channel[] {
  if (activeGroup === "All") return channels;
  return channels.filter((c) => c.group === activeGroup);
}

export function getAllChannels(): Channel[] {
  return channels;
}

export function getGroups(): string[] {
  const groups = new Set<string>();
  groups.add("All");

  channels.forEach((c) => {
    if (c.group) groups.add(c.group);
  });

  return Array.from(groups);
}

export function isGroupVisible(group: string): boolean {
  if (group === "All" || group === FAVORITES_GROUP) return true;
  if (visibilityState.allGroupsHidden) {
    return visibilityState.groups[group] === true;
  }
  return visibilityState.groups[group] !== false;
}

export function setGroupVisible(group: string, visible: boolean) {
  if (group === "All" || group === FAVORITES_GROUP) return;

  const nextGroups = { ...visibilityState.groups };
  if (visibilityState.allGroupsHidden) {
    if (visible) {
      nextGroups[group] = true;
    } else {
      delete nextGroups[group];
    }
  } else if (visible) {
    delete nextGroups[group];
  } else {
    nextGroups[group] = false;
  }

  visibilityState = {
    ...visibilityState,
    groups: nextGroups
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function setGroupsVisible(groups: string[], visible: boolean, catalogWide = false) {
  if (catalogWide && isCapacitorRuntime() && groups.length >= CAPACITOR_BULK_GROUP_THRESHOLD) {
    visibilityState = {
      ...visibilityState,
      groups: {},
      allGroupsHidden: !visible
    };
    saveVisibilityState();
    dispatchVisibilityChanged();
    return;
  }

  const nextGroups = { ...visibilityState.groups };

  for (const group of groups) {
    if (group === "All" || group === FAVORITES_GROUP) continue;
    if (visible) {
      delete nextGroups[group];
    } else {
      nextGroups[group] = false;
    }
  }

  visibilityState = {
    ...visibilityState,
    groups: nextGroups,
    allGroupsHidden: false
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function isChannelVisible(channelId: string): boolean {
  return visibilityState.channels[channelId] !== false;
}

export function setChannelVisible(channelId: string, visible: boolean) {
  visibilityState = {
    ...visibilityState,
    channels: {
      ...visibilityState.channels,
      [channelId]: visible
    }
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function isFavoriteChannel(channelId: string): boolean {
  return favoriteChannelIds.has(String(channelId || "").trim());
}

export function setChannelFavorite(channelId: string, isFavorite: boolean) {
  const id = String(channelId || "").trim();
  if (!id) return;

  const key = `id:${id}`;
  const wasFavorite = favoriteEntries.has(key);

  if (isFavorite && !wasFavorite) {
    favoriteEntries.set(key, { key, id, url: "" });
    favoriteChannelIds.add(id);
    saveFavoriteEntries();
    dispatchFavoritesChanged();
    return;
  }

  if (!isFavorite && wasFavorite) {
    favoriteEntries.delete(key);
    favoriteChannelIds = buildFavoriteIdSet(favoriteEntries);
    saveFavoriteEntries();
    dispatchFavoritesChanged();
  }
}

export function isFavoriteChannelRecord(channel: Partial<Channel> | null | undefined): boolean {
  if (!channel) return false;

  const key = buildFavoriteKey(channel);
  if (key && favoriteEntries.has(key)) return true;

  const id = String(channel.id || "").trim();
  if (!id) return false;

  // Series stream URLs can legitimately change per provider/refresh while
  // remaining the same logical series item. Fall back to id matching.
  if (isSeriesLikeFavoriteChannel(channel) && hasFavoriteEntryWithId(id)) {
    return true;
  }

  // Legacy favorites were saved as bare ids (pre url-keyed entries). Providers
  // often repeat a stream id across categories, so uniqueness must NOT be
  // required here — otherwise these favorites silently vanish from the
  // Favorites list until the entry gets re-favorited or migrated.
  if (hasLegacyIdOnlyFavorite(id)) {
    return true;
  }

  // Match when the id has a favorite entry and the current channel url also
  // appears in a stored entry. This covers playlists where multiple channels
  // share the same id (e.g. different quality variants / groups) and the
  // composite key didn't match above due to object-reference differences
  // (cache restore, etc.) but the id+url still identify the same stream.
  const url = normalizeFavoriteUrl(channel.url || "");
  if (id && url && hasFavoriteEntryWithId(id) && hasFavoriteEntryWithUrl(url)) {
    return true;
  }

  // URL drift (rotating stream tokens / proxies / CDN hosts): if the favorited
  // id maps to exactly one current channel, the bookmark is unambiguous, so
  // match on id even when the saved url differs from the channel's current url.
  return hasFavoriteEntryWithId(id) && hasUniqueCurrentChannelId(id);
}

export function setChannelFavoriteRecord(channel: Partial<Channel> | null | undefined, isFavorite: boolean) {
  if (!channel) return;

  const id = String(channel.id || "").trim();
  if (!id) return;

  const key = buildFavoriteKey(channel);
  if (!key) return;

  let changed = false;

  if (isFavorite) {
    const legacyKey = `id:${id}`;
    if (favoriteEntries.delete(legacyKey)) {
      changed = true;
    }

    if (!favoriteEntries.has(key)) {
      favoriteEntries.set(key, {
        key,
        id,
        url: normalizeFavoriteUrl(String(channel.url || "")),
        name: typeof channel.name === "string" ? channel.name : undefined
      });
      changed = true;
    }
  } else {
    const removedExact = favoriteEntries.delete(key);
    if (removedExact) {
      changed = true;
    }

    if (isSeriesLikeFavoriteChannel(channel)) {
      for (const [entryKey, entry] of favoriteEntries.entries()) {
        if (entry.id !== id) continue;
        favoriteEntries.delete(entryKey);
        changed = true;
      }
    }

    // Remove legacy id-only favorite so toggling off behaves consistently.
    const legacyKey = `id:${id}`;
    if (legacyKey !== key && favoriteEntries.delete(legacyKey)) {
      changed = true;
    }
  }

  if (!changed) return;

  favoriteChannelIds = buildFavoriteIdSet(favoriteEntries);
  saveFavoriteEntries();
  syncCapacitorFavoriteIndexForChannel(channel, isFavorite);
  dispatchFavoritesChanged();
}

export function resetVisibilityForCurrentChannels() {
  const visibleGroups: Record<string, boolean> = {};
  // Optimization: Don't store "true" for every channel. Assume visible by default.
  // This saves significant memory and storage space for large playlists.
  const visibleChannels: Record<string, boolean> = {};

  for (const channel of channels) {
    const groupName = normalizeGroupName(channel.group);
    if (groupName !== "All") {
      visibleGroups[groupName] = true;
    }
  }

  visibilityState = {
    groups: visibleGroups,
    channels: visibleChannels,
    allGroupsHidden: false
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function getVisibilitySnapshot(): ChannelVisibilitySnapshot {
  return {
    groups: { ...visibilityState.groups },
    channels: { ...visibilityState.channels },
    allGroupsHidden: visibilityState.allGroupsHidden
  };
}

export function getVisibilitySnapshotForChannelIds(channelIds: string[]): ChannelVisibilitySnapshot {
  const ids = new Set(channelIds.map((id) => String(id || "")).filter((id) => id.length > 0));

  const nextChannels: Record<string, boolean> = {};
  for (const [id, visible] of Object.entries(visibilityState.channels)) {
    if (ids.has(id)) {
      nextChannels[id] = visible;
    }
  }

  const allowedGroups = new Set<string>();
  for (const channel of channels) {
    if (ids.has(channel.id)) {
      allowedGroups.add(normalizeGroupName(channel.group));
    }
  }

  const nextGroups: Record<string, boolean> = {};
  for (const [group, visible] of Object.entries(visibilityState.groups)) {
    if (allowedGroups.has(group)) {
      nextGroups[group] = visible;
    }
  }

  return {
    groups: nextGroups,
    channels: nextChannels,
    allGroupsHidden: visibilityState.allGroupsHidden
  };
}

export function applyVisibilitySnapshotForCurrentChannels(snapshot: ChannelVisibilitySnapshot | null | undefined) {
  if (!snapshot || typeof snapshot !== "object") return;

  const currentIds = new Set(channels.map((channel) => channel.id));
  const allowedGroups = new Set(channels.map((channel) => normalizeGroupName(channel.group)));

  const nextChannels: Record<string, boolean> = {};
  if (snapshot.channels && typeof snapshot.channels === "object") {
    for (const [id, visible] of Object.entries(snapshot.channels)) {
      if (!currentIds.has(id)) continue;
      nextChannels[id] = visible !== false;
    }
  }

  const nextGroups: Record<string, boolean> = {};
  if (snapshot.groups && typeof snapshot.groups === "object") {
    for (const [group, visible] of Object.entries(snapshot.groups)) {
      if (!allowedGroups.has(group)) continue;
      nextGroups[group] = visible !== false;
    }
  }

  visibilityState = {
    groups: nextGroups,
    channels: nextChannels,
    allGroupsHidden: snapshot.allGroupsHidden === true
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function setActiveGroup(group: string) {
  activeGroup = group;
}

export function getActiveGroup(): string {
  return activeGroup;
}
