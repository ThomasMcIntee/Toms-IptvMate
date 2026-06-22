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

export function setEPG(channelId: string, events: EPGEvent[]) {
  epgData[channelId] = events;
}

export function getEPG(channelId: string): EPGEvent[] {
  return epgData[channelId] || [];
}

export function clearEPG() {
  epgData = {};
}

export function saveEPGCache(playlistId: string) {
  const cache: CachedEPG = {
    timestamp: Date.now(),
    playlistId,
    epg: epgData
  };

  localStorage.setItem(KEY, JSON.stringify(cache));
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

    epgData = cache.epg;
    return true;
  } catch {
    return false;
  }
}
