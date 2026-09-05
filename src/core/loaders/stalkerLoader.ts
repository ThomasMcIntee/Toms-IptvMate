import { Channel, ContentType } from "../channelStore";
import { isWebOsRuntime } from "../player/platformDetection";
import { fetchWebOsRemote, fetchWebOsRemoteJson } from "../webosStreamRelay";

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

export async function loadStalker(portal: string, mac: string): Promise<Channel[]> {
  const macAddress = mac.trim();
  if (!macAddress) {
    throw new Error("Stalker MAC address is empty");
  }

  const portalBase = await resolveReachablePortalBase(portal, macAddress);

  const headers = {
    "User-Agent": "Mozilla/5.0",
    "X-User-Agent": "Model: MAG254; Link: Ethernet",
    "Referer": portalBase,
    "Cookie": `mac=${macAddress}; stb_lang=en; timezone=GMT`
  };

  const handshakeUrl = `${portalBase}server/load.php?type=stb&action=handshake&token=`;
  const channelsUrl = `${portalBase}server/load.php?type=itv&action=get_all_channels`;

  if (isWebOsRuntime()) {
    const handshake = await fetchWebOsRemote(handshakeUrl);
    if (!handshake) {
      throw new Error("Stalker handshake failed (webOS fetch)");
    }
    const data = await fetchWebOsRemoteJson(channelsUrl) as { js?: unknown } | null;
    if (!data?.js || !Array.isArray(data.js)) {
      throw new Error("Stalker response format is invalid");
    }
    return mapStalkerChannels(data.js);
  }

  // Auth
  const handshakeRes = await fetch(handshakeUrl, {
    headers
  });
  if (!handshakeRes.ok) {
    throw new Error(`Stalker handshake failed (${handshakeRes.status})`);
  }

  // Channels
  const res = await fetch(channelsUrl, { headers });
  if (!res.ok) {
    throw new Error(`Stalker channels request failed (${res.status})`);
  }

  const data = await res.json();
  if (!data?.js || !Array.isArray(data.js)) {
    throw new Error("Stalker response format is invalid");
  }

  return mapStalkerChannels(data.js);
}

function mapStalkerChannels(items: any[]): Channel[] {
  return items
    .filter((item: any) => item.id != null && item.cmd && item.cmd.trim())
    .map((item: any) => {
      const name = item.name || `Channel ${item.id}`;
      const group = (item.tv_genre_id && String(item.tv_genre_id).trim()) || "Uncategorized";
      const contentType = detectContentType(name, group);
      const contentTypePrefix = contentType === "movie" ? "Movies: " : contentType === "series" ? "Series: " : "TV: ";

      return {
        id: `stalker_${item.id}`,
        name: name,
        logo: item.logo,
        url: item.cmd,
        group: `${contentTypePrefix}${group}`,
        contentType: contentType
      };
    });
}

function getPortalCandidates(portal: string): string[] {
  const trimmed = portal.trim();
  if (!trimmed) {
    throw new Error("Stalker portal URL is empty");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const normalized = `${trimmed.replace(/\/+$/, "")}/`;
    if (isWebOsRuntime() && normalized.startsWith("https://")) {
      return [normalized, `http://${normalized.slice("https://".length)}`];
    }
    return [normalized];
  }

  return [`https://${trimmed.replace(/\/+$/, "")}/`, `http://${trimmed.replace(/\/+$/, "")}/`];
}

async function resolveReachablePortalBase(portal: string, macAddress: string): Promise<string> {
  const candidates = getPortalCandidates(portal);
  const reasons: string[] = [];

  for (const portalBase of candidates) {
    const headers = {
      "User-Agent": "Mozilla/5.0",
      "X-User-Agent": "Model: MAG254; Link: Ethernet",
      "Referer": portalBase,
      "Cookie": `mac=${macAddress}; stb_lang=en; timezone=GMT`
    };

    const handshakeUrl = `${portalBase}server/load.php?type=stb&action=handshake&token=`;
    try {
      if (isWebOsRuntime()) {
        const remote = await fetchWebOsRemote(handshakeUrl);
        if (remote) return portalBase;
        reasons.push(`${portalBase} -> webOS fetch failed`);
        continue;
      }

      const res = await fetch(handshakeUrl, {
        headers
      });

      if (res.ok) return portalBase;
      reasons.push(`${portalBase} -> ${res.status}`);
    } catch {
      reasons.push(`${portalBase} -> network error`);
    }
  }

  throw new Error(
    `Stalker handshake failed: ${reasons.join(", ")}. ` +
      "If this works in other apps but fails in browser, it may be blocked by CORS/server policy."
  );
}
