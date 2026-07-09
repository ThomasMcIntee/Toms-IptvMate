import { PlaylistEntry } from "../playlistStore";
import { loadM3U } from "./m3uLoader";
import { loadXtream } from "./xtreamLoader";
import { loadStalker } from "./stalkerLoader";

export type PlaylistLoadScope = "all" | "live" | "movies" | "series";

function filterChannelsForScope(channels: any[], scope: PlaylistLoadScope) {
  if (scope === "all") return channels;

  const expectedType = scope === "live" ? "live" : scope === "movies" ? "movie" : "series";
  return channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === expectedType);
}

export async function loadChannelsForPlaylist(playlist: PlaylistEntry, scope: PlaylistLoadScope = "all") {
  if (playlist.type === "m3u") {
    return filterChannelsForScope(await loadM3U(playlist.data.url), scope);
  }

  if (playlist.type === "xtream") {
    return loadXtream(playlist.data.url, playlist.data.user, playlist.data.pass, scope);
  }

  return filterChannelsForScope(await loadStalker(playlist.data.portal, playlist.data.mac), scope);
}

export async function loadFromAnyPlaylist(playlists: PlaylistEntry[], scope: PlaylistLoadScope = "all") {
  const errors: string[] = [];

  for (const playlist of playlists) {
    try {
      const channels = await loadChannelsForPlaylist(playlist, scope);
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
