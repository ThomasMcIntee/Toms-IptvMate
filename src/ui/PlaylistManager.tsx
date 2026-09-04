/* @refresh reload */

import { useEffect, useRef, useState } from "react";
import {
  isPlaylistsHydrationPending,
  loadPlaylists,
  updatePlaylist,
  deletePlaylist,
  PlaylistEntry,
  sanitizePlaylistCatalog,
  type PlaylistCatalogTotals
} from "../core/playlistStore";
import {
  saveChannelsCacheMeta,
  setChannels,
  Channel,
  getAllChannels,
  getVisibilitySnapshot,
  getVisibilitySnapshotForChannelIds,
  applyVisibilitySnapshotForCurrentChannels,
  setActiveVisibilityRole,
  saveRoleVisibility,
  ChannelVisibilitySnapshot,
  ingestCapacitorLiveChannelCatalogAsync,
  getCapacitorLiveGroupCounts,
  getCapacitorLiveGroupNames,
  getCapacitorVodGroupNames,
  getCapacitorVodGroupCounts,
  loadCapacitorLiveGroupChannels
} from "../core/channelStore";
import { loadEPGForPlaylist } from "../core/loaders/epgLoader";
import { loadChannelsForPlaylist } from "../core/loaders/playlistLoader";
import { fetchXtreamAccountInfo, fetchXtreamCatalogTotals } from "../core/loaders/xtreamLoader";
import { loadEPGCache } from "../core/epgStore";
import { isCapacitorRuntime } from "../core/player/platformDetection";
import {
  formatXtreamAccountExpiry,
  isXtreamAccountExpired,
  resolveXtreamApiCredentials,
  type XtreamAccountInfo
} from "../core/xtreamAccount";

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
    if (!parsed) return null;

    // channels might be missing in localStorage to save space.
    const rawChannels = Array.isArray(parsed.channels) ? parsed.channels : [];
    const channels = rawChannels.map((item) => sanitizeChannel(item)).filter((item): item is Channel => !!item);

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
                : {},
            allGroupsHidden: parsed.visibility.allGroupsHidden === true,
            allMoviesHidden: parsed.visibility.allMoviesHidden === true,
            allSeriesHidden: parsed.visibility.allSeriesHidden === true
          }
        : undefined;

    if (isCapacitorRuntime() && channels.length === 0 && parsed.playlistId) {
      return {
        playlistId: String(parsed.playlistId || playlistId),
        channels: [],
        visibility
      };
    }

    if (channels.length === 0 && !visibility) return null;

    return {
      playlistId: String(parsed.playlistId || playlistId),
      channels,
      visibility
    };
  } catch {
    return null;
  }
}

function inferLoadedScopes(channels: Channel[]): Array<"live" | "movies" | "series"> {
  const scopes: Array<"live" | "movies" | "series"> = [];
  if (channels.some((channel) => String(channel?.contentType || "").toLowerCase() === "live")) scopes.push("live");
  if (channels.some((channel) => String(channel?.contentType || "").toLowerCase() === "movie")) scopes.push("movies");
  if (channels.some((channel) => String(channel?.contentType || "").toLowerCase() === "series")) scopes.push("series");
  return scopes;
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
        if (!value) {
          resolve(null);
          return;
        }

        if (isCapacitorRuntime()) {
          if (!value.visibility) {
            resolve(null);
            return;
          }
          resolve({
            playlistId: String(value.playlistId || playlistId),
            channels: [],
            visibility: value.visibility
          });
          return;
        }

        if (!Array.isArray(value.channels)) {
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
  const metaOnly = {
    playlistId: payload.playlistId,
    visibility: payload.visibility
  };
    try {
      writeStorageItem(roleCacheStorageKey(kind), JSON.stringify(metaOnly));
    } catch {
      // Quota or stringify failures must not fail the role save.
    }

  const db = await openRoleCacheDb();
  if (!db) return;

  const storedPayload: RoleCachePayload = isCapacitorRuntime()
    ? {
        playlistId: payload.playlistId,
        channels: [],
        visibility: payload.visibility
      }
    : payload;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(ROLE_CHANNELS_STORE, "readwrite");
      tx.objectStore(ROLE_CHANNELS_STORE).put(storedPayload, roleCacheDbKey(kind));
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
  if (fromLocal && (fromLocal.channels.length > 0 || fromLocal.visibility)) return fromLocal;
  return readRoleCacheFromDb(kind, playlistId);
}

export default function PlaylistManager({
  visible,
  onSelectContent,
  onPlaylistLoadedWithId,
  activePlaylistId,
  onOpenAddPlaylist,
  contentMode = "tv"
}: {
  visible: boolean;
  onSelectContent: (content: "tv" | "movies" | "series") => void;
  onPlaylistLoadedWithId: (channels: any[], playlistId: string) => void;
  activePlaylistId: string;
  onOpenAddPlaylist?: () => void;
  contentMode?: "tv" | "movies" | "series";
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

  function resolveSavePlaylistId(kind: "adult" | "child"): string {
    const listed = playlists.length > 0 ? playlists : loadPlaylists();
    const roleStored =
      kind === "child"
        ? childPlaylistId || readStorageItem(CHILD_PLAYLIST_ID_KEY) || ""
        : adultPlaylistId || readStorageItem(ADULT_PLAYLIST_ID_KEY) || "";
    return (
      activePlaylistId ||
      selectedPlaylistId ||
      currentPlaylistId ||
      roleStored ||
      readStorageItem(SHARED_PLAYLIST_ID_KEY) ||
      listed[0]?.id ||
      ""
    );
  }

  function findPlaylistById(id: string): PlaylistEntry | undefined {
    if (!id) return undefined;
    return playlists.find((playlist) => playlist.id === id) || loadPlaylists().find((playlist) => playlist.id === id);
  }

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
    // Default Adult/Child Save target, but do not replace live hide/show
    // with a role snapshot — that would wipe checkmarks on every open.
    setActiveRoleContext("adult");

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
    if (!visible) return;
    const listed = playlists.length > 0 ? playlists : loadPlaylists();
    const resolved =
      activePlaylistId ||
      selectedPlaylistId ||
      currentPlaylistId ||
      readStorageItem(SHARED_PLAYLIST_ID_KEY) ||
      adultPlaylistId ||
      childPlaylistId ||
      listed[0]?.id ||
      "";
    if (!resolved) return;
    if (!selectedPlaylistId) setSelectedPlaylistId(resolved);
    if (!currentPlaylistId) setCurrentPlaylistId(resolved);
  }, [visible, activePlaylistId, playlists, adultPlaylistId, childPlaylistId, selectedPlaylistId, currentPlaylistId]);

  const accountPlaylistId =
    activePlaylistId ||
    selectedPlaylistId ||
    currentPlaylistId ||
    adultPlaylistId ||
    childPlaylistId ||
    playlists[0]?.id ||
    "";
  const accountCredentials = resolveXtreamApiCredentials(
    playlists.find((entry) => entry.id === accountPlaylistId)
  );

  useEffect(() => {
    if (!visible || !accountPlaylistId || !accountCredentials) return;

    let cancelled = false;
    void fetchXtreamAccountInfo(
      accountCredentials.url,
      accountCredentials.user,
      accountCredentials.pass
    ).then((account) => {
      if (cancelled || !account) return;
      const latest = loadPlaylists().find((entry) => entry.id === accountPlaylistId);
      if (!latest) return;
      const current = latest.data?.account as XtreamAccountInfo | undefined;
      if (
        current &&
        current.maxConnections === account.maxConnections &&
        current.activeConnections === account.activeConnections &&
        current.expDateMs === account.expDateMs &&
        current.unlimited === account.unlimited &&
        current.status === account.status
      ) {
        return;
      }
      updatePlaylist(accountPlaylistId, {
        ...latest,
        data: { ...latest.data, account }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    visible,
    accountPlaylistId,
    accountCredentials?.url,
    accountCredentials?.user,
    accountCredentials?.pass
  ]);

  useEffect(() => {
    if (!visible || !accountPlaylistId) return;
    const stored = sanitizePlaylistCatalog(
      loadPlaylists().find((entry) => entry.id === accountPlaylistId)?.data?.catalog
    );
    const live = getLoadedCatalogTotals();
    if (live.total > 0 && !(stored && stored.total >= live.total)) {
      persistPlaylistCatalog(accountPlaylistId, live);
    }
    if (stored && stored.total > 0) return;
    if (live.total > 0) return;
    if (!accountCredentials) return;

    let cancelled = false;
    void fetchXtreamCatalogTotals(
      accountCredentials.url,
      accountCredentials.user,
      accountCredentials.pass
    ).then((catalog) => {
      if (cancelled || !catalog) return;
      persistPlaylistCatalog(accountPlaylistId, catalog);
    });

    return () => {
      cancelled = true;
    };
  }, [
    visible,
    accountPlaylistId,
    accountCredentials?.url,
    accountCredentials?.user,
    accountCredentials?.pass
  ]);

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
        const urlChanged = url !== String(playlist.data?.url || "");
        nextData = urlChanged
          ? { url, epg }
          : { url, epg, account: playlist.data?.account, catalog: playlist.data?.catalog };
      } else if (playlist.type === "xtream") {
        const url = normalizeUrlInput(editUrl, "Server URL");
        const user = String(editUser || "").trim();
        const pass = String(editPass || "").trim();
        if (!user || !pass) {
          throw new Error("Xtream username and password are required.");
        }
        const credentialsChanged =
          url !== String(playlist.data?.url || "") ||
          user !== String(playlist.data?.user || "") ||
          pass !== String(playlist.data?.pass || "");
        nextData = credentialsChanged
          ? { url, user, pass }
          : { url, user, pass, account: playlist.data?.account, catalog: playlist.data?.catalog };
      } else {
        const portal = normalizeUrlInput(editPortal, "Portal URL");
        const mac = String(editMac || "").trim();
        if (!mac) {
          throw new Error("MAC address is required.");
        }
        nextData = { portal, mac, catalog: playlist.data?.catalog };
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
    writeStorageItem(SHARED_PLAYLIST_ID_KEY, id);
  }

  function setChildPlaylist(id: string) {
    setChildPlaylistId(id);
    setSelectedPlaylistId(id);
    writeStorageItem(CHILD_PLAYLIST_ID_KEY, id);
    writeStorageItem(SHARED_PLAYLIST_ID_KEY, id);
  }

  async function persistRoleSnapshot(kind: "adult" | "child", playlistId: string) {
    const visibility = isCapacitorRuntime()
      ? getVisibilitySnapshot()
      : getVisibilitySnapshotForChannelIds(getAllChannels().map((channel) => channel.id));
    if (!visibility) return;

    await writeRoleCache(kind, {
      playlistId,
      channels: isCapacitorRuntime() ? [] : getAllChannels(),
      visibility
    });
  }

  async function saveActiveRoleSnapshot(kind: "adult" | "child" | null = activeRoleContext) {
    if (!kind) {
      alert("Select Adult or Child first.");
      return;
    }

    const targetPlaylistId = resolveSavePlaylistId(kind);
    if (!targetPlaylistId) {
      setStatusMessage("✗ Add a playlist first, then save visibility.");
      return;
    }

    const targetPlaylist = findPlaylistById(targetPlaylistId);
    const playlistName = targetPlaylist?.name || "playlist";

    try {
      if (kind === "adult") {
        setAdultPlaylistId(targetPlaylistId);
        writeStorageItem(ADULT_PLAYLIST_ID_KEY, targetPlaylistId);
      } else {
        setChildPlaylistId(targetPlaylistId);
        writeStorageItem(CHILD_PLAYLIST_ID_KEY, targetPlaylistId);
      }

      setSelectedPlaylistId(targetPlaylistId);
      setCurrentPlaylistId(targetPlaylistId);
      writeStorageItem(SHARED_PLAYLIST_ID_KEY, targetPlaylistId);

      // Write to the protected saved-role key (never overwritten by playlist resets).
      saveRoleVisibility(kind);
      await persistRoleSnapshot(kind, targetPlaylistId);
      setStatusMessage(`✓ Saved ${kind} visibility for "${playlistName}".`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save visibility.";
      setStatusMessage(`✗ ${message}`);
    }
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
    setStatusMessage(`Loading "${p.name}"… large playlists can take several minutes on Fire TV.`);
    try {
      const mergeChannelsById = (existingChannels: Channel[], incomingChannels: Channel[]) => {
        const byId = new Map<string, Channel>();
        existingChannels.forEach((channel) => byId.set(String(channel.id || ""), channel));
        incomingChannels.forEach((channel) => byId.set(String(channel.id || ""), channel));
        return Array.from(byId.values());
      };

      setStatusMessage(`Loading live channels from "${p.name}"…`);
      let channels: Channel[] = [];
      let movieChannels: Channel[] = [];
      let seriesChannels: Channel[] = [];
      let finalMovieError = "";
      let finalSeriesError = "";

      if (p.type === "xtream") {
        // Fire TV: do not stream per-category names into React state. Each
        // update re-renders Playlist Manager and stalls the load. webOS/desktop
        // have no Capacitor IDB ingest, so they must keep the returned arrays.
        const reportProgress = isCapacitorRuntime() ? undefined : setStatusMessage;
        const liveChannels = await loadChannelsForPlaylist(p, "live", reportProgress);
        channels = isCapacitorRuntime() ? [] : liveChannels;
        if (!isCapacitorRuntime()) {
          setStatusMessage(`Loaded ${channels.length.toLocaleString()} live channels from "${p.name}". Loading movies…`);
        } else {
          setStatusMessage(`Loading movies from "${p.name}"…`);
        }
        try {
          const loadedMovies = await loadChannelsForPlaylist(p, "movies", reportProgress);
          movieChannels = isCapacitorRuntime() ? [] : loadedMovies;
        } catch (movieErr) {
          finalMovieError = movieErr instanceof Error ? movieErr.message : "Unknown movie load error";
          setStatusMessage(`Movie load failed: ${finalMovieError}`);
        }

        setStatusMessage(`Loading series from "${p.name}"…`);
        try {
          const loadedSeries = await loadChannelsForPlaylist(p, "series", reportProgress);
          seriesChannels = isCapacitorRuntime() ? [] : loadedSeries;
        } catch (seriesErr) {
          finalSeriesError = seriesErr instanceof Error ? seriesErr.message : "Unknown series load error";
          setStatusMessage(`Series load failed: ${finalSeriesError}`);
        }
      } else {
        channels = await loadChannelsForPlaylist(p, "all");
        movieChannels = channels.filter(
          (channel) => String(channel?.contentType || "").toLowerCase() === "movie"
        );
        seriesChannels = channels.filter(
          (channel) => String(channel?.contentType || "").toLowerCase() === "series"
        );
      }

      if (!isCapacitorRuntime()) {
        channels = mergeChannelsById(mergeChannelsById(channels, movieChannels), seriesChannels);
      }

      const liveGroupNames = isCapacitorRuntime() ? getCapacitorLiveGroupNames() : [];
      const liveGroupCount = liveGroupNames.length;
      const liveTitleCount = isCapacitorRuntime()
        ? Object.values(getCapacitorLiveGroupCounts()).reduce((sum, count) => sum + count, 0)
        : channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "live").length;
      const movieCount = isCapacitorRuntime()
        ? getCapacitorVodGroupNames("movies").length
        : channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "movie").length;
      const seriesCount = isCapacitorRuntime()
        ? getCapacitorVodGroupNames("series").length
        : channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "series").length;

      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;

      if (
        channels.length === 0 &&
        liveGroupCount === 0 &&
        movieCount === 0 &&
        seriesCount === 0
      ) {
        throw new Error("Zero channels added. Check playlist URL/credentials and provider response.");
      }

      setStatusMessage(
        isCapacitorRuntime()
          ? `Indexing live=${liveGroupCount.toLocaleString()} groups (${liveTitleCount.toLocaleString()} titles) movies=${movieCount.toLocaleString()} series=${seriesCount.toLocaleString()}…`
          : `Indexing live=${channels.length.toLocaleString()} movies=${movieCount.toLocaleString()} series=${seriesCount.toLocaleString()}…`
      );
      setCurrentPlaylistId(p.id);
      setSelectedPlaylistId(p.id);
      writeStorageItem(SHARED_PLAYLIST_ID_KEY, p.id);

      let loadedForUi = channels;
      if (isCapacitorRuntime()) {
        if (liveGroupNames.length > 0) {
          // Per-category Xtream persist already wrote every live group to IDB.
          // Re-ingesting the preview array would wipe that catalog down to one group.
          await loadCapacitorLiveGroupChannels(liveGroupNames[0]);
          loadedForUi = getAllChannels();
        } else if (channels.length > 0) {
          const defaultGroup =
            channels.find((channel) => String(channel?.contentType || "").toLowerCase() === "live")?.group ||
            channels[0]?.group ||
            "Uncategorized";
          await ingestCapacitorLiveChannelCatalogAsync(channels, String(defaultGroup));
          loadedForUi = getAllChannels();
          channels.length = 0;
        }
      } else {
        setChannels(channels, roleToPersist ? "playlist-manager-role-load" : "playlist-manager-generic-load");
      }

      const loadedScopes: Array<"live" | "movies" | "series"> = [];
      if (channels.length > 0 || loadedForUi.length > 0 || liveGroupCount > 0) loadedScopes.push("live");
      if (movieCount > 0) loadedScopes.push("movies");
      if (seriesCount > 0) loadedScopes.push("series");
      saveChannelsCacheMeta({
        playlistId: p.id,
        scopes: loadedScopes.length > 0 ? loadedScopes : inferLoadedScopes(loadedForUi),
        updatedAt: Date.now()
      });
      onPlaylistLoadedWithId(loadedForUi, p.id);
      setStatusMessage(
        isCapacitorRuntime()
          ? `Loaded "${p.name}". Fetching EPG…`
          : `Loaded ${loadedForUi.length.toLocaleString()} entries from "${p.name}". Fetching EPG…`
      );

      try {
        if (isCapacitorRuntime() && (channels.length > 3000 || liveGroupCount > 0)) {
          void loadEPGForPlaylist(p).catch((epgErr) => {
            console.warn("EPG load failed:", epgErr);
          });
        } else {
          await loadEPGForPlaylist(p);
        }
      } catch (epgErr) {
        console.warn("EPG load failed:", epgErr);
      }
      if (requestToken !== loadRequestTokenRef.current || !visibleRef.current) return;

      const visibility = getVisibilitySnapshot();

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
          channels: isCapacitorRuntime() ? [] : loadedForUi,
          visibility
        });
      }

      if (persistChild) {
        await writeRoleCache("child", {
          playlistId: p.id,
          channels: isCapacitorRuntime() ? [] : loadedForUi,
          visibility
        });
      }

      const movieGroupCount = isCapacitorRuntime() ? getCapacitorVodGroupNames("movies").length : 0;
      const seriesGroupCount = isCapacitorRuntime() ? getCapacitorVodGroupNames("series").length : 0;
      const finalLiveGroupCount = isCapacitorRuntime() ? getCapacitorLiveGroupNames().length : liveGroupCount;
      const finalLiveTitleCount = isCapacitorRuntime()
        ? Object.values(getCapacitorLiveGroupCounts()).reduce((sum, count) => sum + count, 0)
        : liveTitleCount;
      const finalMovieCount = isCapacitorRuntime()
        ? movieGroupCount
        : loadedForUi.filter(
        (channel) => String(channel?.contentType || "").toLowerCase() === "movie"
      ).length;
      const finalSeriesCount = isCapacitorRuntime()
        ? seriesGroupCount
        : loadedForUi.filter(
        (channel) => String(channel?.contentType || "").toLowerCase() === "series"
      ).length;
      setStatusMessage(
        isCapacitorRuntime()
          ? `✓ Loaded "${p.name}". Live ${finalLiveGroupCount.toLocaleString()} groups (${finalLiveTitleCount.toLocaleString()} titles), ${movieGroupCount.toLocaleString()} movie categories, ${seriesGroupCount.toLocaleString()} series categories.`
          : `${finalMovieError ? `Movie error=${finalMovieError} | ` : ""}${finalSeriesError ? `Series error=${finalSeriesError} | ` : ""}✓ Loaded ${loadedForUi.length.toLocaleString()} entries from "${p.name}". Movies: ${finalMovieCount.toLocaleString()} | Series: ${finalSeriesCount.toLocaleString()}`
      );
      persistPlaylistCatalog(p.id, {
        live: finalLiveTitleCount,
        movies: isCapacitorRuntime()
          ? sumCountMap(getCapacitorVodGroupCounts("movies"))
          : finalMovieCount,
        series: isCapacitorRuntime()
          ? sumCountMap(getCapacitorVodGroupCounts("series"))
          : finalSeriesCount,
        total: isCapacitorRuntime()
          ? finalLiveTitleCount +
            sumCountMap(getCapacitorVodGroupCounts("movies")) +
            sumCountMap(getCapacitorVodGroupCounts("series"))
          : loadedForUi.length
      });
      void refreshAndPersistXtreamAccount(p);
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

  const loadedPlaylistId =
    activePlaylistId ||
    selectedPlaylistId ||
    currentPlaylistId ||
    adultPlaylistId ||
    childPlaylistId ||
    playlists[0]?.id ||
    "";
  const loadedPlaylist = playlists.find((playlist) => playlist.id === loadedPlaylistId);

  return (
    <div className="side-panel">
      <div className="playlist-manager-chrome">
      <h2>Playlist Manager</h2>

      <p className="playlist-loaded-summary" aria-live="polite">
        Loaded playlist: <strong>{loadedPlaylist?.name || "None"}</strong>
        <PlaylistAccountLine
          catalog={resolvePlaylistCatalog(loadedPlaylist, loadedPlaylistId === activePlaylistId || loadedPlaylistId === currentPlaylistId)}
          account={loadedPlaylist?.data?.account}
          block
        />
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
          className="btn-primary btn-flex playlist-manager-save-btn"
          onClick={() => { void saveActiveRoleSnapshot(); }}
        >
          Save {activeRoleContext === "child" ? "Child" : "Adult"} Visibility
        </button>
      </div>
      <p className="playlist-loaded-summary">
        Load a playlist here. Hide or show categories, then Live TV / Movies / Series open instantly from this save — they do not download again until you press Load.
      </p>

      <div className="playlist-manager-actions">
        <button className="btn-secondary btn-flex" onClick={() => onOpenAddPlaylist?.()}>
          Add Playlist
        </button>
        <button
          className={`btn-secondary btn-flex${contentMode === "tv" ? " playlist-mode-active" : ""}`}
          onClick={() => onSelectContent("tv")}
        >
          Live TV
        </button>
        <button
          className={`btn-secondary btn-flex${contentMode === "movies" ? " playlist-mode-active" : ""}`}
          onClick={() => onSelectContent("movies")}
        >
          Movies
        </button>
        <button
          className={`btn-secondary btn-flex${contentMode === "series" ? " playlist-mode-active" : ""}`}
          onClick={() => onSelectContent("series")}
        >
          Series
        </button>
      </div>
      </div>

      {playlists.length === 0 && <p>No playlists added yet.</p>}

      {statusMessage && (
        <div
          className={`playlist-status-banner${loadingId ? " playlist-status-banner-loading" : ""}`}
          role="status"
          aria-live={loadingId && isCapacitorRuntime() ? "off" : "polite"}
        >
          {loadingId && <span className="playlist-status-spinner">⏳</span>}
          {statusMessage}
        </div>
      )}

      {playlists.map((p) => (
        <div
          key={p.id}
          className={`playlist-card${selectedPlaylistId === p.id ? " playlist-role-active" : ""}${loadedPlaylistId === p.id ? " playlist-card-loaded" : ""}`}
        >
          <div className="playlist-header">
            <strong>{p.name}</strong>
            {loadedPlaylistId === p.id && <span className="playlist-loaded-badge">Loaded</span>}
          </div>
          <div className="playlist-item-type">
            Type: {p.type.toUpperCase()}
          </div>
          {loadedPlaylistId === p.id && (
            <PlaylistAccountLine
              catalog={resolvePlaylistCatalog(p, p.id === activePlaylistId || p.id === currentPlaylistId)}
              account={p.data?.account}
              block
            />
          )}

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
              {loadingId === p.id ? "Loading…" : activePlaylistId === p.id ? "Reload" : "Load"}
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

function PlaylistAccountLine({
  catalog,
  account,
  block = false
}: {
  catalog?: PlaylistCatalogTotals | null;
  account?: XtreamAccountInfo | null;
  block?: boolean;
}) {
  const total = catalog && catalog.total > 0 ? catalog.total.toLocaleString() : null;
  const expiry = account ? formatXtreamAccountExpiry(account) : null;
  if (!total && !expiry) return null;
  const expired = account ? isXtreamAccountExpired(account) : false;

  return (
    <span
      className={`playlist-account-meta${block ? " playlist-account-meta-block" : ""}${expired ? " playlist-account-meta-expired" : ""}`}
    >
      {total ? <>Total: {total}</> : null}
      {total && expiry ? " · " : null}
      {expiry ? <>Expiry: {expiry}</> : null}
    </span>
  );
}

function sumCountMap(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0);
}

function getLoadedCatalogTotals(): PlaylistCatalogTotals {
  if (isCapacitorRuntime()) {
    const live = sumCountMap(getCapacitorLiveGroupCounts());
    const movies = sumCountMap(getCapacitorVodGroupCounts("movies"));
    const series = sumCountMap(getCapacitorVodGroupCounts("series"));
    return { live, movies, series, total: live + movies + series };
  }

  const channels = getAllChannels();
  const live = channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "live").length;
  const movies = channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "movie").length;
  const series = channels.filter((channel) => String(channel?.contentType || "").toLowerCase() === "series").length;
  return {
    live,
    movies,
    series,
    total: channels.length
  };
}

function resolvePlaylistCatalog(
  playlist: PlaylistEntry | undefined,
  isCurrentlyLoaded: boolean
): PlaylistCatalogTotals | null {
  const stored = sanitizePlaylistCatalog(playlist?.data?.catalog);
  if (stored && stored.total > 0) return stored;
  if (!isCurrentlyLoaded) return stored || null;
  const live = getLoadedCatalogTotals();
  return live.total > 0 ? live : stored || null;
}

function persistPlaylistCatalog(playlistId: string, catalog: PlaylistCatalogTotals) {
  const sanitized = sanitizePlaylistCatalog(catalog);
  if (!sanitized) return;
  const latest = loadPlaylists().find((entry) => entry.id === playlistId);
  if (!latest) return;
  const current = sanitizePlaylistCatalog(latest.data?.catalog);
  if (
    current &&
    current.total === sanitized.total &&
    current.live === sanitized.live &&
    current.movies === sanitized.movies &&
    current.series === sanitized.series
  ) {
    return;
  }
  updatePlaylist(playlistId, {
    ...latest,
    data: { ...latest.data, catalog: sanitized }
  });
}

async function refreshAndPersistXtreamAccount(playlist: PlaylistEntry) {
  const credentials = resolveXtreamApiCredentials(playlist);
  if (!credentials) return;
  const account = await fetchXtreamAccountInfo(credentials.url, credentials.user, credentials.pass);
  if (!account) return;
  const latest = loadPlaylists().find((entry) => entry.id === playlist.id);
  if (!latest) return;
  const current = latest.data?.account as XtreamAccountInfo | undefined;
  if (
    current &&
    current.maxConnections === account.maxConnections &&
    current.activeConnections === account.activeConnections &&
    current.expDateMs === account.expDateMs &&
    current.unlimited === account.unlimited &&
    current.status === account.status
  ) {
    return;
  }
  updatePlaylist(playlist.id, {
    ...latest,
    data: { ...latest.data, account }
  });
}
