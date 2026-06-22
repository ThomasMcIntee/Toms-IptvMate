/* @refresh reload */

import { useEffect, useState } from "react";
import {
  loadPlaylists,
  deletePlaylist,
  PlaylistEntry
} from "../core/playlistStore";
import { setChannels } from "../core/channelStore";
import { loadEPGForPlaylist } from "../core/loaders/epgLoader";
import { loadChannelsForPlaylist } from "../core/loaders/playlistLoader";

export default function PlaylistManager({
  visible,
  onSelectContent,
  onPlaylistLoaded
}: {
  visible: boolean;
  onSelectContent: (content: "tv" | "movies" | "series") => void;
  onPlaylistLoaded: (channels: any[]) => void;
}) {
  const [playlists, setPlaylists] = useState<PlaylistEntry[]>([]);

  useEffect(() => {
    if (visible) {
      setPlaylists(loadPlaylists());
    }
  }, [visible]);

  if (!visible) return null;

  function remove(id: string) {
    deletePlaylist(id);
    setPlaylists(loadPlaylists());
  }

  async function loadPlaylistIntoApp(p: PlaylistEntry) {
    try {
      const channels = await loadChannelsForPlaylist(p);

      if (channels.length === 0) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setChannels(channels);
      await loadEPGForPlaylist(p);
      onPlaylistLoaded(channels);

      alert(`Loaded ${channels.length} channels`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to load playlist: ${message}`);
    }
  }

  return (
    <div className="side-panel">
      <h2>Playlist Manager</h2>

      <div className="playlist-manager-actions">
        <button className="btn-primary btn-flex" onClick={() => onSelectContent("tv")}>
          Live TV
        </button>
        <button className="btn-secondary btn-flex" onClick={() => onSelectContent("movies")}>
          Movies
        </button>
        <button className="btn-secondary btn-flex" onClick={() => onSelectContent("series")}>
          Series
        </button>
      </div>

      {playlists.length === 0 && <p>No playlists added yet.</p>}

      {playlists.map((p) => (
        <div key={p.id} className="playlist-card">
          <strong>{p.name}</strong>
          <div className="playlist-item-type">
            Type: {p.type.toUpperCase()}
          </div>

          <div className="playlist-actions playlist-actions-top-gap">
            <button
              className="btn-primary btn-flex"
              onClick={() => {
                void loadPlaylistIntoApp(p);
              }}
            >
              Load
            </button>

            <button
              className="btn-secondary btn-flex"
              onClick={() => alert("TODO: Edit playlist")}
            >
              Edit
            </button>

            <button
              className="btn-danger btn-flex"
              onClick={() => remove(p.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
