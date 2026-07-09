/* @refresh reload */

import { useEffect, useRef, useState } from "react";
import {
  isPlaylistsHydrationPending,
  loadPlaylists,
  updatePlaylist,
  deletePlaylist,
  PlaylistEntry
} from "../core/playlistStore";
import {
  setChannels,
  Channel,
  getAllChannels,
  getVisibilitySnapshotForChannelIds,
  applyVisibilitySnapshotForCurrentChannels,
  setActiveVisibilityRole,
  saveRoleVisibility,
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

type PlaylistStorageDiagnostics = {
  parsed: number;
  primaryRawCount: number;
  sessionRawCount: number;
  legacyRawCount: number;
  storageKeysWithPlaylist: number;
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

function extractArrayCount(raw: string | null): number {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.playlists)) return obj.playlists.length;
      if (Array.isArray(obj.items)) return obj.items.length;
      if (Array.isArray(obj.entries)) return obj.entries.length;
    }
  } catch {
    // Ignore malformed values.
  }

  return 0;
}

function countStorageKeysContainingPlaylist(area: Storage | null): number {
  if (!area) return 0;

  const seen = new Set<string>();
  const length = Number(area.length || 0);

  for (let index = 0; index < length; index += 1) {
    const key = String(area.key(index) || "").trim();
    if (!key) continue;
    if (!key.toLowerCase().includes("playlist")) continue;
    seen.add(key);
  }

  return seen.size;
}

function readPlaylistStorageDiagnostics(parsedCount: number): PlaylistStorageDiagnostics {
  const primaryRaw = readStorageItem("iptvmate_playlists");
  const sessionRaw = readStorageItem("iptvmate_playlists_session");
  const legacyRaw = readStorageItem("streambase_playlists");

  let localKeys = 0;
  let sessionKeys = 0;

  try {
    localKeys = countStorageKeysContainingPlaylist(typeof localStorage !== "undefined" ? localStorage : null);
  } catch {
    localKeys = 0;
  }

  try {
    sessionKeys = countStorageKeysContainingPlaylist(typeof sessionStorage !== "undefined" ? sessionStorage : null);
  } catch {
    sessionKeys = 0;
  }

  return {
    parsed: parsedCount,
    primaryRawCount: extractArrayCount(primaryRaw),
    sessionRawCount: extractArrayCount(sessionRaw),
    legacyRawCount: extractArrayCount(legacyRaw),
    storageKeysWithPlaylist: localKeys + sessionKeys
  };
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
  onPlaylistLoadedWithId,
  activePlaylistId,
  onOpenAddPlaylist
}: {
  visible: boolean;
  onSelectContent: (content: "tv" | "movies" | "series") => void;
  onPlaylistLoadedWithId: (channels: any[], playlistId: string) => void;
  activePlaylistId: string;
  onOpenAddPlaylist?: () => void;
}) {
  const [playlists, setPlaylists] = useState<PlaylistEntry[]>([]);
  const [storageDiagnostics, setStorageDiagnostics] = useState<PlaylistStorageDiagnostics>({
    parsed: 0,
    primaryRawCount: 0,
    sessionRawCount: 0,
    legacyRawCount: 0,
    storageKeysWithPlaylist: 0
  });
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [activeRoleContext, setActiveRoleContext] = useState<"adult" | "child">("adult");
  const [currentPlaylistId, setCurrentPlaylistId] = useState<string>("");
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>("");
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editEpg, setEditEpg] = useState("");
  const [editUser, setEditUser] = useState("");
  const [editPass, setEditPass] = useState("");
  const [showEditPass, setShowEditPass] = useState(false);
  const [editPortal, setEditPortal] = useState("");
  const [editMac, setEditMac] = useState("");
  const loadRequestTokenRef = useRef(0);
  const visibleRef = useRef(visible);
  const playlistsRef = useRef<PlaylistEntry[]>([]);
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
    playlistsRef.current = playlists;
  }, [playlists]);

  useEffect(() => {
    if (!visible) return;
    // Default to adult visibility when the screen opens.
    setActiveRoleContext("adult");
    setActiveVisibilityRole("adult");

    const refresh = () => {
      const loaded = loadPlaylists();
      const hydrationPending = isPlaylistsHydrationPending();
      const effectiveLoaded =
        loaded.length === 0 && hydrationPending && playlistsRef.current.length > 0
          ? playlistsRef.current
          : loaded;

      playlistsRef.current = effectiveLoaded;
      setPlaylists(effectiveLoaded);
      setStorageDiagnostics(readPlaylistStorageDiagnostics(effectiveLoaded.length));
      return effectiveLoaded.length;
    };

    const scheduleRetryRefresh = (delaysMs: number[]) => {
      for (const delay of delaysMs) {
        window.setTimeout(() => {
          if (!visibleRef.current) return;
          refresh();
        }, delay);
      }
    };

    const initialCount = refresh();
    if (initialCount === 0) {
      // Electron storage hydration can complete slightly after first mount.
      scheduleRetryRefresh([150, 600, 1500]);
    }

    const onVisibilityChanged = () => {
      if (!visibleRef.current) return;
      if (document.visibilityState === "visible") {
        refresh();
      }
    };

    const onFocus = () => {
      if (!visibleRef.current) return;
      refresh();
    };

    window.addEventListener("playlistsChanged", refresh);
    window.addEventListener("playlistsHydrationComplete", refresh);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChanged);

    return () => {
      window.removeEventListener("playlistsChanged", refresh);
      window.removeEventListener("playlistsHydrationComplete", refresh);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChanged);
    };
  }, [visible]);

  useEffect(() => {
    // Role snapshots are intentionally not auto-persisted from visibility events.
    // Automatic writes can capture channels from a different loaded playlist and
    // poison role cache with stale/full-list content.
  }, [visible]);

  if (!visible) return null;

  function normalizeUrlInput(rawValue: string, fieldLabel: string) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      throw new Error(`${fieldLabel} is required.`);
    }

    if (/\s/.test(trimmed)) {
      throw new Error(`${fieldLabel} cannot contain spaces.`);
    }

    const withProtocol =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `http://${trimmed}`;

    try {
      const parsed = new URL(withProtocol);
      return parsed.toString();
    } catch {
      throw new Error(`${fieldLabel} is not a valid URL.`);
    }
  }

  function startEdit(playlist: PlaylistEntry) {
    setEditingPlaylistId(playlist.id);
    setEditName(String(playlist.name || ""));

    if (playlist.type === "m3u") {
      setEditUrl(String(playlist.data?.url || ""));
      setEditEpg(String(playlist.data?.epg || ""));
      setEditUser("");
      setEditPass("");
      setShowEditPass(false);
      setEditPortal("");
      setEditMac("");
      return;
    }

    if (playlist.type === "xtream") {
      setEditUrl(String(playlist.data?.url || ""));
      setEditUser(String(playlist.data?.user || ""));
      setEditPass(String(playlist.data?.pass || ""));
      setShowEditPass(false);
      setEditEpg("");
      setEditPortal("");
      setEditMac("");
      return;
    }

    setEditPortal(String(playlist.data?.portal || ""));
    setEditMac(String(playlist.data?.mac || ""));
    setEditUrl("");
    setEditEpg("");
    setEditUser("");
    setEditPass("");
    setShowEditPass(false);
  }

  function cancelEdit() {
    setEditingPlaylistId(null);
    setEditName("");
    setEditUrl("");
    setEditEpg("");
    setEditUser("");
    setEditPass("");
    setShowEditPass(false);
    setEditPortal("");
    setEditMac("");
  }

  function saveEdit(playlist: PlaylistEntry) {
    try {
      const nextName = String(editName || "").trim();
      if (!nextName) {
        throw new Error("Playlist name is required.");
      }

      let nextData: any = {};

      if (playlist.type === "m3u") {
        const url = normalizeUrlInput(editUrl, "M3U URL");
        const epg = String(editEpg || "").trim()
          ? normalizeUrlInput(editEpg, "EPG URL")
          : "";
        nextData = { url, epg };
      } else if (playlist.type === "xtream") {
        const url = normalizeUrlInput(editUrl, "Server URL");
        const user = String(editUser || "").trim();
        const pass = String(editPass || "").trim();
        if (!user || !pass) {
          throw new Error("Xtream username and password are required.");
        }
        nextData = { url, user, pass };
      } else {
        const portal = normalizeUrlInput(editPortal, "Portal URL");
        const mac = String(editMac || "").trim();
        if (!mac) {
          throw new Error("MAC address is required.");
        }
        nextData = { portal, mac };
      }

      updatePlaylist(playlist.id, {
        ...playlist,
        name: nextName,
        data: nextData
      });

      const loaded = loadPlaylists();
      playlistsRef.current = loaded;
      setPlaylists(loaded);
      setStorageDiagnostics(readPlaylistStorageDiagnostics(loaded.length));
      setStatusMessage(`Saved changes for "${nextName}".`);
      cancelEdit();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save playlist changes.";
      setStatusMessage(`✗ ${message}`);
    }
  }

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

    // Write to the protected saved-role key (never overwritten by playlist resets).
    saveRoleVisibility(kind);
    await persistRoleSnapshot(kind, targetPlaylist.id);
    setStatusMessage(`✓ Saved ${kind} visibility for "${targetPlaylist.name}".`);
  }

  async function applyActiveRoleVisibility(kind: "adult" | "child") {
    setActiveRoleContext(kind);
    setActiveVisibilityRole(kind);
    setStatusMessage(`Showing ${kind === "adult" ? "Adult" : "Child"} visibility. Edit checkmarks then press Save.`);
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
    if (activeRoleContext === "adult" && adultPlaylistId === id) {
      setActiveRoleContext("child");
    } else if (activeRoleContext === "child" && childPlaylistId === id) {
      setActiveRoleContext("adult");
    }
    const loaded = loadPlaylists();
    setPlaylists(loaded);
    setStorageDiagnostics(readPlaylistStorageDiagnostics(loaded.length));
    setStatusMessage(`Deleted playlist "${id}".`);
  }

  async function loadPlaylistIntoApp(p: PlaylistEntry, roleToPersist: "adult" | "child" | null = null) {
    if (loadingId) return;
    const requestToken = loadRequestTokenRef.current + 1;
    loadRequestTokenRef.current = requestToken;

    setLoadingId(p.id);
    setStatusMessage(`Loading "${p.name}"… this can take up to a minute for large playlists.`);
    try {
      let channels = await loadChannelsForPlaylist(p);
      const initialMovieCount = channels.filter(
        (channel) => String(channel?.contentType || "").toLowerCase() === "movie"
      ).length;
      let finalMovieStatus = `all=${initialMovieCount.toLocaleString()}`;
      let finalMovieError = "";

      const hasMovies = channels.some((channel) => String(channel?.contentType || "").toLowerCase() === "movie");
      if (!hasMovies && p.type === "xtream") {
        try {
          const movieChannels = await loadChannelsForPlaylist(p, "movies");
          if (Array.isArray(movieChannels) && movieChannels.length > 0) {
            const byId = new Map<string, Channel>();
            channels.forEach((channel) => byId.set(String(channel.id || ""), channel));
            movieChannels.forEach((channel) => byId.set(String(channel.id || ""), channel));
            channels = Array.from(byId.values());
          }
          const mergedMovieCount = channels.filter(
            (channel) => String(channel?.contentType || "").toLowerCase() === "movie"
          ).length;
          finalMovieStatus = `all=${initialMovieCount.toLocaleString()} backfill=${movieChannels.length.toLocaleString()} merged=${mergedMovieCount.toLocaleString()}`;
          if (movieChannels.length === 0) {
            finalMovieError = "movie scope returned 0 entries";
          }
          setStatusMessage(
            `Movie backfill: all=${initialMovieCount.toLocaleString()} movies=${movieChannels.length.toLocaleString()} merged=${mergedMovieCount.toLocaleString()}${movieChannels.length === 0 ? " error=movie scope returned 0 entries" : ""}`
          );
        } catch (movieErr) {
          const movieMessage = movieErr instanceof Error ? movieErr.message : "Unknown movie load error";
          finalMovieStatus = `all=${initialMovieCount.toLocaleString()} backfill=failed`;
          finalMovieError = movieMessage;
          setStatusMessage(`Movie backfill failed after all-load=${initialMovieCount.toLocaleString()}: ${movieMessage}`);
          // Keep the primary load result if movie backfill fails.
        }
      } else {
        finalMovieStatus = `all=${initialMovieCount.toLocaleString()}`;
        setStatusMessage(`Initial load: total=${channels.length.toLocaleString()} movies=${initialMovieCount.toLocaleString()}`);
      }

      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;

      if (channels.length === 0) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setStatusMessage(`Indexing ${channels.length.toLocaleString()} entries…`);
      setCurrentPlaylistId(p.id);
      setSelectedPlaylistId(p.id);
      writeStorageItem(SHARED_PLAYLIST_ID_KEY, p.id);
      setChannels(channels, roleToPersist ? "playlist-manager-role-load" : "playlist-manager-generic-load");
      onPlaylistLoadedWithId(channels, p.id);
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

      const finalMovieCount = channels.filter(
        (channel) => String(channel?.contentType || "").toLowerCase() === "movie"
      ).length;
      setStatusMessage(
        `${finalMovieError ? `Movie error=${finalMovieError} | ` : ""}✓ Loaded ${channels.length.toLocaleString()} entries from "${p.name}". Movies: ${finalMovieStatus} final=${finalMovieCount.toLocaleString()}`
      );
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

      <p className="playlist-diagnostics-text" aria-live="polite">
        Parsed: {storageDiagnostics.parsed} | raw main: {storageDiagnostics.primaryRawCount} | raw session: {storageDiagnostics.sessionRawCount} | raw legacy: {storageDiagnostics.legacyRawCount} | playlist keys: {storageDiagnostics.storageKeysWithPlaylist}
      </p>

      <div className="playlist-manager-parental-actions">
        <button
          className={`btn-secondary btn-flex${activeRoleContext === "adult" ? " playlist-role-toggle-active" : ""}`}
          onClick={() => { void applyActiveRoleVisibility("adult"); }}
        >
          Adult
        </button>
        <button
          className={`btn-secondary btn-flex${activeRoleContext === "child" ? " playlist-role-toggle-active" : ""}`}
          onClick={() => { void applyActiveRoleVisibility("child"); }}
        >
          Child
        </button>
        <button
          className="btn-primary btn-flex"
          onClick={() => { void saveActiveRoleSnapshot(); }}
        >
          Save {activeRoleContext === "child" ? "Child" : "Adult"} Visibility
        </button>
      </div>

      <div className="playlist-manager-actions">
        <button className="btn-primary btn-flex" onClick={() => onOpenAddPlaylist?.()}>
          Add Playlist
        </button>
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
          className={`playlist-status-banner${loadingId ? " playlist-status-banner-loading" : ""}`}
          role="status"
          aria-live="polite"
        >
          {loadingId && <span className="playlist-status-spinner">⏳</span>}
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
              onClick={() => { void loadPlaylistIntoApp(p, null); }}
            >
              {loadingId === p.id ? "Loading…" : "Load"}
            </button>

            <button
              className="btn-secondary btn-flex"
              disabled={loadingId !== null}
              onClick={() => startEdit(p)}
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

          {editingPlaylistId === p.id && (
            <div className="playlist-edit-form playlist-actions-top-gap">
              <strong aria-live="polite">Editing: {p.name}</strong>
              <label>Playlist name</label>
              <input
                type="text"
                placeholder="Playlist name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />

              {p.type === "m3u" && (
                <>
                  <label>M3U URL</label>
                  <input
                    type="text"
                    placeholder="M3U URL"
                    value={editUrl}
                    onChange={(event) => setEditUrl(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <label>EPG URL (optional)</label>
                  <input
                    type="text"
                    placeholder="EPG URL (optional)"
                    value={editEpg}
                    onChange={(event) => setEditEpg(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </>
              )}

              {p.type === "xtream" && (
                <>
                  <label>Server URL</label>
                  <input
                    type="text"
                    placeholder="Server URL"
                    value={editUrl}
                    onChange={(event) => setEditUrl(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <label>Username</label>
                  <input
                    type="text"
                    placeholder="Username"
                    value={editUser}
                    onChange={(event) => setEditUser(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <label>Password</label>
                  <div className="password-input-row">
                    <input
                      type={showEditPass ? "text" : "password"}
                      placeholder="Password"
                      value={editPass}
                      onChange={(event) => setEditPass(event.target.value)}
                      onKeyDown={(event) => event.stopPropagation()}
                    />
                    <button
                      type="button"
                      className="btn-secondary password-toggle-btn"
                      onClick={() => setShowEditPass((value) => !value)}
                    >
                      {showEditPass ? "Hide" : "Show"}
                    </button>
                  </div>
                </>
              )}

              {p.type === "stalker" && (
                <>
                  <label>Portal URL</label>
                  <input
                    type="text"
                    placeholder="Portal URL"
                    value={editPortal}
                    onChange={(event) => setEditPortal(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  <label>MAC Address</label>
                  <input
                    type="text"
                    placeholder="MAC Address"
                    value={editMac}
                    onChange={(event) => setEditMac(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </>
              )}

              <div className="playlist-edit-form-buttons">
                <button
                  className="btn-primary btn-flex"
                  disabled={loadingId !== null}
                  onClick={() => saveEdit(p)}
                >
                  Save Changes
                </button>
                <button
                  className="btn-secondary btn-flex"
                  disabled={loadingId !== null}
                  onClick={cancelEdit}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
