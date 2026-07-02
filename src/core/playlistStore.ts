export type PlaylistType = "m3u" | "xtream" | "stalker";

export type PlaylistEntry = {
  id: string;
  name: string;
  type: PlaylistType;
  data: any;
};

const KEY = "iptvmate_playlists";
const LEGACY_KEY = "streambase_playlists";
const SESSION_KEY = "iptvmate_playlists_session";
const PLAYLISTS_DB = "iptvmate_playlists_cache";
const PLAYLISTS_STORE = "playlists";
const PLAYLISTS_RECORD_KEY = "latest";
let inMemoryPlaylists: PlaylistEntry[] = [];
let indexedDbHydrationStarted = false;
let playlistMutationRevision = 0;

function safeSetPlaylists(entries: PlaylistEntry[]) {
  playlistMutationRevision += 1;
  inMemoryPlaylists = [...entries];
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch (err) {
    // Keep runtime behavior working even when storage is blocked in a shell.
    console.warn("[playlistStore] Failed to persist playlists to localStorage.", err);
  }

  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(entries));
  } catch (err) {
    console.warn("[playlistStore] Failed to persist playlists to sessionStorage.", err);
  }

  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore legacy cleanup errors.
  }

  void savePlaylistsIndexedDb(entries);

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("playlistsChanged"));
  }
}

async function openPlaylistsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(PLAYLISTS_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
          db.createObjectStore(PLAYLISTS_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function savePlaylistsIndexedDb(entries: PlaylistEntry[]): Promise<void> {
  const db = await openPlaylistsDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(PLAYLISTS_STORE, "readwrite");
      tx.objectStore(PLAYLISTS_STORE).put(entries, PLAYLISTS_RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  db.close();
}

async function loadPlaylistsIndexedDb(): Promise<PlaylistEntry[]> {
  const db = await openPlaylistsDb();
  if (!db) return [];

  const result = await new Promise<PlaylistEntry[]>((resolve) => {
    try {
      const tx = db.transaction(PLAYLISTS_STORE, "readonly");
      const request = tx.objectStore(PLAYLISTS_STORE).get(PLAYLISTS_RECORD_KEY);
      request.onsuccess = () => {
        const value = request.result as unknown;
        if (!Array.isArray(value)) {
          resolve([]);
          return;
        }

        resolve(value.map(toPlaylistEntry).filter((entry): entry is PlaylistEntry => !!entry));
      };
      request.onerror = () => resolve([]);
      tx.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  db.close();
  return result;
}

function hydratePlaylistsFromIndexedDb() {
  if (indexedDbHydrationStarted) return;
  indexedDbHydrationStarted = true;
  const hydrationRevision = playlistMutationRevision;

  void (async () => {
    const indexedDbPlaylists = dedupePlaylists(await loadPlaylistsIndexedDb());
    if (indexedDbPlaylists.length === 0) return;
    if (hydrationRevision !== playlistMutationRevision) return;

    const current = readJsonArray(KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
    const legacy = readJsonArray(LEGACY_KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
    const mergedCurrent = dedupePlaylists([...current, ...legacy]);
    if (mergedCurrent.length > 0) return;

    if (hydrationRevision !== playlistMutationRevision) return;

    safeSetPlaylists(indexedDbPlaylists);
  })();
}

function normalizeType(rawType: unknown, rawSource: unknown): PlaylistType | null {
  const type = String(rawType || "").toLowerCase();
  const source = String(rawSource || "").toLowerCase();

  if (type === "m3u" || source === "m3u") return "m3u";
  if (type === "xtream" || source === "xtream") return "xtream";
  if (type === "stalker" || source === "stalker") return "stalker";
  return null;
}

function readJsonArray(key: string): unknown[] {
  if (key === KEY && inMemoryPlaylists.length > 0) {
    return [...inMemoryPlaylists];
  }

  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      if (key === KEY) {
        const sessionRaw = sessionStorage.getItem(SESSION_KEY);
        if (!sessionRaw) return [];
        const sessionParsed = JSON.parse(sessionRaw) as unknown;
        return Array.isArray(sessionParsed) ? sessionParsed : [];
      }
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    if (key === KEY) {
      try {
        const sessionRaw = sessionStorage.getItem(SESSION_KEY);
        if (!sessionRaw) return [];
        const sessionParsed = JSON.parse(sessionRaw) as unknown;
        return Array.isArray(sessionParsed) ? sessionParsed : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

function toPlaylistEntry(candidate: unknown): PlaylistEntry | null {
  if (!candidate || typeof candidate !== "object") return null;

  const obj = candidate as Record<string, unknown>;
  const details = (obj.details && typeof obj.details === "object")
    ? (obj.details as Record<string, unknown>)
    : null;
  const data = (obj.data && typeof obj.data === "object")
    ? (obj.data as Record<string, unknown>)
    : null;

  const normalizedType = normalizeType(obj.type, obj.source);
  if (!normalizedType) return null;

  const id = String(obj.id || Date.now());
  const name = String(obj.name || `Playlist ${id}`).trim() || `Playlist ${id}`;

  if (normalizedType === "xtream") {
    const url = String(
      data?.url ||
      details?.serverUrl ||
      details?.url ||
      ""
    ).trim();
    const user = String(
      data?.user ||
      data?.username ||
      details?.username ||
      ""
    ).trim();
    const pass = String(
      data?.pass ||
      data?.password ||
      details?.password ||
      ""
    ).trim();

    if (!url || !user || !pass) return null;
    return {
      id,
      name,
      type: "xtream",
      data: { url, user, pass }
    };
  }

  if (normalizedType === "m3u") {
    const url = String(
      data?.url ||
      details?.url ||
      details?.m3uUrl ||
      ""
    ).trim();
    const epg = String(
      data?.epg ||
      details?.epg ||
      details?.epgUrl ||
      ""
    ).trim();

    if (!url) return null;
    return {
      id,
      name,
      type: "m3u",
      data: { url, epg }
    };
  }

  const portal = String(
    data?.portal ||
    details?.portal ||
    details?.portalUrl ||
    ""
  ).trim();
  const mac = String(
    data?.mac ||
    details?.mac ||
    details?.macAddress ||
    ""
  ).trim();

  if (!portal || !mac) return null;
  return {
    id,
    name,
    type: "stalker",
    data: { portal, mac }
  };
}

function dedupePlaylists(entries: PlaylistEntry[]): PlaylistEntry[] {
  const seen = new Set<string>();
  const deduped: PlaylistEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.type}|${entry.name}|${JSON.stringify(entry.data)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

function migrateLegacyPlaylists(): PlaylistEntry[] {
  const parsed = readJsonArray(LEGACY_KEY);
  const migrated = dedupePlaylists(parsed.map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x));
  if (migrated.length > 0) {
    safeSetPlaylists(migrated);
  }
  return migrated;
}

export function loadPlaylists(): PlaylistEntry[] {
  hydratePlaylistsFromIndexedDb();

  const current = readJsonArray(KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
  const legacy = readJsonArray(LEGACY_KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
  const merged = dedupePlaylists([...current, ...legacy]);

  if (merged.length > 0) {
    safeSetPlaylists(merged);
    return merged;
  }

  return migrateLegacyPlaylists();
}

export function savePlaylist(entry: PlaylistEntry) {
  const all = loadPlaylists();
  all.push(entry);
  safeSetPlaylists(all);
}

export function updatePlaylist(id: string, updated: PlaylistEntry) {
  const all = loadPlaylists().map((p) => (p.id === id ? updated : p));
  safeSetPlaylists(all);
}

export function deletePlaylist(id: string) {
  const current = readJsonArray(KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x).filter((p) => p.id !== id);
  const legacy = readJsonArray(LEGACY_KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x).filter((p) => p.id !== id);
  const merged = dedupePlaylists([...current, ...legacy]);
  safeSetPlaylists(merged);
}
