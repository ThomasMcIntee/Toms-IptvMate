import { PlaylistEntry } from "../playlistStore";
import { loadM3U } from "./m3uLoader";
import { loadXtream } from "./xtreamLoader";
import { loadStalker } from "./stalkerLoader";

export async function loadChannelsForPlaylist(playlist: PlaylistEntry) {
  if (playlist.type === "m3u") {
    return loadM3U(playlist.data.url);
  }

  if (playlist.type === "xtream") {
    return loadXtream(playlist.data.url, playlist.data.user, playlist.data.pass);
  }

  return loadStalker(playlist.data.portal, playlist.data.mac);
}

export async function loadFromAnyPlaylist(playlists: PlaylistEntry[]) {
  const errors: string[] = [];

  for (const playlist of playlists) {
    try {
      const channels = await loadChannelsForPlaylist(playlist);
      if (channels.length > 0) {
        return { playlist, channels, errors };
      }

      errors.push(`${playlist.name}: zero channels`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      errors.push(`${playlist.name}: ${message}`);
    }
  }

  throw new Error(`All playlists failed. ${errors.join(" | ")}`);
}
