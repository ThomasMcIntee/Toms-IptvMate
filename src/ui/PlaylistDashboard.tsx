import { setChannels } from "../core/channelStore";
import { loadEPGForPlaylist } from "../core/loaders/epgLoader";
import { loadChannelsForPlaylist } from "../core/loaders/playlistLoader";
import { useEffect, useState } from "react";
import {
  loadPlaylists,
  deletePlaylist,
  PlaylistEntry
} from "../core/playlistStore";

export default function PlaylistDashboard({
  visible
}: {
  visible: boolean;
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
  async function loadPlaylist(p: PlaylistEntry) {
    try {
      const channels = await loadChannelsForPlaylist(p);

      if (channels.length === 0) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setChannels(channels);
      await loadEPGForPlaylist(p);
      alert(`Loaded ${channels.length} channels`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to load playlist: ${message}`);
    }
  }


  return (
    <div className="side-panel">
      <h2>Playlists</h2>

      {playlists.length === 0 && (
        <p className="muted-text">No playlists added yet.</p>
      )}

      {playlists.map((p) => (
        <div
          key={p.id}
          className="playlist-card"
        >
          <div className="playlist-header">
            <div className="playlist-title">{p.name}</div>
            <div className="playlist-type">{p.type.toUpperCase()}</div>
          </div>

          <div className="playlist-meta">
            <div>Created: {new Date(Number(p.id)).toLocaleString()}</div>
            <div>Source: {p.data.url || p.data.portal}</div>
          </div>

          <div className="playlist-actions">
            <button
              className="btn-primary"
              onClick={() => loadPlaylist(p)}

            >
              Load
            </button>

            <button
              className="btn-secondary"
              onClick={() => alert("TODO: Edit playlist")}
            >
              Edit
            </button>

            <button
              className="btn-danger"
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
