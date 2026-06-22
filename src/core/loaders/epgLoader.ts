import { setEPG, clearEPG, saveEPGCache, loadEPGCache } from "../epgStore";
import { getAllChannels } from "../channelStore";
import { parseXMLTV } from "./xmltvParser";
import { loadXtreamEPG } from "./xtreamEPG";
import { loadStalkerEPG } from "./stalkerEPG";

const inFlightEPGLoads = new Map<string, Promise<void>>();

export async function loadEPGForPlaylist(playlist: any) {
  const existingLoad = inFlightEPGLoads.get(playlist.id);
  if (existingLoad) {
    await existingLoad;
    return;
  }

  const run = async () => {
  // Try loading cache first
  const cacheLoaded = loadEPGCache(playlist.id);
  if (cacheLoaded) {
    return;
  }

  clearEPG();

  if (playlist.type === "m3u") {
    if (!playlist.data.epg) return;

    const xmltv = await parseXMLTV(playlist.data.epg);
    const channels = getAllChannels();

    channels.forEach((ch) => {
      const epgId = ch.name.toLowerCase().replace(/\s+/g, "");
      const events = xmltv[epgId] || [];
      setEPG(ch.id, events);
    });
  }

  if (playlist.type === "xtream") {
    const epg = await loadXtreamEPG(
      playlist.data.url,
      playlist.data.user,
      playlist.data.pass
    );

    Object.keys(epg).forEach((id) => {
      setEPG(id, epg[id]);
    });
  }

  if (playlist.type === "stalker") {
    const epg = await loadStalkerEPG(playlist.data.portal, playlist.data.mac);

    Object.keys(epg).forEach((id) => {
      setEPG(id, epg[id]);
    });
  }

  // Save new cache
  saveEPGCache(playlist.id);
  };

  const promise = run().finally(() => {
    inFlightEPGLoads.delete(playlist.id);
  });

  inFlightEPGLoads.set(playlist.id, promise);
  await promise;
}
