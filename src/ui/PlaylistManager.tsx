/* @refresh reload */

import { useEffect, useRef, useState } from "react";
import {
  loadPlaylists,
  deletePlaylist,
  PlaylistEntry
} from "../core/playlistStore";
import {
  setChannels,
  Channel,
  getAllChannels,
  getVisibilitySnapshotForChannelIds,
  applyVisibilitySnapshotForCurrentChannels,
  ChannelVisibilitySnapshot
} from "../core/channelStore";
import { loadEPGForPlaylist } from "../core/loaders/epgLoader";
import { loadChannelsForPlaylist } from "../core/loaders/playlistLoader";
import { loadEPGCache } from "../core/epgStore";

const ADULT_CACHE_KEY = "iptvmate_adult_channels_cache";
const CHILD_CACHE_KEY = "iptvmate_child_channels_cache";
const ADULT_PLAYLIST_ID_KEY = "iptvmate_adult_playlist_id";
const CHILD_PLAYLIST_ID_KEY = "iptvmate_child_playlist_id";
const SHARED_PLAYLIST_ID_KEY = "iptvmate_shared_playlist_id";
const ROLE_CHANNELS_DB = "iptvmate_role_cache";
const ROLE_CHANNELS_STORE = "channels";

type RoleCachePayload = {
  playlistId: string;
  channels: Channel[];
  visibility?: ChannelVisibilitySnapshot;
};

function roleCacheStorageKey(kind: "adult" | "child"): string {
  return kind === "adult" ? ADULT_CACHE_KEY : CHILD_CACHE_KEY;
}

function roleCacheDbKey(kind: "adult" | "child"): string {
  return `role_${kind}`;
}

function readStorageItem(key: string): string | null {
  try {
    const local = localStorage.getItem(key);
    if (local) return local;
  } catch {
    // Ignore localStorage errors.
  }

  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore localStorage errors.
  }

  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore sessionStorage errors.
  }
}

function sanitizeChannel(candidate: any): Channel | null {
  if (!candidate || typeof candidate !== "object") return null;
  const id = String(candidate.id || "").trim();
  const name = String(candidate.name || "").trim();
  const url = String(candidate.url || "").trim();
  if (!id || !name || !url) return null;

  const channel: Channel = { id, name, url };
  if (typeof candidate.logo === "string") channel.logo = candidate.logo;
  if (typeof candidate.group === "string") channel.group = candidate.group;
  if (candidate.contentType === "live" || candidate.contentType === "movie" || candidate.contentType === "series") {
    channel.contentType = candidate.contentType;
  }
  if (typeof candidate.parentGroup === "string") channel.parentGroup = candidate.parentGroup;
  if (candidate.episodeInfo && typeof candidate.episodeInfo === "object") {
    channel.episodeInfo = {
      season: typeof candidate.episodeInfo.season === "number" ? candidate.episodeInfo.season : undefined,
      episode: typeof candidate.episodeInfo.episode === "number" ? candidate.episodeInfo.episode : undefined,
      title: typeof candidate.episodeInfo.title === "string" ? candidate.episodeInfo.title : undefined
    };
  }

  return channel;
}

function parseRoleCache(raw: string | null, playlistId: string): RoleCachePayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RoleCachePayload>;
    if (!parsed || !Array.isArray(parsed.channels)) return null;

    const channels = parsed.channels.map((item) => sanitizeChannel(item)).filter((item): item is Channel => !!item);
    if (channels.length === 0) return null;

    const visibility =
      parsed.visibility && typeof parsed.visibility === "object"
        ? {
            groups:
              parsed.visibility.groups && typeof parsed.visibility.groups === "object"
                ? (parsed.visibility.groups as Record<string, boolean>)
                : {},
            channels:
              parsed.visibility.channels && typeof parsed.visibility.channels === "object"
                ? (parsed.visibility.channels as Record<string, boolean>)
                : {}
          }
        : undefined;

    return {
      playlistId: String(parsed.playlistId || playlistId),
      channels,
      visibility
    };
  } catch {
    return null;
  }
}

async function openRoleCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(ROLE_CHANNELS_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ROLE_CHANNELS_STORE)) {
          db.createObjectStore(ROLE_CHANNELS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readRoleCacheFromDb(kind: "adult" | "child", playlistId: string): Promise<RoleCachePayload | null> {
  const db = await openRoleCacheDb();
  if (!db) return null;

  const result = await new Promise<RoleCachePayload | null>((resolve) => {
    try {
      const tx = db.transaction(ROLE_CHANNELS_STORE, "readonly");
      const request = tx.objectStore(ROLE_CHANNELS_STORE).get(roleCacheDbKey(kind));
      request.onsuccess = () => {
        const value = request.result as RoleCachePayload | undefined;
        if (!value || !Array.isArray(value.channels)) {
          resolve(null);
          return;
        }

        const channels = value.channels.map((item) => sanitizeChannel(item)).filter((item): item is Channel => !!item);
        if (channels.length === 0) {
          resolve(null);
          return;
        }

        resolve({
          playlistId: String(value.playlistId || playlistId),
          channels,
          visibility: value.visibility
        });
      };
      request.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  db.close();
  return result;
}

async function writeRoleCache(kind: "adult" | "child", payload: RoleCachePayload): Promise<void> {
  writeStorageItem(roleCacheStorageKey(kind), JSON.stringify(payload));

  const db = await openRoleCacheDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(ROLE_CHANNELS_STORE, "readwrite");
      tx.objectStore(ROLE_CHANNELS_STORE).put(payload, roleCacheDbKey(kind));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  db.close();
}

async function readRoleCache(kind: "adult" | "child", playlistId: string): Promise<RoleCachePayload | null> {
  const fromLocal = parseRoleCache(readStorageItem(roleCacheStorageKey(kind)), playlistId);
  if (fromLocal) return fromLocal;
  return readRoleCacheFromDb(kind, playlistId);
}

export default function PlaylistManager({
  visible,
  onSelectContent,
  onPlaylistLoaded,
  activePlaylistId
}: {
  visible: boolean;
  onSelectContent: (content: "tv" | "movies" | "series") => void;
  onPlaylistLoaded: (channels: any[], playlistId: string) => void;
  activePlaylistId: string;
}) {
  const [playlists, setPlaylists] = useState<PlaylistEntry[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activeRoleContext, setActiveRoleContext] = useState<"adult" | "child" | null>(null);
  const [currentPlaylistId, setCurrentPlaylistId] = useState<string>("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const loadRequestTokenRef = useRef(0);
  const visibleRef = useRef(visible);
  const [adultPlaylistId, setAdultPlaylistId] = useState<string>(() => {
    return readStorageItem(ADULT_PLAYLIST_ID_KEY) || "";
  });
  const [childPlaylistId, setChildPlaylistId] = useState<string>(() => {
    return readStorageItem(CHILD_PLAYLIST_ID_KEY) || "";
  });

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      // Invalidate any in-flight async loads when screen is hidden.
      loadRequestTokenRef.current += 1;
    }
  }, [visible]);

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

  useEffect(() => {
    // Role snapshots are intentionally not auto-persisted from visibility events.
    // Automatic writes can capture channels from a different loaded playlist and
    // poison role cache with stale/full-list content.
  }, [visible]);

  if (!visible) return null;

  function setAdultPlaylist(id: string) {
    setAdultPlaylistId(id);
    setSelectedPlaylistId(id);
    writeStorageItem(ADULT_PLAYLIST_ID_KEY, id);
  }

  function setChildPlaylist(id: string) {
    setChildPlaylistId(id);
    setSelectedPlaylistId(id);
    writeStorageItem(CHILD_PLAYLIST_ID_KEY, id);
  }

  async function persistRoleSnapshot(kind: "adult" | "child", playlistId: string) {
    const currentChannels = getAllChannels();
    if (currentChannels.length === 0) return;

    const visibility = getVisibilitySnapshotForChannelIds(currentChannels.map((channel) => channel.id));
    await writeRoleCache(kind, {
      playlistId,
      channels: currentChannels,
      visibility
    });
  }

  async function saveActiveRoleSnapshot(kind: "adult" | "child" | null = activeRoleContext) {
    if (!kind) {
      alert("Select Adult or Child first.");
      return;
    }

    const targetPlaylistId = activePlaylistId || selectedPlaylistId || currentPlaylistId;
    if (!targetPlaylistId) {
      alert("Select or load a playlist first, then save its visibility for the selected role.");
      return;
    }

    const targetPlaylist = playlists.find((playlist) => playlist.id === targetPlaylistId);
    if (!targetPlaylist) {
      alert("The currently loaded playlist no longer exists. Load it again first.");
      return;
    }

    if (kind === "adult") {
      setAdultPlaylistId(targetPlaylist.id);
      writeStorageItem(ADULT_PLAYLIST_ID_KEY, targetPlaylist.id);
    } else {
      setChildPlaylistId(targetPlaylist.id);
      writeStorageItem(CHILD_PLAYLIST_ID_KEY, targetPlaylist.id);
    }

    writeStorageItem(SHARED_PLAYLIST_ID_KEY, targetPlaylist.id);

    await persistRoleSnapshot(kind, targetPlaylist.id);
    setStatusMessage(`✓ Saved ${kind} visibility for "${targetPlaylist.name}".`);
  }

  async function applyActiveRoleVisibility(kind: "adult" | "child") {
    setActiveRoleContext(kind);

    const targetPlaylistId = activePlaylistId || selectedPlaylistId || currentPlaylistId;
    if (!targetPlaylistId) {
      setStatusMessage(`${kind === "adult" ? "Adult" : "Child"} visibility selected. Load the shared playlist first.`);
      return;
    }

    const targetPlaylist = playlists.find((playlist) => playlist.id === targetPlaylistId);
    if (!targetPlaylist) {
      setStatusMessage(`${kind === "adult" ? "Adult" : "Child"} visibility selected. Shared playlist is not available.`);
      return;
    }

    const cached = await readRoleCache(kind, targetPlaylist.id);
    if (!cached?.visibility) {
      setStatusMessage(`No saved ${kind} hidden-channel profile for "${targetPlaylist.name}" yet.`);
      return;
    }

    applyVisibilitySnapshotForCurrentChannels(cached.visibility);
    setStatusMessage(`Applied ${kind} hidden-channel profile for "${targetPlaylist.name}".`);
  }

  function remove(id: string) {
    deletePlaylist(id);
    if (adultPlaylistId === id) {
      setAdultPlaylistId("");
      writeStorageItem(ADULT_PLAYLIST_ID_KEY, "");
    }
    if (childPlaylistId === id) {
      setChildPlaylistId("");
      writeStorageItem(CHILD_PLAYLIST_ID_KEY, "");
    }
    if (currentPlaylistId === id) {
      setCurrentPlaylistId("");
    }
    if (selectedPlaylistId === id) {
      setSelectedPlaylistId("");
    }
    if (activeRoleContext && ((activeRoleContext === "adult" && adultPlaylistId === id) || (activeRoleContext === "child" && childPlaylistId === id))) {
      setActiveRoleContext(null);
    }
    setPlaylists(loadPlaylists());
    setStatusMessage(`Deleted playlist "${id}".`);
  }

  async function loadPlaylistIntoApp(p: PlaylistEntry, roleToPersist: "adult" | "child" | null = null) {
    if (loadingId) return;
    const requestToken = loadRequestTokenRef.current + 1;
    loadRequestTokenRef.current = requestToken;

    setLoadingId(p.id);
    setStatusMessage(`Loading "${p.name}"… this can take up to a minute for large playlists.`);
    try {
      const channels = await loadChannelsForPlaylist(p);
      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;

      if (channels.length === 0) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setStatusMessage(`Indexing ${channels.length.toLocaleString()} entries…`);
      setCurrentPlaylistId(p.id);
      setSelectedPlaylistId(p.id);
      writeStorageItem(SHARED_PLAYLIST_ID_KEY, p.id);
      setChannels(channels, roleToPersist ? "playlist-manager-role-load" : "playlist-manager-generic-load");
      onPlaylistLoaded(channels, p.id);
      setStatusMessage(`Loaded ${channels.length.toLocaleString()} entries from "${p.name}". Fetching EPG…`);

      try {
        await loadEPGForPlaylist(p);
      } catch (epgErr) {
        console.warn("EPG load failed:", epgErr);
      }
      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;

      const visibility = getVisibilitySnapshotForChannelIds(channels.map((channel) => channel.id));

      const samePlaylistAssignedToBothRoles = adultPlaylistId === p.id && childPlaylistId === p.id;
      const persistAdult =
        roleToPersist === "adult" ||
        (roleToPersist === null && adultPlaylistId === p.id && !samePlaylistAssignedToBothRoles);
      const persistChild =
        roleToPersist === "child" ||
        (roleToPersist === null && childPlaylistId === p.id && !samePlaylistAssignedToBothRoles);

      if (persistAdult) {
        await writeRoleCache("adult", {
          playlistId: p.id,
          channels,
          visibility
        });
      }

      if (persistChild) {
        await writeRoleCache("child", {
          playlistId: p.id,
          channels,
          visibility
        });
      }

      setStatusMessage(`✓ Loaded ${channels.length.toLocaleString()} entries from "${p.name}".`);
    } catch (err) {
      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;
      const message = err instanceof Error ? err.message : "Unknown error";
      setStatusMessage(`✗ Failed to load "${p.name}": ${message}`);
    } finally {
      if (requestToken === loadRequestTokenRef.current) {
        setLoadingId(null);
      }
    }
  }

  return (
    <div className="side-panel">
      <h2>Playlist Manager</h2>

      <div className="playlist-manager-parental-actions">
        <button
          className={`btn-secondary btn-flex${activeRoleContext === "adult" ? " playlist-role-toggle-active" : ""}`}
          onClick={() => {
            void applyActiveRoleVisibility("adult");
          }}
        >
          Adult
        </button>
        <button
          className={`btn-secondary btn-flex${activeRoleContext === "child" ? " playlist-role-toggle-active" : ""}`}
          onClick={() => {
            void applyActiveRoleVisibility("child");
          }}
        >
          Child
        </button>
        <button
          className="btn-primary btn-flex"
          onClick={() => {
            void saveActiveRoleSnapshot();
          }}
        >
          {activeRoleContext ? `Save ${activeRoleContext === "adult" ? "Adult" : "Child"} Visibility` : "Save Visibility"}
        </button>
      </div>

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
        <div key={p.id} className={`playlist-card${selectedPlaylistId === p.id ? " playlist-role-active" : ""}`}>
          <strong>{p.name}</strong>
          <div className="playlist-item-type">
            Type: {p.type.toUpperCase()}
          </div>

          <div className="playlist-role-actions">
            <button
              className={`btn-secondary btn-flex${adultPlaylistId === p.id ? " playlist-role-active" : ""}`}
              disabled={loadingId !== null}
              onClick={() => setAdultPlaylist(p.id)}
            >
              {adultPlaylistId === p.id ? "Adult Assigned" : "Set Adult"}
            </button>
            <button
              className={`btn-secondary btn-flex${childPlaylistId === p.id ? " playlist-role-active" : ""}`}
              disabled={loadingId !== null}
              onClick={() => setChildPlaylist(p.id)}
            >
              {childPlaylistId === p.id ? "Child Assigned" : "Set Child"}
            </button>
          </div>

          <div className="playlist-actions playlist-actions-top-gap">
            <button
              className="btn-primary btn-flex"
              disabled={loadingId !== null}
              onClick={() => {
                void loadPlaylistIntoApp(p, null);
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
