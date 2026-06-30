import { EPGEvent } from "../epgStore";

function normalizeXmltvKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export async function parseXMLTV(url: string): Promise<Record<string, EPGEvent[]>> {
  const { requestUrl } = await resolveReachableUrl(url, "XMLTV");
  const xml = await fetchXmltvText(requestUrl);

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  const result: Record<string, EPGEvent[]> = {};
  const channelAliasMap = new Map<string, Set<string>>();

  const xmltvChannels = doc.getElementsByTagName("channel");
  for (const channelNode of Array.from(xmltvChannels)) {
    const channelId = String(channelNode.getAttribute("id") || "").trim();
    if (!channelId) continue;

    const aliases = new Set<string>();
    addXmltvAliases(aliases, channelId);

    const displayNames = channelNode.getElementsByTagName("display-name");
    for (const displayNameNode of Array.from(displayNames)) {
      const displayName = String(displayNameNode.textContent || "").trim();
      if (!displayName) continue;
      addXmltvAliases(aliases, displayName);
    }

    channelAliasMap.set(channelId, aliases);
  }

  const programmes = doc.getElementsByTagName("programme");

  for (const p of Array.from(programmes)) {
    const channelId = p.getAttribute("channel") || "";
    const start = parseXMLTVDate(p.getAttribute("start") || "");
    const end = parseXMLTVDate(p.getAttribute("stop") || "");

    const title = p.getElementsByTagName("title")[0]?.textContent || "";
    const desc = p.getElementsByTagName("desc")[0]?.textContent || "";

    const event = { start, end, title, desc };
    const aliases = new Set<string>();
    const mappedAliases = channelAliasMap.get(channelId);
    if (mappedAliases && mappedAliases.size > 0) {
      mappedAliases.forEach((alias) => aliases.add(alias));
    } else {
      addXmltvAliases(aliases, channelId);
    }

    aliases.forEach((key) => {
      if (!key) return;
      if (!result[key]) result[key] = [];
      result[key].push(event);
    });
  }

  return result;
}

async function fetchXmltvText(requestUrl: string): Promise<string> {
  const res = await fetch(requestUrl);
  if (!res.ok) {
    throw new Error(`XMLTV request failed (${res.status})`);
  }

  const contentType = String(res.headers.get("content-type") || "").toLowerCase();
  const rawBuffer = await res.arrayBuffer();
  const plainText = new TextDecoder("utf-8", { fatal: false }).decode(rawBuffer);
  if (looksLikeXmltv(plainText)) {
    return plainText;
  }

  const shouldTryGzip =
    /gzip|x-gzip|application\/octet-stream/.test(contentType) ||
    /\.gz(?:$|\?)/i.test(requestUrl);

  if (shouldTryGzip) {
    const inflated = await tryInflateGzip(rawBuffer);
    if (inflated && looksLikeXmltv(inflated)) {
      return inflated;
    }
  }

  return plainText;
}

function looksLikeXmltv(text: string): boolean {
  const sample = String(text || "").slice(0, 4000).toLowerCase();
  return sample.includes("<tv") || sample.includes("<programme") || sample.includes("<?xml");
}

async function tryInflateGzip(rawBuffer: ArrayBuffer): Promise<string | null> {
  if (typeof DecompressionStream === "undefined") {
    return null;
  }

  try {
    const inputStream = new Blob([rawBuffer]).stream();
    const decompressedStream = inputStream.pipeThrough(new DecompressionStream("gzip"));
    const decompressedBuffer = await new Response(decompressedStream).arrayBuffer();
    return new TextDecoder("utf-8", { fatal: false }).decode(decompressedBuffer);
  } catch {
    return null;
  }
}

function getUrlCandidates(url: string): string[] {
  const trimmed = String(url || "").trim();
  if (!trimmed) {
    throw new Error("XMLTV URL is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return [trimmed];
  }

  return [`https://${trimmed}`, `http://${trimmed}`];
}

async function resolveReachableUrl(url: string, label: string): Promise<{ requestUrl: string }> {
  const candidates = getUrlCandidates(url);
  const reasons: string[] = [];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (res.ok) {
        return { requestUrl: candidate };
      }
      reasons.push(`${candidate} -> ${res.status}`);
    } catch {
      reasons.push(`${candidate} -> network error`);
    }

    const proxied = toCorsProxyUrl(candidate);
    try {
      const proxyRes = await fetch(proxied);
      if (proxyRes.ok) {
        return { requestUrl: proxied };
      }
      reasons.push(`${proxied} -> ${proxyRes.status}`);
    } catch {
      reasons.push(`${proxied} -> proxy network error`);
    }
  }

  throw new Error(`${label} request failed: ${reasons.join(", ")}`);
}

function toCorsProxyUrl(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function addXmltvAliases(target: Set<string>, value: string) {
  const source = String(value || "").trim();
  if (!source) return;

  target.add(source);
  target.add(source.toLowerCase());
  target.add(source.replace(/\s+/g, "").toLowerCase());
  target.add(normalizeXmltvKey(source));
}

function parseXMLTVDate(str: string): number {
  // Common XMLTV formats:
  // - 20240615060000 +0000
  // - 20240615060000 +0200
  // - 20240615060000 -0500
  // - 20240615060000 (no explicit offset)
  const match = String(str || "")
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);

  if (!match) return 0;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const min = Number(match[5]);
  const sec = Number(match[6]);

  // If an explicit offset exists, treat the timestamp as wall-clock time in that zone
  // and convert it to UTC epoch.
  const sign = match[7];
  const tzHour = match[8];
  const tzMin = match[9];
  if (sign && tzHour && tzMin) {
    let epoch = Date.UTC(year, month - 1, day, hour, min, sec);
    const offsetMinutes = Number(tzHour) * 60 + Number(tzMin);
    const delta = offsetMinutes * 60 * 1000;
    epoch = sign === "+" ? epoch - delta : epoch + delta;
    return epoch;
  }

  // No offset present: treat as local time (many XMLTV feeds rely on this).
  return new Date(year, month - 1, day, hour, min, sec).getTime();
}
