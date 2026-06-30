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
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;

    const refresh = () => {
      setPlaylists(loadPlaylists());
    };

    refresh();
    window.addEventListener("playlistsChanged", refresh);

    return () => {
      window.removeEventListener("playlistsChanged", refresh);
    };
  }, [visible]);

  if (!visible) return null;

  function remove(id: string) {
    deletePlaylist(id);
    setPlaylists(loadPlaylists());
  }

  async function loadPlaylistIntoApp(p: PlaylistEntry) {
    if (loadingId) return;
    setLoadingId(p.id);
    setStatusMessage(`Loading "${p.name}"… this can take up to a minute for large playlists.`);
    try {
      const channels = await loadChannelsForPlaylist(p);

      if (channels.length === 0) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setStatusMessage(`Indexing ${channels.length.toLocaleString()} entries…`);
      setChannels(channels);
      onPlaylistLoaded(channels);
      setStatusMessage(`Loaded ${channels.length.toLocaleString()} entries from "${p.name}". Fetching EPG…`);

      try {
        await loadEPGForPlaylist(p);
      } catch (epgErr) {
        console.warn("EPG load failed:", epgErr);
      }

      setStatusMessage(`✓ Loaded ${channels.length.toLocaleString()} entries from "${p.name}".`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setStatusMessage(`✗ Failed to load "${p.name}": ${message}`);
    } finally {
      setLoadingId(null);
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

      {statusMessage && (
        <div
          className="playlist-status-banner"
          role="status"
          aria-live="polite"
          style={{
            padding: "8px 12px",
            margin: "8px 0",
            background: loadingId ? "rgba(80, 140, 220, 0.18)" : "rgba(60, 180, 100, 0.18)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            fontSize: 14
          }}
        >
          {loadingId && <span style={{ marginRight: 8 }}>⏳</span>}
          {statusMessage}
        </div>
      )}

      {playlists.map((p) => (
        <div key={p.id} className="playlist-card">
          <strong>{p.name}</strong>
          <div className="playlist-item-type">
            Type: {p.type.toUpperCase()}
          </div>

          <div className="playlist-actions playlist-actions-top-gap">
            <button
              className="btn-primary btn-flex"
              disabled={loadingId !== null}
              onClick={() => {
                void loadPlaylistIntoApp(p);
              }}
            >
              {loadingId === p.id ? "Loading…" : "Load"}
            </button>

            <button
              className="btn-secondary btn-flex"
              disabled={loadingId !== null}
              onClick={() => alert("TODO: Edit playlist")}
            >
              Edit
            </button>

            <button
              className="btn-danger btn-flex"
              disabled={loadingId !== null}
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
