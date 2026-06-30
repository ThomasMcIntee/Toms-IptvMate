import { Channel, ContentType } from "../channelStore";

function detectContentType(name: string, group: string): ContentType {
  const text = `${group} ${name}`.toLowerCase();
  
  const isMovie = [
    "movie",
    "movies",
    "vod",
    "film",
    "films",
    "cinema",
    "ppv"
  ].some(keyword => text.includes(keyword));
  
  const isSeries = [
    "series",
    "show",
    "shows",
    "season",
    "episode",
    "episodes",
    "serial"
  ].some(keyword => text.includes(keyword));
  
  if (isMovie) return "movie";
  if (isSeries) return "series";
  return "live";
}

function normalizeM3uId(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

export async function loadM3U(url: string): Promise<Channel[]> {
  const { requestUrl, baseUrl } = await resolveReachableUrl(url, "M3U");
  const res = await fetch(requestUrl);
  if (!res.ok) {
    throw new Error(`M3U request failed (${res.status})`);
  }

  const text = await res.text();

  const lines = text.split("\n");
  const channels: Channel[] = [];

  let current: any = {};
  let counter = 0;

  for (let line of lines) {
    line = line.trim();

    if (line.startsWith("#EXTINF")) {
      const nameMatch = line.match(/,(.*)$/);
      const logoMatch = line.match(/tvg-logo="(.*?)"/);
      const tvgIdMatch = line.match(/tvg-id="(.*?)"/i);
      const groupMatch = line.match(/group-title="(.*?)"/);

      const parsedTvgId = tvgIdMatch && tvgIdMatch[1] ? tvgIdMatch[1] : "";
      const normalizedTvgId = parsedTvgId ? normalizeM3uId(parsedTvgId) : "";

      current = {
        id: normalizedTvgId ? `m3u_${normalizedTvgId}` : Math.random().toString(36).substring(2),
        name: nameMatch ? nameMatch[1] : "Unknown",
        logo: logoMatch ? logoMatch[1] : "",
        group: groupMatch ? groupMatch[1] : ""
      };
    }

    const streamUrl = parseStreamUrl(line, baseUrl);
    if (streamUrl) {
      const name = current.name || `Channel ${counter}`;
      const group = current.group || "";
      const contentType = detectContentType(name, group);
      const contentTypePrefix = contentType === "movie" ? "Movies: " : contentType === "series" ? "Series: " : "TV: ";
      
      channels.push({
        id: current.id || `m3u-${counter++}`,
        name: name,
        logo: current.logo || "",
        group: `${contentTypePrefix}${group || "Uncategorized"}`,
        url: streamUrl,
        contentType: contentType
      });
      current = {};
    }
  }

  const validChannels = channels
    .filter((c) => c.url && c.url.trim())
    .map((c) => ({
      ...c,
      group: c.group && c.group.trim() ? c.group.trim() : "Uncategorized"
    }));

  if (validChannels.length === 0) {
    throw new Error(
      "Zero channels parsed from playlist. Verify the URL and ensure the playlist contains valid stream links."
    );
  }

  return validChannels;
}

function getUrlCandidates(url: string): string[] {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("M3U URL is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return [trimmed];
  }

  return [`https://${trimmed}`, `http://${trimmed}`];
}

async function resolveReachableUrl(
  url: string,
  label: string
): Promise<{ requestUrl: string; baseUrl: string }> {
  const candidates = getUrlCandidates(url);
  const reasons: string[] = [];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (res.ok) {
        return { requestUrl: candidate, baseUrl: candidate };
      }
      reasons.push(`${candidate} -> ${res.status}`);
    } catch {
      reasons.push(`${candidate} -> network error`);

      // Browser CORS fallback for remote playlist URLs.
      const proxied = toCorsProxyUrl(candidate);
      try {
        const proxyRes = await fetch(proxied);
        if (proxyRes.ok) {
          // Important: keep the original URL as the base for relative stream entries.
          return { requestUrl: proxied, baseUrl: candidate };
        }
        reasons.push(`${proxied} -> ${proxyRes.status}`);
      } catch {
        reasons.push(`${proxied} -> proxy network error`);
      }
    }
  }

  throw new Error(`${label} request failed: ${reasons.join(", ")}`);
}

function toCorsProxyUrl(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function parseStreamUrl(line: string, sourceUrl: string): string | null {
  if (!line || line.startsWith("#")) return null;

  const cleaned = line.replace(/^['"]|['"]$/g, "").trim();
  if (!cleaned) return null;

  // Common absolute stream protocols.
  if (/^(https?:\/\/|rtmp:\/\/|rtsp:\/\/|udp:\/\/|rtp:\/\/|mms:\/\/)/i.test(cleaned)) {
    return cleaned;
  }

  // Resolve relative playlist lines against playlist URL.
  try {
    return new URL(cleaned, sourceUrl).toString();
  } catch {
    return null;
  }
}
