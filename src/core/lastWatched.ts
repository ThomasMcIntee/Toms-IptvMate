export const LAST_WATCHED_GROUP = "Last Watched";

const LAST_WATCHED_KEY = "iptvmate_last_watched";
const MAX_ITEMS_PER_MODE = 40;

export type LastWatchedMode = "tv" | "movies" | "series";

export type LastWatchedItem = {
  id: string;
  url: string;
  name: string;
  logo?: string;
  group?: string;
  contentType?: string;
  watchedAt: number;
};

type LastWatchedMap = Record<LastWatchedMode, LastWatchedItem[]>;

function emptyMap(): LastWatchedMap {
  return { tv: [], movies: [], series: [] };
}

function loadMap(): LastWatchedMap {
  try {
    const raw = localStorage.getItem(LAST_WATCHED_KEY);
    if (!raw) return emptyMap();
    const parsed = JSON.parse(raw) as Partial<LastWatchedMap>;
    return {
      tv: Array.isArray(parsed.tv) ? parsed.tv : [],
      movies: Array.isArray(parsed.movies) ? parsed.movies : [],
      series: Array.isArray(parsed.series) ? parsed.series : []
    };
  } catch {
    return emptyMap();
  }
}

function saveMap(map: LastWatchedMap) {
  try {
    localStorage.setItem(LAST_WATCHED_KEY, JSON.stringify(map));
  } catch {
    // Ignore persistence failures.
  }
  window.dispatchEvent(new Event("lastWatchedChanged"));
}

function seriesRootId(channel: any): string | null {
  const id = String(channel?.id || "");
  const direct = id.match(/^series_(\d+)$/i);
  if (direct) return direct[1];
  const episode = id.match(/^series_(\d+)_episode_\d+$/i);
  return episode ? episode[1] : null;
}

function isSeriesEpisode(channel: any): boolean {
  if (String(channel?.contentType || "").toLowerCase() !== "series") return false;
  const id = String(channel?.id || "");
  if (/^series_\d+_episode_\d+$/i.test(id)) return true;
  return !!(channel?.episodeInfo && typeof channel.episodeInfo === "object");
}

function snapshotChannel(channel: any): LastWatchedItem | null {
  const id = String(channel?.id || "").trim();
  const url = String(channel?.url || "").trim();
  if (!id && !url) return null;
  return {
    id,
    url,
    name: String(channel?.name || "Untitled"),
    logo: typeof channel?.logo === "string" ? channel.logo : undefined,
    group: typeof channel?.group === "string" ? channel.group : undefined,
    contentType: typeof channel?.contentType === "string" ? channel.contentType : undefined,
    watchedAt: Date.now()
  };
}

function seriesSnapshot(channel: any, sourceSeries: any): LastWatchedItem | null {
  const source = sourceSeries && typeof sourceSeries === "object" ? sourceSeries : null;
  if (source && !isSeriesEpisode(source)) {
    return snapshotChannel(source);
  }

  const rootId = seriesRootId(channel);
  const base = snapshotChannel(channel);
  if (!base) return null;
  if (!rootId) return base;

  const rewrittenUrl = String(base.url || "").replace(
    /(\/series\/[^/]+\/[^/]+\/)\d+(\.[^/?#]+)/i,
    `$1${rootId}$2`
  );

  return {
    ...base,
    id: `series_${rootId}`,
    url: rewrittenUrl || base.url,
    name: String(source?.name || base.name || "Series"),
    logo: typeof source?.logo === "string" ? source.logo : base.logo,
    contentType: "series"
  };
}

export function recordLastWatched(
  mode: LastWatchedMode,
  channel: any,
  sourceSeries?: any
) {
  const item =
    mode === "series" ? seriesSnapshot(channel, sourceSeries) : snapshotChannel(channel);
  if (!item) return;

  const map = loadMap();
  const next = [
    item,
    ...map[mode].filter((entry) => {
      if (item.id && entry.id) return entry.id !== item.id;
      return entry.url !== item.url;
    })
  ].slice(0, MAX_ITEMS_PER_MODE);

  map[mode] = next;
  saveMap(map);
}

export function getLastWatchedItems(mode: LastWatchedMode): LastWatchedItem[] {
  return loadMap()[mode] || [];
}

export function lastWatchedToChannel(item: LastWatchedItem): any {
  return {
    id: item.id,
    url: item.url,
    name: item.name,
    logo: item.logo,
    group: item.group,
    contentType: item.contentType
  };
}

export function resolveLastWatchedChannels(mode: LastWatchedMode, catalog: any[]): any[] {
  const history = getLastWatchedItems(mode);
  if (history.length === 0) return [];

  const byId = new Map<string, any>();
  const byUrl = new Map<string, any>();
  for (const channel of catalog) {
    const id = String(channel?.id || "").trim();
    const url = String(channel?.url || "").trim();
    if (id && !byId.has(id)) byId.set(id, channel);
    if (url && !byUrl.has(url)) byUrl.set(url, channel);
  }

  return history.map((item) => {
    const live = (item.id && byId.get(item.id)) || (item.url && byUrl.get(item.url));
    return live || lastWatchedToChannel(item);
  });
}
