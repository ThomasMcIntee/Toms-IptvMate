export type EPGEvent = {
  start: number;
  end: number;
  title: string;
  desc?: string;
};

export type CachedEPG = {
  timestamp: number;
  playlistId: string;
  epg: Record<string, EPGEvent[]>;
};

let epgData: Record<string, EPGEvent[]> = {};
let epgVersion = 0;
let epgNotificationPending = false;
const epgListeners = new Set<() => void>();
const epgChannelLookupCache = new Map<string, EPGEvent[]>();
let epgAliasLookupIndex: Map<string, EPGEvent[]> | null = null;
const KEY = "iptvmate_epg_cache";
const EPG_CACHE_DB = "iptvmate_epg_v1";
const EPG_CACHE_STORE = "epg";
const EPG_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const EPG_EVENT_MAX_PAST_AGE_MS = 24 * 60 * 60 * 1000;
let activeCachePlaylistId = "";
let epgSaveTimer: number | null = null;

function notifyEPGChanged() {
  epgChannelLookupCache.clear();
  epgAliasLookupIndex = null;
  if (epgNotificationPending) return;
  epgNotificationPending = true;

  queueMicrotask(() => {
    epgNotificationPending = false;
    epgVersion += 1;
    epgListeners.forEach((listener) => listener());
  });
}

export function subscribeEPG(listener: () => void): () => void {
  epgListeners.add(listener);
  return () => epgListeners.delete(listener);
}

export function getEPGVersion(): number {
  return epgVersion;
}

function normalizeLookupKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "");
}

function buildLookupKeys(value: string): Set<string> {
  const tryKeys = new Set<string>();
  const base = String(value || "").trim();
  if (!base) return tryKeys;

  tryKeys.add(base);
  tryKeys.add(base.toLowerCase());
  tryKeys.add(base.replace(/\s+/g, "").toLowerCase());
  tryKeys.add(normalizeLookupKey(base));

  const prefixedMatch = base.match(/^(live|movie|series|m3u)_(.+)$/i);
  if (prefixedMatch) {
    const suffix = prefixedMatch[2];
    tryKeys.add(suffix);
    tryKeys.add(suffix.toLowerCase());
    tryKeys.add(suffix.replace(/\s+/g, "").toLowerCase());
    tryKeys.add(normalizeLookupKey(suffix));
  }

  const numericTailMatch = base.match(/(\d+)$/);
  if (numericTailMatch) {
    const numeric = numericTailMatch[1];
    tryKeys.add(numeric);
    tryKeys.add(`live_${numeric}`);
    tryKeys.add(`movie_${numeric}`);
    tryKeys.add(`series_${numeric}`);
  }

  return tryKeys;
}

function normalizeChannelNameForFuzzyMatch(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^\)]*\)/g, " ")
    .replace(/\b(hd|fhd|uhd|sd|4k|8k|hevc|x265|h265|backup|vip|test|alt)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAliasLookupKeys(value: string): string[] {
  const normalizedName = normalizeChannelNameForFuzzyMatch(value);
  const candidates = new Set<string>();

  const addCandidate = (candidate: string) => {
    const normalized = normalizeLookupKey(candidate);
    if (normalized.length >= 4) candidates.add(normalized);
  };

  addCandidate(normalizedName);

  const separatorIndex = normalizedName.indexOf(":");
  if (separatorIndex >= 0) {
    addCandidate(normalizedName.slice(separatorIndex + 1));
  }

  return Array.from(candidates);
}

function findFuzzyEventsByName(name: string): EPGEvent[] {
  const normalizedName = normalizeLookupKey(normalizeChannelNameForFuzzyMatch(name));
  if (!normalizedName || normalizedName.length < 4) return [];

  let bestScore = 0;
  let bestEvents: EPGEvent[] = [];

  for (const [key, events] of Object.entries(epgData)) {
    if (!Array.isArray(events) || events.length === 0) continue;

    const normalizedKey = normalizeLookupKey(key);
    if (!normalizedKey || normalizedKey.length < 3) continue;

    let score = 0;
    if (normalizedKey === normalizedName) {
      score = 100;
    } else if (normalizedKey.includes(normalizedName)) {
      score = 80;
    } else if (normalizedName.includes(normalizedKey) && normalizedKey.length >= 5) {
      score = 70;
    }

    if (score > bestScore) {
      const relevantEvents = getRelevantEvents(events);
      if (relevantEvents.length === 0) continue;
      bestScore = score;
      bestEvents = relevantEvents;
    }
  }

  return bestEvents;
}

function getAliasLookupIndex(): Map<string, EPGEvent[]> {
  if (epgAliasLookupIndex) return epgAliasLookupIndex;

  const index = new Map<string, EPGEvent[]>();
  for (const [key, events] of Object.entries(epgData)) {
    if (!Array.isArray(events) || events.length === 0) continue;
    const relevantEvents = getRelevantEvents(events);
    if (relevantEvents.length === 0) continue;

    for (const normalizedKey of buildAliasLookupKeys(key)) {
      if (!index.has(normalizedKey)) index.set(normalizedKey, relevantEvents);
    }
  }

  epgAliasLookupIndex = index;
  return index;
}

function getRelevantEvents(events: EPGEvent[]): EPGEvent[] {
  const oldestUsefulEnd = Date.now() - EPG_EVENT_MAX_PAST_AGE_MS;
  return events.filter((event) => Number(event?.end || 0) >= oldestUsefulEnd);
}

function hasAnyEvents(epg: Record<string, EPGEvent[]>): boolean {
  return Object.values(epg).some((events) => Array.isArray(events) && events.length > 0);
}

function isUsableCache(cache: CachedEPG | null | undefined, playlistId: string): cache is CachedEPG {
  if (!cache || cache.playlistId !== playlistId) return false;
  if (Date.now() - Number(cache.timestamp || 0) > EPG_CACHE_MAX_AGE_MS) return false;
  return !!cache.epg && typeof cache.epg === "object" && hasAnyEvents(cache.epg);
}

async function openEPGCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(EPG_CACHE_DB, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EPG_CACHE_STORE)) {
          db.createObjectStore(EPG_CACHE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeEPGCacheIndexedDb(cache: CachedEPG): Promise<void> {
  const db = await openEPGCacheDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(EPG_CACHE_STORE, "readwrite");
      tx.objectStore(EPG_CACHE_STORE).put(cache, cache.playlistId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

async function readEPGCacheIndexedDb(playlistId: string): Promise<CachedEPG | null> {
  const db = await openEPGCacheDb();
  if (!db) return null;

  const cache = await new Promise<CachedEPG | null>((resolve) => {
    try {
      const tx = db.transaction(EPG_CACHE_STORE, "readonly");
      const request = tx.objectStore(EPG_CACHE_STORE).get(playlistId);
      request.onsuccess = () => resolve((request.result as CachedEPG | undefined) || null);
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  return cache;
}

function scheduleEPGCacheSave() {
  if (!activeCachePlaylistId || typeof window === "undefined") return;
  if (epgSaveTimer !== null) window.clearTimeout(epgSaveTimer);
  epgSaveTimer = window.setTimeout(() => {
    epgSaveTimer = null;
    void saveEPGCache(activeCachePlaylistId);
  }, 2000);
}

export function setEPG(channelId: string, events: EPGEvent[]) {
  epgData[channelId] = events;
  notifyEPGChanged();
  scheduleEPGCacheSave();
}

export function getEPG(channelId: string): EPGEvent[] {
  if (!channelId) return [];

  const tryKeys = buildLookupKeys(channelId);

  for (const key of tryKeys) {
    const events = epgData[key];
    if (Array.isArray(events) && events.length > 0) {
      const relevantEvents = getRelevantEvents(events);
      if (relevantEvents.length > 0) return relevantEvents;
    }
  }

  return [];
}

export function hasStoredEPG(channelId: string): boolean {
  if (!channelId) return false;

  for (const key of buildLookupKeys(channelId)) {
    const events = epgData[key];
    if (Array.isArray(events) && events.length > 0) return true;
  }

  return false;
}

export function hasStoredEPGForChannel(channel: { id?: string; name?: string; epgChannelId?: string } | null | undefined): boolean {
  if (!channel) return false;
  return (
    hasStoredEPG(String(channel.id || "")) ||
    hasStoredEPG(String(channel.epgChannelId || "")) ||
    hasStoredEPG(String(channel.name || ""))
  );
}

export function getStoredEPGForChannel(channel: { id?: string; name?: string; epgChannelId?: string } | null | undefined): EPGEvent[] {
  if (!channel) return [];

  const candidateValues = [
    String(channel.id || ""),
    String(channel.epgChannelId || ""),
    String(channel.name || "")
  ];
  for (const value of candidateValues) {
    for (const key of buildLookupKeys(value)) {
      const events = epgData[key];
      if (Array.isArray(events) && events.length > 0) return events;
    }
  }

  return [];
}

export function getExactEPGForChannel(channel: { id?: string; name?: string; epgChannelId?: string } | null | undefined): EPGEvent[] {
  if (!channel) return [];

  const candidateValues = [
    String(channel.id || ""),
    String(channel.epgChannelId || ""),
    String(channel.name || "")
  ];
  for (const value of candidateValues) {
    for (const key of buildLookupKeys(value)) {
      const events = epgData[key];
      if (!Array.isArray(events) || events.length === 0) continue;

      const relevantEvents = getRelevantEvents(events);
      if (relevantEvents.length > 0) return relevantEvents;
    }
  }

  return [];
}

export function getIndexedEPGForChannel(channel: { id?: string; name?: string; epgChannelId?: string } | null | undefined): EPGEvent[] {
  if (!channel) return [];

  const exactEvents = getExactEPGForChannel(channel);
  if (exactEvents.length > 0) return exactEvents;

  const aliasIndex = getAliasLookupIndex();
  for (const normalizedName of buildAliasLookupKeys(String(channel.name || ""))) {
    const events = aliasIndex.get(normalizedName);
    if (events && events.length > 0) return events;
  }

  return [];
}

export function getEPGForChannel(channel: { id?: string; name?: string; epgChannelId?: string } | null | undefined): EPGEvent[] {
  if (!channel) return [];

  const channelId = String(channel.id || "");
  const channelName = String(channel.name || "");
  const epgChannelId = String(channel.epgChannelId || "");
  const cacheKey = `${channelId}\u0000${epgChannelId}\u0000${channelName}`;
  const cachedEvents = epgChannelLookupCache.get(cacheKey);
  if (cachedEvents) return cachedEvents;

  const indexedEvents = getIndexedEPGForChannel(channel);
  if (indexedEvents.length > 0) {
    epgChannelLookupCache.set(cacheKey, indexedEvents);
    return indexedEvents;
  }

  const fuzzyEvents = findFuzzyEventsByName(channelName);
  if (fuzzyEvents.length > 0) {
    epgChannelLookupCache.set(cacheKey, fuzzyEvents);
    return fuzzyEvents;
  }

  epgChannelLookupCache.set(cacheKey, []);
  return [];
}

export function clearEPG() {
  epgData = {};
  notifyEPGChanged();
}

export async function saveEPGCache(playlistId: string): Promise<void> {
  activeCachePlaylistId = playlistId;
  if (!hasAnyEvents(epgData)) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Ignore persistence errors.
    }
    return;
  }

  const cache: CachedEPG = {
    timestamp: Date.now(),
    playlistId,
    epg: epgData
  };

  await writeEPGCacheIndexedDb(cache);

  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore persistence errors.
  }
}

export async function loadEPGCache(playlistId: string): Promise<boolean> {
  activeCachePlaylistId = playlistId;

  const indexedDbCache = await readEPGCacheIndexedDb(playlistId);
  if (isUsableCache(indexedDbCache, playlistId)) {
    epgData = indexedDbCache.epg;
    notifyEPGChanged();
    return true;
  }

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;

    const cache: CachedEPG = JSON.parse(raw);

    // Wrong playlist → ignore cache
    if (cache.playlistId !== playlistId) return false;

    if (!isUsableCache(cache, playlistId)) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Ignore persistence errors.
      }
      return false;
    }

    epgData = cache.epg;
    notifyEPGChanged();
    void writeEPGCacheIndexedDb(cache);
    return true;
  } catch {
    return false;
  }
}
