import {
  appendCapacitorLiveGroups,
  appendCapacitorVodGroups,
  beginCapacitorLiveCatalogIngest,
  beginCapacitorVodCatalogIngest,
  finishCapacitorLiveCatalogIngest,
  finishCapacitorVodCatalogIngest,
  getCapacitorLiveGroupNames,
  getCapacitorVodGroupNames,
  Channel,
  ContentType,
  type CapacitorVodCacheScope
} from "../channelStore";
import { isCapacitorRuntime, isWebOsRuntime } from "../player/platformDetection";
import type { PlaylistLoadScope } from "./playlistLoader";
import type { PlaylistCatalogTotals } from "../playlistStore";
import { parseXtreamAccountInfo, type XtreamAccountInfo } from "../xtreamAccount";
import { fetchWebOsRemote, fetchWebOsRemoteJson } from "../webosStreamRelay";

const CAPACITOR_PERSIST_GROUP_CAP = 8000;
const CAPACITOR_CATEGORY_CONCURRENCY = 8;
const CAPACITOR_XTREAM_JSON_MAX_BYTES = 3_500_000;
const CAPACITOR_XTREAM_CATALOG_MAX_BYTES = 20_000_000;
export type XtreamLoadProgress = (status: string) => void;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

let capacitorNativeApiPath: "/__api" | "/__stream" | null = null;

function capacitorNativeApiUrls(url: string): string[] {
  if (!isCapacitorRuntime()) return [];
  if (!/^https?:\/\//i.test(url)) return [];
  if (url.includes("/__api") || url.includes("/__stream") || url.includes("corsproxy.io")) {
    return [url];
  }
  const origin =
    window.location.protocol === "http:" || window.location.protocol === "https:"
      ? window.location.origin
      : "http://localhost";
  if (capacitorNativeApiPath) {
    return [`${origin}${capacitorNativeApiPath}?url=${encodeURIComponent(url)}`];
  }
  return [
    `${origin}/__api?url=${encodeURIComponent(url)}`,
    `${origin}/__stream?url=${encodeURIComponent(url)}`
  ];
}

function redactXtreamUrl(url: string): string {
  return String(url || "")
    .replace(/([?&](?:username|password|user|pass)=)[^&]*/gi, "$1***")
    .slice(0, 120);
}

function capacitorIngestHasContent(scope: PlaylistLoadScope): boolean {
  if (!isCapacitorRuntime()) return false;
  const live = getCapacitorLiveGroupNames().length > 0;
  const movies = getCapacitorVodGroupNames("movies").length > 0;
  const series = getCapacitorVodGroupNames("series").length > 0;
  if (scope === "live") return live;
  if (scope === "movies") return movies;
  if (scope === "series") return series;
  return live || movies || series;
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
  const { baseUrl, apiUrl, useProxy, probe } = await resolveReachableBaseUrl(url, user, pass);
  const baseApiUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;

  const data = (probe ?? (await fetchJsonWithModeFallback(apiUrl || baseApiUrl, useProxy))) as {
    user_info?: { auth?: number };
  } | null;
  if (!data) {
    throw new Error("Xtream request failed (empty response)");
  }

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
    // Fire TV persists each category to IndexedDB and returns [] on purpose.
    if (capacitorIngestHasContent(scope)) {
      return [];
    }
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

  onProgress?.("Loading live streams…");
  const categoryMap = categoryNameMap(
    await fetchXtreamList(baseUrl, user, pass, useProxy, "get_live_categories")
  );
  const liveStreams = await fetchXtreamList(baseUrl, user, pass, useProxy, "get_live_streams");
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

function groupMappedChannels(
  streams: any[],
  mapItem: (item: any) => Channel | null
): Map<string, Channel[]> {
  const groups = new Map<string, Channel[]>();
  for (let i = 0; i < streams.length; i += 1) {
    const item = streams[i];
    streams[i] = null;
    const channel = mapItem(item);
    if (!channel) continue;
    const group = String(channel.group || "Uncategorized");
    let list = groups.get(group);
    if (!list) {
      list = [];
      groups.set(group, list);
    }
    if (list.length < CAPACITOR_PERSIST_GROUP_CAP) list.push(channel);
  }
  streams.length = 0;
  return groups;
}

async function persistGroupedChannels(
  groups: Map<string, Channel[]>,
  persistBatch: (batch: Array<{ groupName: string; list: Channel[] }>) => Promise<void>,
  onProgress?: XtreamLoadProgress,
  label = "Saving"
): Promise<number> {
  const entries = Array.from(groups.entries());
  groups.clear();
  let saved = 0;
  for (let index = 0; index < entries.length; index += 16) {
    const slice = entries.slice(index, index + 16);
    const batch: Array<{ groupName: string; list: Channel[] }> = [];
    for (const [group, list] of slice) {
      if (list.length === 0) continue;
      saved += list.length;
      batch.push({ groupName: group, list });
    }
    if (batch.length > 0) {
      await persistBatch(batch);
      for (const item of batch) item.list.length = 0;
    }
    onProgress?.(
      `${label} ${Math.min(index + slice.length, entries.length)}/${entries.length} groups (${saved.toLocaleString()} titles)…`
    );
    await yieldToMain();
  }
  return saved;
}

async function fetchAndMapCategory(
  category: any,
  categoryMap: Record<string, string>,
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  streamsAction: string,
  mapItem: (
    item: any,
    categoryMap: Record<string, string>,
    baseUrl: string,
    user: string,
    pass: string
  ) => Channel | null
): Promise<Channel[]> {
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
  return mapped;
}

async function persistCategoriesInPairs(
  categoryItems: any[],
  categoryMap: Record<string, string>,
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  streamsAction: string,
  mapItem: (
    item: any,
    categoryMap: Record<string, string>,
    baseUrl: string,
    user: string,
    pass: string
  ) => Channel | null,
  persistBatch: (batch: Array<{ groupName: string; list: Channel[] }>) => Promise<void>,
  onProgress?: XtreamLoadProgress,
  label = "Loading"
): Promise<number> {
  const categories = categoryItems.filter((category) => category?.category_id != null);
  let saved = 0;

  for (let index = 0; index < categories.length; index += CAPACITOR_CATEGORY_CONCURRENCY) {
    const slice = categories.slice(index, index + CAPACITOR_CATEGORY_CONCURRENCY);
    const batches = await Promise.all(
      slice.map((category) =>
        fetchAndMapCategory(category, categoryMap, baseUrl, user, pass, useProxy, streamsAction, mapItem).catch(
          (err) => {
            console.warn(`[xtream] skipped ${label} category ${String(category.category_name || category.category_id)}:`, err);
            return [] as Channel[];
          }
        )
      )
    );
    const toSave: Array<{ groupName: string; list: Channel[] }> = [];
    for (const mapped of batches) {
      if (mapped.length === 0) continue;
      saved += mapped.length;
      toSave.push({ groupName: String(mapped[0].group || "Uncategorized"), list: mapped });
    }
    if (toSave.length > 0) {
      await persistBatch(toSave);
      for (const item of toSave) item.list.length = 0;
    }
    onProgress?.(
      `${label} ${Math.min(index + slice.length, categories.length)}/${categories.length} categories (${saved.toLocaleString()} titles)…`
    );
    await yieldToMain();
  }
  return saved;
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
  onProgress?.("Loading live TV catalog…");
  const allStreams = await fetchXtreamList(
    baseUrl,
    user,
    pass,
    useProxy,
    "get_live_streams",
    "",
    CAPACITOR_XTREAM_CATALOG_MAX_BYTES
  );

  if (allStreams.length > 0) {
    await beginCapacitorLiveCatalogIngest();
    onProgress?.(`Saving ${allStreams.length.toLocaleString()} live channels…`);
    const groups = groupMappedChannels(allStreams, (item) =>
      mapLiveStream(item, categoryMap, baseUrl, user, pass)
    );
    await persistGroupedChannels(groups, appendCapacitorLiveGroups, onProgress, "Saving live TV");
    finishCapacitorLiveCatalogIngest();
    return [];
  }

  await beginCapacitorLiveCatalogIngest();
  onProgress?.(`Loading live TV: ${categoryItems.length} categories…`);
  await persistCategoriesInPairs(
    categoryItems,
    categoryMap,
    baseUrl,
    user,
    pass,
    useProxy,
    "get_live_streams",
    mapLiveStream,
    appendCapacitorLiveGroups,
    onProgress,
    "Loading live TV"
  );
  finishCapacitorLiveCatalogIngest();
  return [];
}

async function fetchXtreamList(
  baseUrl: string,
  user: string,
  pass: string,
  useProxy: boolean,
  action: string,
  extraQuery = "",
  maxBytes?: number
): Promise<any[]> {
  try {
    const api = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=${action}${extraQuery}`;
    const data = await fetchJsonWithModeFallback(api, useProxy, maxBytes);
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
  const scopeLabel = scope === "movies" ? "movies" : "series";
  // This panel's full get_vod_streams / get_series dump is too large for the
  // Stick, so we never wait on that failed request. Slimmed per-category
  // fetches with high concurrency complete the whole catalog much faster.
  await beginCapacitorVodCatalogIngest(scope);
  onProgress?.(`Loading ${scopeLabel}: ${categoryItems.length} categories…`);
  await persistCategoriesInPairs(
    categoryItems,
    categoryMap,
    baseUrl,
    user,
    pass,
    useProxy,
    streamsAction,
    mapItem,
    (batch) => appendCapacitorVodGroups(scope, batch),
    onProgress,
    `Loading ${scopeLabel}`
  );
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

type ResolvedXtreamBase = {
  baseUrl: string;
  apiUrl: string;
  useProxy: boolean;
  probe: unknown | null;
};

const resolvedBaseCache = new Map<string, { at: number; value: ResolvedXtreamBase }>();
const RESOLVE_CACHE_MS = 120_000;

function parseProbeJson(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveReachableBaseUrl(
  url: string,
  user: string,
  pass: string
): Promise<ResolvedXtreamBase> {
  const cacheKey = `${url.trim()}|${user}|${pass}`;
  const cached = resolvedBaseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_MS) {
    return cached.value;
  }

  const candidates = getBaseCandidates(url);
  const reasons: string[] = [];

  for (const baseUrl of candidates) {
    const api = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    if (isWebOsRuntime()) {
      const remote = await fetchWebOsRemote(api);
      if (remote) {
        const value: ResolvedXtreamBase = {
          baseUrl,
          apiUrl: api,
          useProxy: false,
          probe: parseProbeJson(remote.text)
        };
        resolvedBaseCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
      reasons.push(`${baseUrl} -> webOS fetch failed`);
      continue;
    }

    if (isCapacitorRuntime()) {
      const nativeProbe = await fetchJsonViaCapacitorNative(api);
      if (nativeProbe != null) {
        const value: ResolvedXtreamBase = { baseUrl, apiUrl: api, useProxy: false, probe: nativeProbe };
        resolvedBaseCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
    }

    try {
      const res = await fetch(api);
      if (res.ok) {
        let probe: unknown = null;
        try {
          probe = await readResponseJsonCapped(res, api);
        } catch {
          probe = null;
        }
        const value: ResolvedXtreamBase = { baseUrl, apiUrl: api, useProxy: false, probe };
        resolvedBaseCache.set(cacheKey, { at: Date.now(), value });
        return value;
      }
      reasons.push(`${baseUrl} -> ${res.status}`);

      // Some providers block browser-origin probes with non-2xx statuses; try proxy fallback as well.
      const proxiedApi = toCorsProxyUrl(api);
      try {
        const proxyRes = await fetch(proxiedApi);
        if (proxyRes.ok) {
          const value: ResolvedXtreamBase = { baseUrl, apiUrl: proxiedApi, useProxy: true, probe: null };
          resolvedBaseCache.set(cacheKey, { at: Date.now(), value });
          return value;
        }
        reasons.push(`${proxiedApi} -> ${proxyRes.status}`);
      } catch {
        reasons.push(`${proxiedApi} -> proxy network error`);
      }
    } catch {
      reasons.push(`${baseUrl} -> network error`);

      // Browser / Fire TV WebView CORS fallback for Xtream API probe.
      const proxiedApi = toCorsProxyUrl(api);
      try {
        const proxyRes = await fetch(proxiedApi);
        if (proxyRes.ok) {
          const value: ResolvedXtreamBase = { baseUrl, apiUrl: proxiedApi, useProxy: true, probe: null };
          resolvedBaseCache.set(cacheKey, { at: Date.now(), value });
          return value;
        }
        reasons.push(`${proxiedApi} -> ${proxyRes.status}`);
      } catch {
        reasons.push(`${proxiedApi} -> proxy network error`);
      }
    }
  }

  throw new Error(`Xtream request failed: ${reasons.join(", ")}. Check URL/credentials or CORS restrictions.`);
}

export async function fetchXtreamAccountInfo(
  url: string,
  user: string,
  pass: string
): Promise<XtreamAccountInfo | null> {
  try {
    const { baseUrl, apiUrl, useProxy, probe } = await resolveReachableBaseUrl(url, user, pass);
    const api = apiUrl || `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
    const data = probe ?? (await fetchJsonWithModeFallback(api, useProxy));
    if (!data || (data as { user_info?: { auth?: number } }).user_info?.auth === 0) {
      return null;
    }
    return parseXtreamAccountInfo(data);
  } catch {
    return null;
  }
}

export async function fetchXtreamCatalogTotals(
  url: string,
  user: string,
  pass: string
): Promise<PlaylistCatalogTotals | null> {
  if (isWebOsRuntime() || isCapacitorRuntime()) {
    // Full stream-list counts OOM or stall TV runtimes. Title totals
    // are written after Playlist Manager Load instead.
    return null;
  }

  try {
    const { baseUrl, useProxy } = await resolveReachableBaseUrl(url, user, pass);
    const liveList = await fetchXtreamList(baseUrl, user, pass, useProxy, "get_live_streams");
    const live = liveList.length;
    liveList.length = 0;
    const movieList = await fetchXtreamList(baseUrl, user, pass, useProxy, "get_vod_streams");
    const movies = movieList.length;
    movieList.length = 0;
    const seriesList = await fetchXtreamList(baseUrl, user, pass, useProxy, "get_series");
    const series = seriesList.length;
    seriesList.length = 0;
    const total = live + movies + series;
    if (total <= 0) return null;
    return { live, movies, series, total };
  } catch {
    return null;
  }
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
  if (isWebOsRuntime()) {
    return fetchWebOsRemoteJson(url);
  }

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

async function readResponseJsonCapped(
  response: Response,
  url: string,
  maxBytes = CAPACITOR_XTREAM_JSON_MAX_BYTES
): Promise<unknown> {
  if (!isCapacitorRuntime()) {
    return response.json();
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > maxBytes) {
    console.warn(`[xtream] skipped oversized JSON (${declaredLength} bytes) ${redactXtreamUrl(url)}`);
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
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        console.warn(`[xtream] aborted oversized JSON stream ${redactXtreamUrl(url)}`);
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

async function fetchJsonViaCapacitorNative(url: string, maxBytes?: number): Promise<unknown | null> {
  for (const nativeUrl of capacitorNativeApiUrls(url)) {
    const res = await fetch(nativeUrl).catch(() => null);
    if (!res?.ok) continue;
    try {
      const parsed = await readResponseJsonCapped(res, url, maxBytes);
      if (parsed != null) {
        if (nativeUrl.includes("/__api?")) capacitorNativeApiPath = "/__api";
        else if (nativeUrl.includes("/__stream?")) capacitorNativeApiPath = "/__stream";
        return parsed;
      }
    } catch {
      // Try the next native endpoint.
    }
  }
  return null;
}

async function fetchJsonWithModeFallback(
  url: string,
  preferProxy: boolean,
  maxBytes?: number
): Promise<unknown> {
  if (isWebOsRuntime()) {
    return fetchWebOsRemoteJson(url);
  }

  if (isCapacitorRuntime()) {
    const native = await fetchJsonViaCapacitorNative(url, maxBytes);
    if (native != null) return native;
  }

  const first = preferProxy ? toCorsProxyUrl(url) : url;
  const second = preferProxy ? url : toCorsProxyUrl(url);

  const firstRes = await fetch(first).catch(() => null);
  if (firstRes?.ok) {
    try {
      const parsed = await readResponseJsonCapped(firstRes, first, maxBytes);
      if (parsed != null) return parsed;
    } catch {
      // Fall through to alternate mode.
    }
  }

  const secondRes = await fetch(second).catch(() => null);
  if (secondRes?.ok) {
    try {
      return await readResponseJsonCapped(secondRes, second, maxBytes);
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
