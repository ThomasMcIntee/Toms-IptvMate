import { Channel, ContentType } from "../channelStore";

export async function loadXtream(url: string, user: string, pass: string): Promise<Channel[]> {
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

  // Load Live TV (most important)
  try {
    const liveChannels = await loadLiveStreams(baseUrl, user, pass, useProxy);
    result.push(...liveChannels);
  } catch (err) {
    console.warn("Failed to load live streams:", err instanceof Error ? err.message : err);
  }

  // Load Movies (VOD) - optional, may be large
  try {
    const movies = await loadVODStreams(baseUrl, user, pass, useProxy);
    result.push(...movies);
  } catch (err) {
    console.warn("Failed to load movies:", err instanceof Error ? err.message : err);
  }

  // Load Series - optional
  try {
    const series = await loadSeriesStreams(baseUrl, user, pass, useProxy);
    result.push(...series);
  } catch (err) {
    console.warn("Failed to load series:", err instanceof Error ? err.message : err);
  }

  if (result.length === 0) {
    throw new Error("Xtream returned no content (live, movies, or series).");
  }

  return result;
}

async function loadLiveStreams(baseUrl: string, user: string, pass: string, useProxy: boolean): Promise<Channel[]> {
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
  const MAX_LIVE_PER_LOAD = 50000;
  if (filtered.length > MAX_LIVE_PER_LOAD) {
    console.log(`Loading first ${MAX_LIVE_PER_LOAD} of ${filtered.length} live channels. ${filtered.length - MAX_LIVE_PER_LOAD} more available.`);
  }

  return filtered
    .slice(0, MAX_LIVE_PER_LOAD)
    .map((item: any) => {
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
        logo: item.stream_icon,
        url: `${baseUrl}/live/${user}/${pass}/${item.stream_id}.${liveExtension}`,
        group: `TV: ${group}`,
        contentType: "live" as ContentType
      };
    });
}

async function loadVODStreams(baseUrl: string, user: string, pass: string, useProxy: boolean): Promise<Channel[]> {
  // Fetch VOD categories
  let vodCategoryMap: Record<string, string> = {};
  try {
    const catApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_vod_categories`;
    const catUrl = useProxy ? toCorsProxyUrl(catApi) : catApi;
    const catRes = await fetch(catUrl);
    if (catRes.ok) {
      const catData = await catRes.json();
      console.log("VOD Categories API response:", { isArray: Array.isArray(catData), count: Array.isArray(catData) ? catData.length : 0 });
      if (Array.isArray(catData)) {
        vodCategoryMap = Object.fromEntries(
          catData.map((c: any) => [c.category_id.toString(), c.category_name || `Category ${c.category_id}`])
        );
        console.log("VOD Category Map built:", Object.keys(vodCategoryMap).length, "categories");
      }
    } else {
      console.warn(`VOD Categories API returned status ${catRes.status}`);
    }
  } catch (err) {
    console.warn("VOD Categories fetch error:", err instanceof Error ? err.message : err);
    // Categories not available
  }

  let vodStreams = [];
  try {
    const vodApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_vod_streams`;
    const vodUrl = useProxy ? toCorsProxyUrl(vodApi) : vodApi;
    console.log("Fetching VOD from:", vodUrl.substring(0, 100) + "...");
    const vodRes = await fetch(vodUrl);
    if (vodRes.ok) {
      const vodData = await vodRes.json();
      console.log("VOD Streams API raw response:", { 
        isArray: Array.isArray(vodData), 
        isObject: vodData && typeof vodData === "object",
        type: typeof vodData,
        keys: vodData && typeof vodData === "object" ? Object.keys(vodData) : []
      });
      if (Array.isArray(vodData)) {
        vodStreams = vodData;
      } else if (vodData && typeof vodData === "object") {
        // Try common response patterns: {"result": []}, {"data": []}, etc.
        vodStreams = vodData.result || vodData.data || vodData.vod || [];
        console.log("Extracted VOD array from object property, count:", vodStreams.length);
      }
      console.log("Total VOD streams before filtering:", vodStreams.length);
    } else {
      console.warn(`VOD Streams API returned status ${vodRes.status}`);
    }
  } catch (err) {
    // VOD streams not available
    console.warn("VOD fetch error:", err instanceof Error ? err.message : err);
  }

  const filtered = vodStreams.filter((item: any) => item.stream_id != null);
  console.log("VOD streams after filter (stream_id != null):", filtered.length);

  // Paginate: load only first 10000 to prevent stack overflow
  const MAX_MOVIES_PER_LOAD = 50000;
  const remaining = filtered.length - MAX_MOVIES_PER_LOAD;
  if (remaining > 0) {
    console.log(`Loading first ${MAX_MOVIES_PER_LOAD} of ${filtered.length} movies. ${remaining} more available.`);
  }

  return filtered
    .slice(0, MAX_MOVIES_PER_LOAD)
    .map((item: any) => {
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
        logo: item.stream_icon,
        url: `${baseUrl}/movie/${user}/${pass}/${item.stream_id}.${vodExtension}`,
        group: `Movies: ${group}`,
        contentType: "movie" as ContentType
      };
    });
}

async function loadSeriesStreams(baseUrl: string, user: string, pass: string, useProxy: boolean): Promise<Channel[]> {
  // Fetch series categories
  let seriesCategoryMap: Record<string, string> = {};
  try {
    const catApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series_categories`;
    const catUrl = useProxy ? toCorsProxyUrl(catApi) : catApi;
    const catRes = await fetch(catUrl);
    if (catRes.ok) {
      const catData = await catRes.json();
      if (Array.isArray(catData)) {
        seriesCategoryMap = Object.fromEntries(
          catData.map((c: any) => [c.category_id.toString(), c.category_name || `Category ${c.category_id}`])
        );
      }
    }
  } catch {
    // Categories not available
  }

  let seriesStreams = [];
  try {
    const seriesApi = `${baseUrl}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_series`;
    const seriesUrl = useProxy ? toCorsProxyUrl(seriesApi) : seriesApi;
    const seriesRes = await fetch(seriesUrl);
    if (seriesRes.ok) {
      const seriesData = await seriesRes.json();
      seriesStreams = Array.isArray(seriesData) ? seriesData : [];
    }
  } catch {
    // Series not available
  }

  const result: Channel[] = [];
  
  // Paginate: load only first 5000 series to prevent stack overflow
  const MAX_SERIES_PER_LOAD = 20000;
  const seriesLimit = Math.min(seriesStreams.length, MAX_SERIES_PER_LOAD);
  if (seriesStreams.length > MAX_SERIES_PER_LOAD) {
    console.log(`Loading first ${MAX_SERIES_PER_LOAD} of ${seriesStreams.length} series. ${seriesStreams.length - MAX_SERIES_PER_LOAD} more available.`);
  }

  // Create one entry per series
  for (let i = 0; i < seriesLimit; i++) {
    const series = seriesStreams[i];
    if (!series.series_id) continue;

    let group = "Series";
    if (series.category_name && series.category_name.trim()) {
      group = series.category_name.trim();
    } else if (series.category_id && seriesCategoryMap[series.category_id.toString()]) {
      group = seriesCategoryMap[series.category_id.toString()];
    } else if (series.category_id) {
      group = series.category_id.toString();
    }

    result.push({
      id: `series_${series.series_id}`,
      name: series.name || `Series ${series.series_id}`,
      logo: series.cover,
      url: `${baseUrl}/series/${user}/${pass}/${series.series_id}.m3u8`,
      group: `Series: ${group}`,
      contentType: "series" as ContentType
    });
  }

  return result;
}

function getBaseCandidates(url: string): string[] {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Xtream server URL is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return [trimmed];
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
