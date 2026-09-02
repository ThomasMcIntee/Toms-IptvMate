import {
  appendCapacitorLiveGroup,
  appendCapacitorVodGroup,
  beginCapacitorLiveCatalogIngest,
  beginCapacitorVodCatalogIngest,
  finishCapacitorLiveCatalogIngest,
  finishCapacitorVodCatalogIngest,
  Channel,
  ContentType,
  type CapacitorVodCacheScope
} from "../channelStore";
import { isCapacitorRuntime } from "../player/platformDetection";
import type { PlaylistLoadScope } from "./playlistLoader";

const CAPACITOR_PERSIST_GROUP_CAP = 8000;
export type XtreamLoadProgress = (status: string) => void;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, isCapacitorRuntime() ? 50 : 0));
}

type XtreamSeriesEpisodeRaw = {
  id?: number | string;
  stream_id?: number | string;
  title?: string;
  name?: string;
  container_extension?: string;
  episode_num?: number | string;
  episode?: number | string;
  movie_image?: string;
  cover_big?: string;
  stream_icon?: string;
  info?: unknown;
};

function extractXtreamCollection(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const obj = payload as Record<string, unknown>;
  const wrapped = [obj.result, obj.data, obj.vod, obj.series, obj.items, obj.channels, obj.js];
  for (const candidate of wrapped) {
    const extracted = extractXtreamCollection(candidate);
    if (extracted.length > 0) return extracted;
  }

  const values = Object.values(obj);
  if (values.length > 0 && values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
    return values as any[];
  }

  if (values.length > 0 && values.every((_, index) => String(index) in obj)) {
    return values as any[];
  }

  return [];
}

export async function loadXtream(
  url: string,
  user: string,
  pass: string,
  scope: PlaylistLoadScope = "all",
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  const { baseUrl, apiUrl, useProxy } = await resolveReachableBaseUrl(url, user, pass);
  const baseApiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

  const res = await fetch(apiUrl || baseApiUrl);
  if (!res.ok) {
    throw new Error(`Xtream request failed (${res.status})`);
  }

  const data = await res.json();

  if (data?.user_info?.auth === 0) {
    throw new Error("Xtream credentials are invalid.");
  }

  const result: Channel[] = [];
  const scopeErrors: string[] = [];

  if (scope === "all" || scope === "live") {
    try {
      const liveChannels = await loadLiveStreams(baseUrl, user, pass, useProxy, onProgress);
      for (const channel of liveChannels) {
        result.push(channel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "Unknown error");
      scopeErrors.push(`live: ${message}`);
      console.warn("Failed to load live streams:", message);
    }
  }

  if (scope === "all" || scope === "movies") {
    try {
      const movies = await loadVODStreams(baseUrl, user, pass, useProxy, onProgress);
      for (const channel of movies) {
        result.push(channel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "Unknown error");
      scopeErrors.push(`movies: ${message}`);
      console.warn("Failed to load movies:", message);
    }
  }

  if (scope === "all" || scope === "series") {
    try {
      const series = await loadSeriesStreams(baseUrl, user, pass, useProxy, onProgress);
      for (const channel of series) {
        result.push(channel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "Unknown error");
      scopeErrors.push(`series: ${message}`);
      console.warn("Failed to load series:", message);
    }
  }

  if (result.length === 0) {
    if (scopeErrors.length > 0) {
      throw new Error(`Xtream ${scope} load failed. ${scopeErrors.join(" | ")}`);
    }
    throw new Error("Xtream returned no content (live, movies, or series).");
  }

  return result;
}

async function loadLiveStreams(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  if (isCapacitorRuntime()) {
    return loadAndPersistLiveByCategory(baseUrl, user, pass, useProxy, onProgress);
  }

  // Fetch live categories
  let categoryMap: Record<string, string> = {};
  try {
    const catApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_categories`;
    const catUrl = useProxy ? toCorsProxyUrl(catApi) : catApi;
    const catRes = await fetch(catUrl);
    if (catRes.ok) {
      const catData = await catRes.json();
      if (Array.isArray(catData)) {
        categoryMap = Object.fromEntries(
          catData.map((c: any) => [c.category_id.toString(), c.category_name || `Category ${c.category_id}`])
        );
      }
    }
  } catch {
    // Categories not available, will use fallback
  }

  let liveStreams = [];
  try {
    const liveApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`;
    const liveUrl = useProxy ? toCorsProxyUrl(liveApi) : liveApi;
    const liveRes = await fetch(liveUrl);
    if (liveRes.ok) {
      const liveData = await liveRes.json();
      liveStreams = Array.isArray(liveData) ? liveData : [];
    }
  } catch {
    // Live streams not available
  }

  const filtered = liveStreams.filter((item: any) => item.stream_id != null);

  return filtered
    .map((item: any) => mapLiveStream(item, categoryMap, baseUrl, user, pass))
    .filter((channel): channel is Channel => !!channel);
}

function mapLiveStream(
  item: any,
  categoryMap: Record<string, string>,
  baseUrl: string,
  user: string,
  pass: string
): Channel | null {
  if (item?.stream_id == null) return null;
  let group = "Uncategorized";
  const liveExtension = String(item.container_extension || "ts").trim() || "ts";

  if (item.category_name && item.category_name.trim()) {
    group = item.category_name.trim();
  } else if (item.category_id && categoryMap[item.category_id.toString()]) {
    group = categoryMap[item.category_id.toString()];
  } else if (item.category_id) {
    group = item.category_id.toString();
  }

  return {
    id: `live_${item.stream_id}`,
    name: item.name || `Stream ${item.stream_id}`,
    logo: isCapacitorRuntime() ? undefined : item.stream_icon,
    url: `${baseUrl}/live/${user}/${pass}/${item.stream_id}.${liveExtension}`,
    group: `TV: ${group}`,
    contentType: "live" as ContentType,
    epgChannelId: String(item.epg_channel_id || "").trim() || undefined
  };
}

async function loadAndPersistLiveByCategory(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  const categoryItems = await fetchXtreamList(baseUrl, user, pass, useProxy, "get_live_categories");
  const categoryMap = categoryNameMap(categoryItems);
  await beginCapacitorLiveCatalogIngest();
  onProgress?.(`Loading live TV: ${categoryItems.length} categories…`);

  let index = 0;
  for (const category of categoryItems) {
    if (category?.category_id == null) continue;
    index += 1;
    const label = String(category.category_name || `Category ${category.category_id}`);
    if (!isCapacitorRuntime()) {
      onProgress?.(`Loading live TV ${index}/${categoryItems.length}: ${label}`);
    }
    try {
      const batch = await fetchXtreamList(
        baseUrl,
        user,
        pass,
        useProxy,
        "get_live_streams",
        `&category_id=${encodeURIComponent(String(category.category_id))}`
      );
      const mapped: Channel[] = [];
      for (let i = 0; i < batch.length && mapped.length < CAPACITOR_PERSIST_GROUP_CAP; i += 1) {
        const item = batch[i];
        batch[i] = null;
        if (item && item.category_id == null) item.category_id = category.category_id;
        if (item && !item.category_name && category.category_name) {
          item.category_name = category.category_name;
        }
        const channel = mapLiveStream(item, categoryMap, baseUrl, user, pass);
        if (channel) mapped.push(channel);
      }
      batch.length = 0;
      if (mapped.length === 0) continue;
      await appendCapacitorLiveGroup(String(mapped[0].group || "Uncategorized"), mapped);
      mapped.length = 0;
    } catch (err) {
      console.warn(`[xtream] skipped live category ${label}:`, err);
    }
    await yieldToMain();
  }

  finishCapacitorLiveCatalogIngest();
  return [];
}

async function fetchXtreamList(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  action: string,
  extraQuery = ""
): Promise<any[]> {
  try {
    const api = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=${action}${extraQuery}`;
    const data = await fetchJsonWithModeFallback(api, useProxy);
    return extractXtreamCollection(data);
  } catch (err) {
    console.warn(`[xtream] ${action}${extraQuery} failed:`, err);
    return [];
  }
}

function categoryNameMap(categoryItems: any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const category of categoryItems) {
    if (category?.category_id == null) continue;
    map[String(category.category_id)] = String(category.category_name || `Category ${category.category_id}`);
  }
  return map;
}

async function loadCappedStreamsByCategory(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  categoriesAction: string,
  streamsAction: string
): Promise<{ categoryMap: Record<string, string>; streams: any[] }> {
  const categoryItems = await fetchXtreamList(baseUrl, user, pass, useProxy, categoriesAction);
  const categoryMap = categoryNameMap(categoryItems);

  let streams = await fetchXtreamList(baseUrl, user, pass, useProxy, streamsAction);
  if (!Array.isArray(streams) || streams.length === 0) {
    streams = [];
    for (const category of categoryItems) {
      if (category?.category_id == null) continue;
      const batch = await fetchXtreamList(
        baseUrl,
        user,
        pass,
        useProxy,
        streamsAction,
        `&category_id=${encodeURIComponent(String(category.category_id))}`
      );
      for (const item of batch) streams.push(item);
      await yieldToMain();
    }
    return { categoryMap, streams };
  }

  const seenCategoryIds = new Set(
    streams.map((item) => String(item?.category_id ?? "")).filter((id) => id.length > 0)
  );
  for (const category of categoryItems) {
    const id = String(category?.category_id ?? "");
    if (!id || seenCategoryIds.has(id)) continue;
    const batch = await fetchXtreamList(
      baseUrl,
      user,
      pass,
      useProxy,
      streamsAction,
      `&category_id=${encodeURIComponent(id)}`
    );
    for (const item of batch) streams.push(item);
    seenCategoryIds.add(id);
    await yieldToMain();
  }

  return { categoryMap, streams };
}

function mapVodStream(
  item: any,
  vodCategoryMap: Record<string, string>,
  baseUrl: string,
  user: string,
  pass: string
): Channel | null {
  if (item?.stream_id == null) return null;
  let group = "Movies";
  const vodExtension = String(item.container_extension || "mp4").trim() || "mp4";
  if (item.category_name && item.category_name.trim()) {
    group = item.category_name.trim();
  } else if (item.category_id && vodCategoryMap[item.category_id.toString()]) {
    group = vodCategoryMap[item.category_id.toString()];
  } else if (item.category_id) {
    group = item.category_id.toString();
  }
  return {
    id: `movie_${item.stream_id}`,
    name: item.name || `Movie ${item.stream_id}`,
    logo: String(item.stream_icon || item.cover || "").trim() || undefined,
    url: `${baseUrl}/movie/${user}/${pass}/${item.stream_id}.${vodExtension}`,
    group: `Movies: ${group}`,
    contentType: "movie" as ContentType
  };
}

function mapSeriesEntry(
  series: any,
  seriesCategoryMap: Record<string, string>,
  baseUrl: string,
  user: string,
  pass: string
): Channel | null {
  if (!series?.series_id) return null;
  let group = "Series";
  if (series.category_name && series.category_name.trim()) {
    group = series.category_name.trim();
  } else if (series.category_id && seriesCategoryMap[series.category_id.toString()]) {
    group = seriesCategoryMap[series.category_id.toString()];
  } else if (series.category_id) {
    group = series.category_id.toString();
  }
  return {
    id: `series_${series.series_id}`,
    name: series.name || `Series ${series.series_id}`,
    logo: String(series.cover || series.stream_icon || "").trim() || undefined,
    url: `${baseUrl}/series/${user}/${pass}/${series.series_id}.m3u8`,
    group: `Series: ${group}`,
    contentType: "series" as ContentType
  };
}

async function loadAndPersistVodByCategory(
  scope: CapacitorVodCacheScope,
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  categoriesAction: string,
  streamsAction: string,
  mapItem: (
    item: any,
    categoryMap: Record<string, string>,
    baseUrl: string,
    user: string,
    pass: string
  ) => Channel | null,
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  const categoryItems = await fetchXtreamList(baseUrl, user, pass, useProxy, categoriesAction);
  const categoryMap = categoryNameMap(categoryItems);
  await beginCapacitorVodCatalogIngest(scope);
  const scopeLabel = scope === "movies" ? "movies" : "series";
  onProgress?.(`Loading ${scopeLabel}: ${categoryItems.length} categories…`);

  let index = 0;
  for (const category of categoryItems) {
    if (category?.category_id == null) continue;
    index += 1;
    const label = String(category.category_name || `Category ${category.category_id}`);
    if (!isCapacitorRuntime()) {
      onProgress?.(`Loading ${scopeLabel} ${index}/${categoryItems.length}: ${label}`);
    }
    try {
      const batch = await fetchXtreamList(
        baseUrl,
        user,
        pass,
        useProxy,
        streamsAction,
        `&category_id=${encodeURIComponent(String(category.category_id))}`
      );
      const mapped: Channel[] = [];
      for (let i = 0; i < batch.length && mapped.length < CAPACITOR_PERSIST_GROUP_CAP; i += 1) {
        const item = batch[i];
        batch[i] = null;
        if (item && item.category_id == null) item.category_id = category.category_id;
        if (item && !item.category_name && category.category_name) {
          item.category_name = category.category_name;
        }
        const channel = mapItem(item, categoryMap, baseUrl, user, pass);
        if (channel) mapped.push(channel);
      }
      batch.length = 0;
      if (mapped.length === 0) continue;
      await appendCapacitorVodGroup(scope, String(mapped[0].group || "Uncategorized"), mapped);
      mapped.length = 0;
    } catch (err) {
      console.warn(`[xtream] skipped ${scopeLabel} category ${label}:`, err);
    }
    await yieldToMain();
  }

  finishCapacitorVodCatalogIngest(scope);
  return [];
}

async function loadVODStreams(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  if (isCapacitorRuntime()) {
    return loadAndPersistVodByCategory(
      "movies",
      baseUrl,
      user,
      pass,
      useProxy,
      "get_vod_categories",
      "get_vod_streams",
      mapVodStream,
      onProgress
    );
  }

  const { categoryMap: vodCategoryMap, streams: vodStreams } = await loadCappedStreamsByCategory(
    baseUrl,
    user,
    pass,
    useProxy,
    "get_vod_categories",
    "get_vod_streams"
  );

  const mapped: Channel[] = [];
  for (const item of vodStreams) {
    const channel = mapVodStream(item, vodCategoryMap, baseUrl, user, pass);
    if (channel) mapped.push(channel);
  }
  return mapped;
}

async function loadSeriesStreams(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  onProgress?: XtreamLoadProgress
): Promise<Channel[]> {
  if (isCapacitorRuntime()) {
    return loadAndPersistVodByCategory(
      "series",
      baseUrl,
      user,
      pass,
      useProxy,
      "get_series_categories",
      "get_series",
      mapSeriesEntry,
      onProgress
    );
  }

  const { categoryMap: seriesCategoryMap, streams: seriesStreams } = await loadCappedStreamsByCategory(
    baseUrl,
    user,
    pass,
    useProxy,
    "get_series_categories",
    "get_series"
  );

  const mapped: Channel[] = [];
  for (const series of seriesStreams) {
    const channel = mapSeriesEntry(series, seriesCategoryMap, baseUrl, user, pass);
    if (channel) mapped.push(channel);
  }
  return mapped;
}

function getBaseCandidates(url: string): string[] {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Xtream server URL is empty");
  }

  if (trimmed.startsWith("http://")) {
    const httpsVariant = `https://${trimmed.slice("http://".length)}`;
    return [trimmed, httpsVariant];
  }

  if (trimmed.startsWith("https://")) {
    const httpVariant = `http://${trimmed.slice("https://".length)}`;
    return [trimmed, httpVariant];
  }

  return [`https://${trimmed}`, `http://${trimmed}`];
}

async function resolveReachableBaseUrl(
  url: string,
  user: string,
  pass: string
): Promise<{ baseUrl: string; apiUrl: string; useProxy: boolean }> {
  const candidates = getBaseCandidates(url);
  const reasons: string[] = [];

  for (const baseUrl of candidates) {
    const api = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    try {
      const res = await fetch(api);
      if (res.ok) return { baseUrl, apiUrl: api, useProxy: false };
      reasons.push(`${baseUrl} -> ${res.status}`);

      // Some providers block browser-origin probes with non-2xx statuses; try proxy fallback as well.
      const proxiedApi = toCorsProxyUrl(api);
      try {
        const proxyRes = await fetch(proxiedApi);
        if (proxyRes.ok) return { baseUrl, apiUrl: proxiedApi, useProxy: true };
        reasons.push(`${proxiedApi} -> ${proxyRes.status}`);
      } catch {
        reasons.push(`${proxiedApi} -> proxy network error`);
      }
    } catch {
      reasons.push(`${baseUrl} -> network error`);

      // Browser CORS fallback for Xtream API probe.
      const proxiedApi = toCorsProxyUrl(api);
      try {
        const proxyRes = await fetch(proxiedApi);
        if (proxyRes.ok) return { baseUrl, apiUrl: proxiedApi, useProxy: true };
        reasons.push(`${proxiedApi} -> ${proxyRes.status}`);
      } catch {
        reasons.push(`${proxiedApi} -> proxy network error`);
      }
    }
  }

  throw new Error(`Xtream request failed: ${reasons.join(", ")}. Check URL/credentials or CORS restrictions.`);
}

function toCorsProxyUrl(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

export async function loadXtreamSeriesEpisodesFromChannel(seriesChannel: Channel): Promise<Channel[]> {
  const parsed = parseXtreamSeriesUrl(String(seriesChannel?.url || ""));
  if (!parsed) return [];

  const { baseUrl, user, pass, seriesId } = parsed;
  const apiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`;
  const payload = await fetchJsonWithProxyFallback(apiUrl);
  if (!payload || typeof payload !== "object") return [];

  const episodes = extractEpisodeEntries(payload.episodes);
  if (episodes.length === 0) return [];

  const group = seriesChannel.group || "Series";
  const parentGroup = seriesChannel.group || undefined;
  const fallbackLogo = seriesChannel.logo;
  const titlePrefix = String(seriesChannel.name || "Series").trim();

  const mapped = episodes
    .map((entry) => {
      const streamIdRaw = entry.raw.id ?? entry.raw.stream_id;
      const streamId = Number.parseInt(String(streamIdRaw ?? ""), 10);
      if (!Number.isFinite(streamId) || streamId <= 0) return null;

      const season = entry.season;
      const episodeNumber = coerceNumber(entry.raw.episode_num ?? entry.raw.episode);
      const episodeTitle = String(entry.raw.title || entry.raw.name || "").trim();
      const extension = String(entry.raw.container_extension || "mp4").trim() || "mp4";
      const logo = resolveEpisodeLogo(entry.raw, fallbackLogo);

      const label = formatEpisodeLabel({
        seriesTitle: titlePrefix,
        season,
        episode: episodeNumber,
        title: episodeTitle,
        fallbackId: streamId
      });

      return {
        id: `series_${seriesId}_episode_${streamId}`,
        name: label,
        logo,
        url: `${baseUrl}/series/${user}/${pass}/${streamId}.${extension}`,
        group,
        parentGroup,
        contentType: "series" as ContentType,
        episodeInfo: {
          season,
          episode: episodeNumber,
          title: episodeTitle || undefined
        }
      } satisfies Channel;
    })
    .filter((item): item is Channel => !!item);

  mapped.sort((a, b) => {
    const aSeason = typeof a.episodeInfo?.season === "number" ? a.episodeInfo.season : Number.MAX_SAFE_INTEGER;
    const bSeason = typeof b.episodeInfo?.season === "number" ? b.episodeInfo.season : Number.MAX_SAFE_INTEGER;
    if (aSeason !== bSeason) return aSeason - bSeason;

    const aEpisode = typeof a.episodeInfo?.episode === "number" ? a.episodeInfo.episode : Number.MAX_SAFE_INTEGER;
    const bEpisode = typeof b.episodeInfo?.episode === "number" ? b.episodeInfo.episode : Number.MAX_SAFE_INTEGER;
    if (aEpisode !== bEpisode) return aEpisode - bEpisode;

    return a.name.localeCompare(b.name);
  });

  return mapped;
}

function parseXtreamSeriesUrl(url: string): {
  baseUrl: string;
  user: string;
  pass: string;
  seriesId: string;
} | null {
  const match = url.match(/^(https?:\/\/[^/]+)\/series\/([^/]+)\/([^/]+)\/(\d+)\.[^/?#]+/i);
  if (!match) return null;

  return {
    baseUrl: match[1],
    user: decodeURIComponent(match[2]),
    pass: decodeURIComponent(match[3]),
    seriesId: match[4]
  };
}

async function fetchJsonWithProxyFallback(url: string): Promise<unknown> {
  const direct = await fetch(url).catch(() => null);
  if (direct?.ok) {
    try {
      return await direct.json();
    } catch {
      // Fall through to proxy retry if direct JSON parsing fails.
    }
  }

  const proxied = await fetch(toCorsProxyUrl(url)).catch(() => null);
  if (proxied?.ok) {
    try {
      return await proxied.json();
    } catch {
      return null;
    }
  }

  return null;
}

const CAPACITOR_XTREAM_JSON_MAX_BYTES = 3_500_000;

async function readResponseJsonCapped(response: Response, url: string): Promise<unknown> {
  if (!isCapacitorRuntime()) {
    return response.json();
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > CAPACITOR_XTREAM_JSON_MAX_BYTES) {
    console.warn(`[xtream] skipped oversized JSON (${declaredLength} bytes) ${url}`);
    return null;
  }

  if (declaredLength > 0) {
    return response.json();
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return response.json();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > CAPACITOR_XTREAM_JSON_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        console.warn(`[xtream] aborted oversized JSON stream ${url}`);
        return null;
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  chunks.length = 0;
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchJsonWithModeFallback(url: string, preferProxy: boolean): Promise<unknown> {
  const first = preferProxy ? toCorsProxyUrl(url) : url;
  const second = preferProxy ? url : toCorsProxyUrl(url);

  const firstRes = await fetch(first).catch(() => null);
  if (firstRes?.ok) {
    try {
      const parsed = await readResponseJsonCapped(firstRes, first);
      if (parsed != null) return parsed;
    } catch {
      // Fall through to alternate mode.
    }
  }

  const secondRes = await fetch(second).catch(() => null);
  if (secondRes?.ok) {
    try {
      return await readResponseJsonCapped(secondRes, second);
    } catch {
      return null;
    }
  }

  return null;
}

function extractEpisodeEntries(episodesData: unknown): Array<{ season?: number; raw: XtreamSeriesEpisodeRaw }> {
  if (!episodesData) return [];

  const entries: Array<{ season?: number; raw: XtreamSeriesEpisodeRaw }> = [];

  if (Array.isArray(episodesData)) {
    for (const item of episodesData) {
      if (!item || typeof item !== "object") continue;
      entries.push({ raw: item as XtreamSeriesEpisodeRaw });
    }
    return entries;
  }

  if (typeof episodesData !== "object") return [];

  for (const [seasonKey, seasonEpisodes] of Object.entries(episodesData as Record<string, unknown>)) {
    if (!Array.isArray(seasonEpisodes)) continue;

    const season = coerceNumber(seasonKey);
    for (const episode of seasonEpisodes) {
      if (!episode || typeof episode !== "object") continue;
      entries.push({ season, raw: episode as XtreamSeriesEpisodeRaw });
    }
  }

  return entries;
}

function resolveEpisodeLogo(raw: XtreamSeriesEpisodeRaw, fallbackLogo?: string): string | undefined {
  const nestedInfo = parseEpisodeInfoRecord(raw.info);
  return firstNonEmptyString([
    raw.movie_image,
    raw.cover_big,
    raw.stream_icon,
    nestedInfo?.movie_image,
    nestedInfo?.cover_big,
    nestedInfo?.stream_icon,
    nestedInfo?.cover,
    nestedInfo?.image,
    nestedInfo?.poster,
    fallbackLogo
  ]);
}

function parseEpisodeInfoRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function coerceNumber(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatEpisodeLabel(params: {
  seriesTitle: string;
  season?: number;
  episode?: number;
  title?: string;
  fallbackId: number;
}): string {
  const seasonChunk = typeof params.season === "number" ? `S${String(params.season).padStart(2, "0")}` : "";
  const episodeChunk = typeof params.episode === "number" ? `E${String(params.episode).padStart(2, "0")}` : "";
  const code = `${seasonChunk}${episodeChunk}`.trim();
  const title = (params.title || "").trim();

  if (code && title) return `${code} - ${title}`;
  if (code) return `${params.seriesTitle} ${code}`;
  if (title) return title;
  return `${params.seriesTitle} Episode ${params.fallbackId}`;
}
