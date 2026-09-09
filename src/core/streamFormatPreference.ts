/**
 * Sticky last-good stream container (mp4 / m3u8 / ts / mkv / …).
 * Next tune tries that format first; if a different one starts, it becomes last-good.
 */

const STORAGE_KEY = "iptvmate_stream_format_pref";
const MAX_STREAM_ENTRIES = 400;
const XTREAM_MEDIA_RE =
  /^(https?:\/\/[^/]+)\/(live|movie|series)\/[^/]+\/[^/]+\/(\d+)(?:\.([a-z0-9]+))?(?:[?#]|$)/i;
const EXTENSION_RE = /\.([a-z0-9]+)(?:[?#]|$)/i;

export const KNOWN_STREAM_FORMATS = ["mp4", "m3u8", "ts", "mkv", "avi", "wmv", "mov"] as const;

type FormatMemory = {
  streams: Record<string, { format: string; at: number }>;
  hosts: Record<string, { format: string; at: number }>;
};

let memory: FormatMemory | null = null;

function emptyMemory(): FormatMemory {
  return { streams: {}, hosts: {} };
}

function loadMemory(): FormatMemory {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memory = emptyMemory();
      return memory;
    }
    const parsed = JSON.parse(raw) as Partial<FormatMemory>;
    memory = {
      streams: parsed.streams && typeof parsed.streams === "object" ? parsed.streams : {},
      hosts: parsed.hosts && typeof parsed.hosts === "object" ? parsed.hosts : {}
    };
    return memory;
  } catch {
    memory = emptyMemory();
    return memory;
  }
}

function persistMemory(): void {
  if (!memory) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Quota or private-mode — keep the in-memory map for this session.
  }
}

function pruneOldest(entries: Record<string, { format: string; at: number }>, max: number): void {
  const keys = Object.keys(entries);
  if (keys.length <= max) return;
  keys
    .sort((a, b) => (entries[a]?.at || 0) - (entries[b]?.at || 0))
    .slice(0, keys.length - max)
    .forEach((key) => {
      delete entries[key];
    });
}

function unwrapPlaybackUrl(url: string): string {
  let current = String(url || "").trim();
  for (let i = 0; i < 4; i += 1) {
    try {
      if (current.includes("/corsproxy.io/?")) {
        const idx = current.indexOf("?");
        if (idx >= 0) {
          current = decodeURIComponent(current.slice(idx + 1));
          continue;
        }
      }
      const parsed = new URL(current, typeof window !== "undefined" ? window.location.href : "http://localhost");
      const wrapped = parsed.searchParams.get("url");
      if (wrapped && (current.includes("/__stream") || current.includes("/__transcode") || current.includes("/__playlist"))) {
        current = wrapped;
        continue;
      }
    } catch {
      break;
    }
    break;
  }
  return current;
}

function parseXtreamMedia(url: string): { origin: string; kind: string; id: string; format: string } | null {
  const match = unwrapPlaybackUrl(url).match(XTREAM_MEDIA_RE);
  if (!match) return null;
  return {
    origin: match[1].toLowerCase(),
    kind: match[2].toLowerCase(),
    id: match[3],
    format: String(match[4] || "").toLowerCase()
  };
}

function streamKeyFromXtream(parsed: { origin: string; kind: string; id: string }): string {
  return `${parsed.origin}|${parsed.kind}|${parsed.id}`;
}

function hostKeyFromXtream(parsed: { origin: string; kind: string }): string {
  return `${parsed.origin}|${parsed.kind}`;
}

export function extractStreamFormat(url: string): string | null {
  const xtream = parseXtreamMedia(url);
  if (xtream?.format) return xtream.format;
  const match = unwrapPlaybackUrl(url).match(EXTENSION_RE);
  const ext = match?.[1]?.toLowerCase() || "";
  return ext && KNOWN_STREAM_FORMATS.includes(ext as (typeof KNOWN_STREAM_FORMATS)[number]) ? ext : null;
}

export function getPreferredStreamFormat(
  url: string,
  options?: { hostFallback?: boolean }
): string | null {
  const xtream = parseXtreamMedia(url);
  if (!xtream) return null;
  const store = loadMemory();
  const stream = store.streams[streamKeyFromXtream(xtream)];
  if (stream?.format) return stream.format;
  if (options?.hostFallback === false) return null;
  const host = store.hosts[hostKeyFromXtream(xtream)];
  return host?.format || null;
}

export function orderFormatsByLastGood(
  formats: string[],
  url: string,
  options?: { hostFallback?: boolean }
): string[] {
  const preferred = getPreferredStreamFormat(url, options);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ext of [preferred, ...formats]) {
    const normalized = String(ext || "").toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function rewriteStreamFormat(url: string, format: string): string {
  const xtream = parseXtreamMedia(url);
  if (!xtream) return url;
  const raw = unwrapPlaybackUrl(url);
  const queryIndex = raw.search(/[?#]/);
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : "";
  const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const nextPath = xtream.format
    ? path.replace(/\.[a-z0-9]+$/i, `.${format}`)
    : `${path}.${format}`;
  return `${nextPath}${query}`;
}

export function applyPreferredStreamFormat(url: string, allowed?: string[]): string {
  const preferred = getPreferredStreamFormat(url);
  if (!preferred) return url;
  if (allowed && !allowed.includes(preferred)) return url;
  const current = extractStreamFormat(url);
  if (current === preferred) return url;
  return rewriteStreamFormat(url, preferred);
}

export function rememberWorkingStreamFormat(url: string): void {
  const xtream = parseXtreamMedia(url);
  const format = xtream?.format || extractStreamFormat(url);
  if (!xtream || !format) return;

  const store = loadMemory();
  const at = Date.now();
  store.streams[streamKeyFromXtream(xtream)] = { format, at };
  store.hosts[hostKeyFromXtream(xtream)] = { format, at };
  pruneOldest(store.streams, MAX_STREAM_ENTRIES);
  persistMemory();
}

/** Drop a container that 404/551'd so the next title is not forced onto it. */
export function forgetWorkingStreamFormat(url: string): void {
  const xtream = parseXtreamMedia(url);
  const format = xtream?.format || extractStreamFormat(url);
  if (!xtream) return;

  const store = loadMemory();
  delete store.streams[streamKeyFromXtream(xtream)];
  const hostKey = hostKeyFromXtream(xtream);
  if (format && store.hosts[hostKey]?.format === format) {
    delete store.hosts[hostKey];
  }
  persistMemory();
}
