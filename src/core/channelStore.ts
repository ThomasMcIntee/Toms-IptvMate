export type ContentType = "live" | "movie" | "series";

export type Channel = {
  id: string;
  name: string;
  logo?: string;
  url: string;
  group?: string;
  contentType?: ContentType;
  parentGroup?: string; // For series: group that contains this series
  episodeInfo?: {
    season?: number;
    episode?: number;
    title?: string;
  };
};

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
const CHANNELS_CACHE_DB = "iptvmate_cache";
const CHANNELS_CACHE_STORE = "channels";
const CHANNELS_CACHE_RECORD_KEY = "latest";

type VisibilityState = {
  groups: Record<string, boolean>;
  channels: Record<string, boolean>;
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

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("channelsWriteTrace", { detail: lastChannelWriteTrace }));
  }
}

export function getLastChannelWriteTrace(): ChannelWriteTrace {
  return lastChannelWriteTrace;
}

let visibilityState: VisibilityState = loadVisibilityState();
let favoriteEntries = loadFavoriteEntries();
let favoriteChannelIds = buildFavoriteIdSet(favoriteEntries);

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
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("favoritesChanged"));
  }
}

function hasLegacyIdOnlyFavorite(id: string): boolean {
  const entry = favoriteEntries.get(`id:${id}`);
  return !!entry && !String(entry.url || "").trim();
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
  const firstGroup = channels.find((c) => c.group && c.group !== "All")?.group;
  activeGroup = firstGroup || "All";
}

function loadCachedChannelsWithPresence(): { hasValue: boolean; channels: Channel[] } {
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_KEY);
    if (raw === null) return { hasValue: false, channels: [] };

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { hasValue: true, channels: [] };

    return {
      hasValue: true,
      channels: parsed
        .map(toValidChannel)
        .filter((item): item is Channel => !!item)
    };
  } catch {
    return { hasValue: true, channels: [] };
  }
}

function saveCachedChannels(list: Channel[]) {
  try {
    localStorage.setItem(CHANNELS_CACHE_KEY, JSON.stringify(list.map(toCacheChannel)));
  } catch {
    // Ignore persistence errors.
  }
}

async function openChannelsCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(CHANNELS_CACHE_DB, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHANNELS_CACHE_STORE)) {
          db.createObjectStore(CHANNELS_CACHE_STORE);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function saveCachedChannelsIndexedDb(list: Channel[]) {
  const db = await openChannelsCacheDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CHANNELS_CACHE_STORE, "readwrite");
      tx.objectStore(CHANNELS_CACHE_STORE).put(list.map(toCacheChannel), CHANNELS_CACHE_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  db.close();
}

async function loadCachedChannelsIndexedDb(): Promise<Channel[]> {
  const db = await openChannelsCacheDb();
  if (!db) return [];

  const result = await new Promise<Channel[]>((resolve) => {
    try {
      const tx = db.transaction(CHANNELS_CACHE_STORE, "readonly");
      const request = tx.objectStore(CHANNELS_CACHE_STORE).get(CHANNELS_CACHE_RECORD_KEY);
      request.onsuccess = () => {
        const value = request.result as unknown;
        if (!Array.isArray(value)) {
          resolve([]);
          return;
        }

        const channels = value.map(toValidChannel).filter((item): item is Channel => !!item);
        resolve(channels);
      };
      request.onerror = () => resolve([]);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  db.close();
  return result;
}

{
  const cached = loadCachedChannelsWithPresence();
  if (cached.channels.length > 0) {
    applyCachedChannels(cached.channels);
    recordChannelWriteTrace("module-init-cache", true, cached.channels.length);
  }
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
      channels: parsed.channels ?? {}
    };
  } catch {
    return { groups: {}, channels: {} };
  }
}

function saveVisibilityState() {
  // Always write to the live/runtime key. Saved role keys are only written
  // by saveRoleVisibility() so that resetVisibilityForCurrentChannels() can
  // never overwrite the admin's configured hide/show settings.
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(visibilityState));
  } catch {
    // Ignore persistence errors.
  }
}

/** Persist the current visibility state as the saved settings for the given role.
 *  This is the ONLY function that writes to ADULT_SAVED_KEY / CHILD_SAVED_KEY. */
export function saveRoleVisibility(role: "adult" | "child") {
  const key = role === "child" ? CHILD_SAVED_KEY : ADULT_SAVED_KEY;
  try {
    localStorage.setItem(key, JSON.stringify(visibilityState));
  } catch {
    // Ignore persistence errors.
  }
}

/** Switch between adult (default) and child visibility states.
 *  Reads from the explicitly-saved role key so admin settings survive resets.
 *  Never mixes with the live key, which is reset on every playlist load. */
export function setActiveVisibilityRole(role: "adult" | "child") {
  activeVisibilityRole = role;
  const savedKey = role === "child" ? CHILD_SAVED_KEY : ADULT_SAVED_KEY;
  try {
    // Only read from the saved key. Reset never touches it.
    const raw = localStorage.getItem(savedKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VisibilityState>;
      visibilityState = {
        groups: parsed.groups ?? {},
        channels: parsed.channels ?? {}
      };
    } else {
      // No saved settings yet — start fully visible.
      visibilityState = { groups: {}, channels: {} };
    }
  } catch {
    visibilityState = { groups: {}, channels: {} };
  }
  dispatchVisibilityChanged();
}

function dispatchVisibilityChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("visibilityChanged"));
  }
}

function normalizeGroupName(group?: string): string {
  return (group && group.trim()) || "Uncategorized";
}

export function setRoleChannelWriteLock(role: "adult" | "child" | null) {
  roleChannelWriteLock = role;
}

export function setChannels(list: Channel[], source: string = "unknown") {
  if (roleChannelWriteLock && !ROLE_LOCK_ALLOWED_SOURCES.has(source)) {
    recordChannelWriteTrace(source, false, channels.length);
    return;
  }

  applyCachedChannels(list);
  migrateLegacyFavoritesForCurrentChannels();
  recordChannelWriteTrace(source, true, channels.length);
  saveCachedChannels(channels);
  void saveCachedChannelsIndexedDb(channels);

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

export async function restoreChannelsCache(): Promise<Channel[]> {
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
      applyCachedChannels(fromLocalStorage.channels);
      recordChannelWriteTrace("restore-cache-local", true, fromLocalStorage.channels.length);
    } else {
      recordChannelWriteTrace("restore-cache-local-empty", false, channels.length);
    }
    // Explicit local cache (including an empty array) is authoritative.
    // Do not resurrect stale IndexedDB channels over it.
    return channels;
  }

  const fromIndexedDb = await loadCachedChannelsIndexedDb();
  if (roleChannelWriteLock) {
    // Role lock may have been enabled while awaiting IndexedDB.
    recordChannelWriteTrace("restore-cache-indexeddb-locked", false, channels.length);
    return channels;
  }

  if (fromIndexedDb.length > 0) {
    applyCachedChannels(fromIndexedDb);
    recordChannelWriteTrace("restore-cache-indexeddb", true, fromIndexedDb.length);
    saveCachedChannels(fromIndexedDb);
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
  return visibilityState.groups[group] !== false;
}

export function setGroupVisible(group: string, visible: boolean) {
  if (group === "All" || group === FAVORITES_GROUP) return;
  visibilityState = {
    ...visibilityState,
    groups: {
      ...visibilityState.groups,
      [group]: visible
    }
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
}

export function setGroupsVisible(groups: string[], visible: boolean) {
  const nextGroups = { ...visibilityState.groups };

  for (const group of groups) {
    if (group === "All" || group === FAVORITES_GROUP) continue;
    nextGroups[group] = visible;
  }

  visibilityState = {
    ...visibilityState,
    groups: nextGroups
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

  // Legacy compatibility: only trust id-only favorites when that id maps to
  // exactly one current channel, otherwise it is ambiguous across providers.
  return hasLegacyIdOnlyFavorite(id) && hasUniqueCurrentChannelId(id);
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
    if (favoriteEntries.delete(key)) {
      changed = true;
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
  dispatchFavoritesChanged();
}

export function resetVisibilityForCurrentChannels() {
  const visibleGroups: Record<string, boolean> = {};
  const visibleChannels: Record<string, boolean> = {};

  for (const channel of channels) {
    const groupName = normalizeGroupName(channel.group);
    if (groupName !== "All") {
      visibleGroups[groupName] = true;
    }
    visibleChannels[channel.id] = true;
  }

  visibilityState = {
    groups: visibleGroups,
    channels: visibleChannels
  };
  saveVisibilityState();
  dispatchVisibilityChanged();
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
    channels: nextChannels
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
    channels: nextChannels
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
