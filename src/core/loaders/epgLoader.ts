import { setEPG, saveEPGCache, loadEPGCache, getEPGForChannel } from "../epgStore";
import { getAllChannels } from "../channelStore";
import { parseXMLTV } from "./xmltvParser";
import { loadXtreamEPG, loadXtreamEPGForStream } from "./xtreamEPG";
import { loadStalkerEPG } from "./stalkerEPG";

const inFlightEPGLoads = new Map<string, Promise<void>>();

function normalizeEpgKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findXmltvEvents(xmltv: Record<string, any[]>, channel: any): any[] {
  const id = String(channel?.id || "").trim();
  const name = String(channel?.name || "").trim();

  const candidates = new Set<string>();
  if (id) {
    candidates.add(id);
    candidates.add(id.toLowerCase());
    candidates.add(normalizeEpgKey(id));
    if (id.startsWith("m3u_")) {
      const unprefixed = id.slice(4);
      candidates.add(unprefixed);
      candidates.add(unprefixed.toLowerCase());
      candidates.add(normalizeEpgKey(unprefixed));
    }
  }

  if (name) {
    candidates.add(name);
    candidates.add(name.toLowerCase());
    candidates.add(name.replace(/\s+/g, "").toLowerCase());
    candidates.add(normalizeEpgKey(name));
  }

  for (const key of candidates) {
    const events = xmltv[key];
    if (Array.isArray(events) && events.length > 0) {
      return events;
    }
  }

  return [];
}

function isLikelyLiveChannel(channel: any): boolean {
  const contentType = String(channel?.contentType || "").toLowerCase();
  if (contentType === "live") return true;

  const id = String(channel?.id || "").toLowerCase();
  if (id.startsWith("live_")) return true;

  const group = String(channel?.group || "").toLowerCase();
  return group.startsWith("tv:");
}

function hasSufficientGuideForLiveChannels(): boolean {
  const liveChannels = getAllChannels().filter((channel) => isLikelyLiveChannel(channel));
  if (liveChannels.length === 0) return false;

  const channelsWithGuide = liveChannels.filter((channel) => {
    const events = getEPGForChannel(channel);
    return Array.isArray(events) && events.length > 0;
  }).length;

  const minimumCoverage = Math.max(3, Math.ceil(liveChannels.length * 0.1));
  return channelsWithGuide >= minimumCoverage;
}

function getUrlCandidates(url: string): string[] {
  const trimmed = String(url || "").trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return [trimmed];
  }

  return [`https://${trimmed}`, `http://${trimmed}`];
}

function toCorsProxyUrl(url: string): string {
  return `https://corsproxy.io/?${encodeURIComponent(url)}`;
}

function extractM3uHeaderEpgUrl(m3uText: string, baseUrl: string): string | null {
  const firstLines = String(m3uText || "")
    .split(/\r?\n/)
    .slice(0, 6)
    .join("\n");

  const epgAttrMatch = firstLines.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i);
  if (!epgAttrMatch || !epgAttrMatch[1]) return null;

  const firstCandidate = epgAttrMatch[1]
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);

  if (!firstCandidate) return null;

  try {
    return new URL(firstCandidate, baseUrl).toString();
  } catch {
    return null;
  }
}

async function resolveM3uEpgUrl(playlist: any): Promise<string | null> {
  const configured = String(playlist?.data?.epg || "").trim();
  if (configured) return configured;

  const playlistUrl = String(playlist?.data?.url || "").trim();
  const candidates = getUrlCandidates(playlistUrl);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (res.ok) {
        const text = await res.text();
        const extracted = extractM3uHeaderEpgUrl(text, candidate);
        if (extracted) return extracted;
      }
    } catch {
      // Try proxy fallback below.
    }

    try {
      const proxyRes = await fetch(toCorsProxyUrl(candidate));
      if (proxyRes.ok) {
        const text = await proxyRes.text();
        const extracted = extractM3uHeaderEpgUrl(text, candidate);
        if (extracted) return extracted;
      }
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

export async function loadEPGForPlaylist(playlist: any) {
  const existingLoad = inFlightEPGLoads.get(playlist.id);
  if (existingLoad) {
    await existingLoad;
    return;
  }

  const run = async () => {
    // Try loading cache first.
    const cacheLoaded = loadEPGCache(playlist.id);
    if (cacheLoaded && hasSufficientGuideForLiveChannels()) {
      return;
    }

    const nextEpg: Record<string, any[]> = {};
    const putEvents = (id: string, events: any[]) => {
      const key = String(id || "").trim();
      if (!key) return;
      if (!Array.isArray(events) || events.length === 0) return;
      nextEpg[key] = events;
    };

    if (playlist.type === "m3u") {
      const epgUrl = await resolveM3uEpgUrl(playlist);
      if (epgUrl) {
        const xmltv = await parseXMLTV(epgUrl);
        const channels = getAllChannels();

        channels.forEach((ch) => {
          const events = findXmltvEvents(xmltv, ch);
          putEvents(ch.id, events);
        });
      }
    }

    if (playlist.type === "xtream") {
      const epg = await loadXtreamEPG(
        playlist.data.url,
        playlist.data.user,
        playlist.data.pass
      );

      Object.keys(epg).forEach((id) => {
        const events = epg[id];
        putEvents(id, events);
        putEvents(`live_${id}`, events);
        putEvents(`movie_${id}`, events);
        putEvents(`series_${id}`, events);
      });

      // Bridge provider stream keys to actual loaded channel IDs and names.
      const mappedLiveChannels = getAllChannels().filter(
        (channel) => String(channel?.contentType || "").toLowerCase() === "live"
      );

      mappedLiveChannels.forEach((channel) => {
        const channelId = String(channel?.id || "");
        const channelName = String(channel?.name || "").trim();
        const streamId =
          extractXtreamStreamId(channelId) ||
          extractXtreamStreamIdFromUrl(String(channel?.url || ""));
        if (!streamId) return;

        const events = epg[streamId] || epg[`live_${streamId}`];
        if (!Array.isArray(events) || events.length === 0) return;

        putEvents(streamId, events);
        putEvents(`live_${streamId}`, events);
        putEvents(channelId, events);
        if (channelName) {
          putEvents(channelName, events);
        }
      });

        // Some Xtream providers expose little/no global EPG and require per-stream calls.
        // Prefill missing live channels ahead of time with bounded parallelism.
        const liveChannels = getAllChannels()
          .filter((channel) => String(channel?.contentType || "").toLowerCase() === "live")
          .slice(0, 320);

        const missingLive = liveChannels.filter((channel) => {
          const channelId = String(channel?.id || "");
          if (!channelId) return false;
          const streamId =
            extractXtreamStreamId(channelId) ||
            extractXtreamStreamIdFromUrl(String(channel?.url || ""));
          if (!streamId) return false;

          const existing =
            nextEpg[channelId] ||
            nextEpg[streamId] ||
            nextEpg[`live_${streamId}`];
          return !Array.isArray(existing) || existing.length === 0;
        });

        if (missingLive.length > 0) {
          const workerCount = Math.min(8, missingLive.length);
          let cursor = 0;

          const worker = async () => {
            while (cursor < missingLive.length) {
              const index = cursor;
              cursor += 1;
              const channel = missingLive[index];
              const channelId = String(channel?.id || "");
              const streamId =
                extractXtreamStreamId(channelId) ||
                extractXtreamStreamIdFromUrl(String(channel?.url || ""));
              if (!streamId) continue;

              try {
                const events = await loadXtreamEPGForStream(
                  playlist.data.url,
                  playlist.data.user,
                  playlist.data.pass,
                  streamId,
                  24
                );
                putEvents(streamId, events);
                putEvents(`live_${streamId}`, events);
                putEvents(channelId, events);
              } catch {
                // Keep processing remaining channels.
              }
            }
          };

          await Promise.all(Array.from({ length: workerCount }, () => worker()));
        }
    }

    if (playlist.type === "stalker") {
      const epg = await loadStalkerEPG(playlist.data.portal, playlist.data.mac);

      Object.keys(epg).forEach((id) => {
        const events = epg[id];
        putEvents(id, events);
        putEvents(`live_${id}`, events);
        putEvents(`movie_${id}`, events);
        putEvents(`series_${id}`, events);
      });
    }

    if (Object.keys(nextEpg).length === 0) {
      return;
    }

    Object.keys(nextEpg).forEach((id) => {
      setEPG(id, nextEpg[id]);
    });
    saveEPGCache(playlist.id);
  };

  const promise = run().finally(() => {
    inFlightEPGLoads.delete(playlist.id);
  });

  inFlightEPGLoads.set(playlist.id, promise);
  await promise;
}

function extractXtreamStreamId(channelId: string): string {
  const raw = String(channelId || "").trim();
  if (!raw) return "";

  const prefixed = raw.match(/^live_(\d+)$/i);
  if (prefixed) return prefixed[1];

  const numericTail = raw.match(/(\d+)$/);
  return numericTail ? numericTail[1] : "";
}

function extractXtreamStreamIdFromUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "";
    const filenameMatch = lastSegment.match(/^(\d+)(?:\.[a-z0-9]+)?$/i);
    if (filenameMatch) return filenameMatch[1];
  } catch {
    // Ignore invalid URLs and try regex fallback.
  }

  const fallbackMatch = raw.match(/(?:^|\/)(\d+)(?:\.[a-z0-9]+)?(?:$|[?#])/i);
  return fallbackMatch ? fallbackMatch[1] : "";
}
