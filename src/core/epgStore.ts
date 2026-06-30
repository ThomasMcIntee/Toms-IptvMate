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
const KEY = "iptvmate_epg_cache";

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
      bestScore = score;
      bestEvents = events;
    }
  }

  return bestEvents;
}

function hasAnyEvents(epg: Record<string, EPGEvent[]>): boolean {
  return Object.values(epg).some((events) => Array.isArray(events) && events.length > 0);
}

export function setEPG(channelId: string, events: EPGEvent[]) {
  epgData[channelId] = events;
}

export function getEPG(channelId: string): EPGEvent[] {
  if (!channelId) return [];

  const tryKeys = buildLookupKeys(channelId);

  for (const key of tryKeys) {
    const events = epgData[key];
    if (Array.isArray(events) && events.length > 0) {
      return events;
    }
  }

  return [];
}

export function getEPGForChannel(channel: { id?: string; name?: string } | null | undefined): EPGEvent[] {
  if (!channel) return [];

  const candidateValues = [String(channel.id || ""), String(channel.name || "")];
  for (const value of candidateValues) {
    for (const key of buildLookupKeys(value)) {
      const events = epgData[key];
      if (Array.isArray(events) && events.length > 0) {
        return events;
      }
    }
  }

  const fuzzyEvents = findFuzzyEventsByName(String(channel.name || ""));
  if (fuzzyEvents.length > 0) {
    return fuzzyEvents;
  }

  return [];
}

export function clearEPG() {
  epgData = {};
}

export function saveEPGCache(playlistId: string) {
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

  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Ignore persistence errors.
  }
}

export function loadEPGCache(playlistId: string): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;

    const cache: CachedEPG = JSON.parse(raw);

    // Wrong playlist → ignore cache
    if (cache.playlistId !== playlistId) return false;

    // Cache older than 6 hours → ignore
    const age = Date.now() - cache.timestamp;
    if (age > 6 * 60 * 60 * 1000) return false;

    if (!cache.epg || typeof cache.epg !== "object" || !hasAnyEvents(cache.epg)) {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // Ignore persistence errors.
      }
      return false;
    }

    epgData = cache.epg;
    return true;
  } catch {
    return false;
  }
}
