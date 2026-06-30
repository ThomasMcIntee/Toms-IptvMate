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
const VISIBILITY_KEY = "iptvmate_visibility";
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

let visibilityState: VisibilityState = loadVisibilityState();
let favoriteChannelIds = loadFavoriteChannelIds();

function loadFavoriteChannelIds(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();

    return new Set(
      parsed
        .map((value) => String(value || "").trim())
        .filter((value) => value.length > 0)
    );
  } catch {
    return new Set<string>();
  }
}

function saveFavoriteChannelIds() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(favoriteChannelIds)));
  } catch {
    // Ignore persistence errors.
  }
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

function loadCachedChannels(): Channel[] {
  try {
    const raw = localStorage.getItem(CHANNELS_CACHE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(toValidChannel)
      .filter((item): item is Channel => !!item);
  } catch {
    return [];
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

applyCachedChannels(loadCachedChannels());

function loadVisibilityState(): VisibilityState {
  try {
    const raw = localStorage.getItem(VISIBILITY_KEY);
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
  try {
    localStorage.setItem(VISIBILITY_KEY, JSON.stringify(visibilityState));
  } catch {
    // Ignore persistence errors.
  }
}

function normalizeGroupName(group?: string): string {
  return (group && group.trim()) || "Uncategorized";
}

export function setChannels(list: Channel[]) {
  applyCachedChannels(list);
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
  if (channels.length > 0) {
    return channels;
  }

  const fromLocalStorage = loadCachedChannels();
  if (fromLocalStorage.length > 0) {
    applyCachedChannels(fromLocalStorage);
    return channels;
  }

  const fromIndexedDb = await loadCachedChannelsIndexedDb();
  if (fromIndexedDb.length > 0) {
    applyCachedChannels(fromIndexedDb);
    saveCachedChannels(fromIndexedDb);
    return channels;
  }

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
}

export function isFavoriteChannel(channelId: string): boolean {
  return favoriteChannelIds.has(String(channelId || ""));
}

export function setChannelFavorite(channelId: string, isFavorite: boolean) {
  const id = String(channelId || "").trim();
  if (!id) return;

  if (isFavorite) {
    favoriteChannelIds.add(id);
  } else {
    favoriteChannelIds.delete(id);
  }

  saveFavoriteChannelIds();
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
}

export function setActiveGroup(group: string) {
  activeGroup = group;
}

export function getActiveGroup(): string {
  return activeGroup;
}
