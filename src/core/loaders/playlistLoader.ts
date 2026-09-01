import { PlaylistEntry } from "../playlistStore";
import { capCapacitorCatalogList, type CatalogCategoryEntry, type Channel, type ContentType } from "../channelStore";
import { loadM3U } from "./m3uLoader";
import { loadXtream, loadXtreamCategoryIndex, loadXtreamChannelsForCategory } from "./xtreamLoader";
import { loadStalker } from "./stalkerLoader";

export type PlaylistLoadScope = "all" | "live" | "movies" | "series";

function scopeToContentType(scope: "live" | "movies" | "series"): ContentType {
  if (scope === "live") return "live";
  if (scope === "movies") return "movie";
  return "series";
}

export async function loadCategoryIndexForPlaylist(
  playlist: PlaylistEntry,
  scope: "live" | "movies" | "series"
): Promise<CatalogCategoryEntry[]> {
  if (playlist.type !== "xtream") return [];
  return loadXtreamCategoryIndex(
    playlist.data.url,
    playlist.data.user,
    playlist.data.pass,
    scopeToContentType(scope)
  );
}

export async function loadCategoryChannelsForPlaylist(
  playlist: PlaylistEntry,
  entry: CatalogCategoryEntry
): Promise<Channel[]> {
  if (playlist.type !== "xtream") return [];
  return loadXtreamChannelsForCategory(
    playlist.data.url,
    playlist.data.user,
    playlist.data.pass,
    entry
  );
}

function filterChannelsForScope(channels: any[], scope: PlaylistLoadScope) {
  if (scope === "all") return channels;

  const expectedType = scope === "live" ? "live" : scope === "movies" ? "movie" : "series";
  const scoped = channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === expectedType);
  return scope === "movies" || scope === "series" ? capCapacitorCatalogList(scoped) : scoped;
}

export async function loadChannelsForPlaylist(playlist: PlaylistEntry, scope: PlaylistLoadScope = "all") {
  if (playlist.type === "m3u") {
    return filterChannelsForScope(await loadM3U(playlist.data.url), scope);
  }

  if (playlist.type === "xtream") {
    const xtreamChannels = await loadXtream(playlist.data.url, playlist.data.user, playlist.data.pass, scope);
    return scope === "movies" || scope === "series" ? capCapacitorCatalogList(xtreamChannels) : xtreamChannels;
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
