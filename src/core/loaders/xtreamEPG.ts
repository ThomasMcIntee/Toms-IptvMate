import { EPGEvent } from "../epgStore";
import { parseXMLTV } from "./xmltvParser";

const inFlightEpgChannelIds = new Map<string, Promise<Map<string, string>>>();
const inFlightXmltvLoads = new Map<string, Promise<Record<string, EPGEvent[]>>>();

function toCorsProxyUrl(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function getBaseCandidates(url: string): string[] {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return [trimmed];
  }
  return [`https://${trimmed}`, `http://${trimmed}`];
}

function buildApiCandidates(baseUrl: string, pathAndQuery: string): string[] {
  const bases = getBaseCandidates(baseUrl);
  return bases.map((base) => `${base}${pathAndQuery}`);
}

async function fetchXtreamJson(url: string): Promise<any> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return res.json();
  } catch {
    // Ignore and try proxy fallback.
  }

  const proxied = toCorsProxyUrl(url);
  const proxyRes = await fetch(proxied, { cache: "no-store" });
  if (!proxyRes.ok) {
    throw new Error(`Xtream EPG request failed (${proxyRes.status})`);
  }
  return proxyRes.json();
}

function toEpochMs(value: unknown): number {
  const raw = Number(value);
  if (Number.isFinite(raw) && raw > 0) {
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function decodeMaybeBase64(value: unknown): string {
  const raw = toText(value);
  if (!raw) return "";

  const looksBase64 = /^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length % 4 === 0;
  if (!looksBase64) return raw;

  try {
    const decoded = atob(raw);
    if (decoded && /[\x20-\x7E]/.test(decoded)) {
      return decoded;
    }
  } catch {
    // Fall back to raw text when decode fails.
  }

  return raw;
}

function addEvent(result: Record<string, EPGEvent[]>, streamId: unknown, item: any) {
  const id = String(streamId ?? "").trim();
  if (!id) return;

  const start = toEpochMs(item?.start_timestamp ?? item?.start ?? item?.start_time ?? item?.begin);
  const end = toEpochMs(item?.stop_timestamp ?? item?.end ?? item?.stop_time ?? item?.finish);
  const title = decodeMaybeBase64(item?.title ?? item?.name ?? item?.programme_title ?? "").trim();
  const desc = decodeMaybeBase64(item?.description ?? item?.desc ?? item?.programme_desc ?? "").trim();

  if (!start || !end || !title) return;

  if (!result[id]) result[id] = [];
  result[id].push({ start, end, title, desc });
}

function extractFromListings(result: Record<string, EPGEvent[]>, listings: any[]) {
  listings.forEach((item: any) => {
    const streamId = item?.stream_id ?? item?.channel_id ?? item?.id ?? item?.epg_channel_id;
    addEvent(result, streamId, item);
  });
}

function extractListingsForStream(
  result: Record<string, EPGEvent[]>,
  streamId: string,
  listings: any[]
) {
  listings.forEach((item: any) => addEvent(result, streamId, item));
}

function extractFromObjectCollections(result: Record<string, EPGEvent[]>, data: Record<string, any>) {
  Object.entries(data).forEach(([key, value]) => {
    if (!Array.isArray(value)) return;
    value.forEach((item: any) => {
      const streamId = item?.stream_id ?? item?.channel_id ?? item?.id ?? key;
      addEvent(result, streamId, item);
    });
  });
}

function sortAndDedupe(result: Record<string, EPGEvent[]>) {
  Object.keys(result).forEach((id) => {
    const seen = new Set<string>();
    result[id] = result[id]
      .filter((event) => {
        const key = `${event.start}-${event.end}-${event.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.start - b.start);
  });
}

function hasCurrentOrFutureEvents(events: EPGEvent[]): boolean {
  const now = Date.now();
  return events.some((event) => Number(event?.end || 0) > now);
}

function getPlaylistCacheKey(url: string, user: string, pass: string): string {
  return `${String(url || "").trim()}\u0000${user}\u0000${pass}`;
}

function normalizeXmltvLookupKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export async function loadXtreamEpgChannelIds(
  url: string,
  user: string,
  pass: string
): Promise<Map<string, string>> {
  const cacheKey = getPlaylistCacheKey(url, user, pass);
  const existing = inFlightEpgChannelIds.get(cacheKey);
  if (existing) return existing;

  const load = (async () => {
    const candidates = buildApiCandidates(
      url,
      `/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_live_streams`
    );

    for (const candidate of candidates) {
      const data = await fetchXtreamJson(candidate).catch(() => null);
      if (!Array.isArray(data)) continue;

      const result = new Map<string, string>();
      for (const item of data) {
        const streamId = String(item?.stream_id ?? "").trim();
        const epgChannelId = String(item?.epg_channel_id ?? "").trim();
        if (streamId && epgChannelId) result.set(streamId, epgChannelId);
      }
      return result;
    }

    return new Map<string, string>();
  })();

  inFlightEpgChannelIds.set(cacheKey, load);
  return load;
}

export async function loadXtreamXmltv(
  url: string,
  user: string,
  pass: string
): Promise<Record<string, EPGEvent[]>> {
  const cacheKey = getPlaylistCacheKey(url, user, pass);
  const existing = inFlightXmltvLoads.get(cacheKey);
  if (existing) return existing;

  const load = (async () => {
    const baseUrl = getBaseCandidates(url)[0];
    if (!baseUrl) return {};
    return parseXMLTV(
      `${baseUrl}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`
    );
  })();

  inFlightXmltvLoads.set(cacheKey, load);
  try {
    return await load;
  } catch (error) {
    if (inFlightXmltvLoads.get(cacheKey) === load) {
      inFlightXmltvLoads.delete(cacheKey);
    }
    throw error;
  }
}

function findXmltvEventsById(
  xmltv: Record<string, EPGEvent[]>,
  epgChannelId: string
): EPGEvent[] {
  const candidates = [
    epgChannelId,
    epgChannelId.toLowerCase(),
    epgChannelId.replace(/\s+/g, "").toLowerCase(),
    normalizeXmltvLookupKey(epgChannelId)
  ];

  for (const candidate of candidates) {
    const events = xmltv[candidate];
    if (!Array.isArray(events) || events.length === 0) continue;
    const currentEvents = events.filter((event) => Number(event?.end || 0) > Date.now());
    if (currentEvents.length > 0) return currentEvents.sort((a, b) => a.start - b.start);
  }

  return [];
}

export async function loadXtreamEPG(
  url: string,
  user: string,
  pass: string
): Promise<Record<string, EPGEvent[]>> {
  const apiCandidates = buildApiCandidates(
    url,
    `/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_epg`
  );

  if (apiCandidates.length === 0) {
    return {};
  }

  let data: any = null;
  for (const api of apiCandidates) {
    try {
      data = await fetchXtreamJson(api);
      if (data) break;
    } catch {
      // Try next candidate.
    }
  }

  if (!data) {
    return {};
  }

  const result: Record<string, EPGEvent[]> = {};
  const listings = Array.isArray(data?.epg_listings) ? data.epg_listings : [];
  if (listings.length > 0) {
    extractFromListings(result, listings);
  }

  if (Object.keys(result).length === 0 && Array.isArray(data)) {
    extractFromListings(result, data);
  }

  if (Object.keys(result).length === 0 && data && typeof data === "object") {
    extractFromObjectCollections(result, data as Record<string, any>);
  }

  sortAndDedupe(result);

  return result;
}

export async function loadXtreamEPGForStream(
  url: string,
  user: string,
  pass: string,
  streamId: string,
  limit = 12
): Promise<EPGEvent[]> {
  const sid = String(streamId || "").trim();
  if (!sid) return [];

  const shortCandidates = buildApiCandidates(
    url,
    `/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_short_epg&stream_id=${encodeURIComponent(sid)}&limit=${encodeURIComponent(String(limit))}`
  );

  let shortData: any = null;
  for (const shortApi of shortCandidates) {
    shortData = await fetchXtreamJson(shortApi).catch(() => null);
    if (shortData) break;
  }

  const fromShort: Record<string, EPGEvent[]> = {};
  if (shortData && typeof shortData === "object") {
    if (Array.isArray(shortData?.epg_listings)) {
      extractListingsForStream(fromShort, sid, shortData.epg_listings);
    } else if (Array.isArray(shortData)) {
      extractListingsForStream(fromShort, sid, shortData);
    }
  }

  if (Array.isArray(fromShort[sid]) && hasCurrentOrFutureEvents(fromShort[sid])) {
    return fromShort[sid].sort((a, b) => a.start - b.start);
  }

  const tableCandidates = buildApiCandidates(
    url,
    `/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}&action=get_simple_data_table&stream_id=${encodeURIComponent(sid)}`
  );

  let tableData: any = null;
  for (const tableApi of tableCandidates) {
    tableData = await fetchXtreamJson(tableApi).catch(() => null);
    if (tableData) break;
  }

  const fromTable: Record<string, EPGEvent[]> = {};
  if (tableData && typeof tableData === "object") {
    if (Array.isArray(tableData?.epg_listings)) {
      extractListingsForStream(fromTable, sid, tableData.epg_listings);
    } else if (Array.isArray(tableData)) {
      extractListingsForStream(fromTable, sid, tableData);
    }
  }

  if (Array.isArray(fromTable[sid]) && hasCurrentOrFutureEvents(fromTable[sid])) {
    return fromTable[sid].sort((a, b) => a.start - b.start);
  }

  const epgChannelIds = await loadXtreamEpgChannelIds(url, user, pass).catch(
    () => new Map<string, string>()
  );
  const epgChannelId = epgChannelIds.get(sid) || "";
  if (epgChannelId) {
    const xmltv = await loadXtreamXmltv(url, user, pass).catch(() => ({}));
    const xmltvEvents = findXmltvEventsById(xmltv, epgChannelId);
    if (xmltvEvents.length > 0) return xmltvEvents;
  }

  return [];
}
