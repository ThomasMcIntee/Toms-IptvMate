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
const RECOVERY_PLAYLIST_URL = "recovery://cached-channels";
const RECOVERY_PLAYLIST_NAME = "recovered channels";
let inMemoryPlaylists: PlaylistEntry[] = [];
let indexedDbHydrationStarted = false;
let storageKeyRecoveryAttempted = false;
let playlistMutationRevision = 0;

function isRecoveryPlaylistUrl(value: string): boolean {
  return String(value || "").trim().toLowerCase().startsWith("recovery://");
}

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
      const normalizeEntries = (value: unknown): PlaylistEntry[] => {
        return extractPlaylistCollection(value)
          .map(toPlaylistEntry)
          .filter((entry): entry is PlaylistEntry => !!entry);
      };

      const primaryTx = db.transaction(PLAYLISTS_STORE, "readonly");
      const primaryRequest = primaryTx.objectStore(PLAYLISTS_STORE).get(PLAYLISTS_RECORD_KEY);

      primaryRequest.onsuccess = () => {
        const primaryEntries = normalizeEntries(primaryRequest.result as unknown);
        if (primaryEntries.length > 0) {
          resolve(primaryEntries);
          return;
        }

        // Compatibility fallback: older versions may have stored entries under
        // per-record keys instead of the single "latest" record.
        const fallbackTx = db.transaction(PLAYLISTS_STORE, "readonly");
        const cursorRequest = fallbackTx.objectStore(PLAYLISTS_STORE).openCursor();
        const recovered: PlaylistEntry[] = [];

        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            resolve(dedupePlaylists(recovered));
            return;
          }

          recovered.push(...normalizeEntries(cursor.value));
          cursor.continue();
        };

        cursorRequest.onerror = () => resolve(dedupePlaylists(recovered));
        fallbackTx.onerror = () => resolve(dedupePlaylists(recovered));
        fallbackTx.onabort = () => resolve(dedupePlaylists(recovered));
      };

      primaryRequest.onerror = () => resolve([]);
      primaryTx.onerror = () => resolve([]);
      primaryTx.onabort = () => resolve([]);
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
  if (
    type === "xtream" ||
    type === "xstream" ||
    type === "xc" ||
    source === "xtream" ||
    source === "xstream" ||
    source === "xc"
  ) {
    return "xtream";
  }
  if (type === "stalker" || type === "mag" || source === "stalker" || source === "mag") return "stalker";
  return null;
}

function readStringField(source: Record<string, unknown> | null, keys: string[]): string {
  if (!source) return "";

  const lowerLookup = new Map<string, unknown>();
  for (const [key, value] of Object.entries(source)) {
    lowerLookup.set(key.toLowerCase(), value);
  }

  for (const key of keys) {
    const value = lowerLookup.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return "";
}

function firstNonEmpty(values: string[]): string {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return "";
}

function inferTypeFromShape(candidate: Record<string, unknown>, details: Record<string, unknown> | null, data: Record<string, unknown> | null): PlaylistType | null {
  const rawUrl = firstNonEmpty([
    readStringField(data, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url"]),
    readStringField(details, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url"]),
    readStringField(candidate, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url", "server", "serverurl"])
  ]);

  const rawUser = firstNonEmpty([
    readStringField(data, ["user", "username", "login", "userid"]),
    readStringField(details, ["user", "username", "login", "userid"]),
    readStringField(candidate, ["user", "username", "login", "userid"])
  ]);

  const rawPass = firstNonEmpty([
    readStringField(data, ["pass", "password", "pwd", "passwd"]),
    readStringField(details, ["pass", "password", "pwd", "passwd"]),
    readStringField(candidate, ["pass", "password", "pwd", "passwd"])
  ]);

  const rawPortal = firstNonEmpty([
    readStringField(data, ["portal", "portalurl", "url", "server", "serverurl"]),
    readStringField(details, ["portal", "portalurl", "url", "server", "serverurl"]),
    readStringField(candidate, ["portal", "portalurl", "url", "server", "serverurl"])
  ]);

  const rawMac = firstNonEmpty([
    readStringField(data, ["mac", "macaddress", "stbmac"]),
    readStringField(details, ["mac", "macaddress", "stbmac"]),
    readStringField(candidate, ["mac", "macaddress", "stbmac"])
  ]);

  if (rawPortal && rawMac) return "stalker";
  if (rawUrl && rawUser && rawPass) return "xtream";
  if (rawUrl) return "m3u";
  return null;
}

function extractPlaylistCollection(parsed: unknown): unknown[] {
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      return extractPlaylistCollection(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;

  // Common wrapper payloads from previous app versions.
  const wrappedCandidates: unknown[] = [
    obj.playlists,
    obj.items,
    obj.entries,
    obj.data,
    obj.value,
    obj.result,
    (obj.payload && typeof obj.payload === "object") ? (obj.payload as Record<string, unknown>).playlists : null
  ];
  for (const candidate of wrappedCandidates) {
    const extracted = extractPlaylistCollection(candidate);
    if (extracted.length > 0) return extracted;
  }

  // Object map payloads: { "id": {...}, "id2": {...} }
  const values = Object.values(obj);
  if (
    values.length > 0 &&
    values.every((value) => value && typeof value === "object" && !Array.isArray(value))
  ) {
    return values;
  }

  if (values.length > 0 && values.every((_, index) => String(index) in obj)) {
    return values;
  }

  const looksLikeSinglePlaylistEntry = isLikelyPlaylistObject(obj);
  if (looksLikeSinglePlaylistEntry) {
    return [obj];
  }

  // Deep fallback for unknown legacy wrappers.
  const deepCandidates: unknown[] = [];
  collectNestedPlaylistCandidates(parsed, deepCandidates, 0, 6);
  if (deepCandidates.length > 0) {
    return deepCandidates;
  }

  return [];
}

function isLikelyPlaylistObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.type === "string" || typeof obj.playlistType === "string" || typeof obj.provider === "string") {
    return true;
  }

  if (typeof obj.url === "string" || typeof obj.portal === "string" || typeof obj.m3uUrl === "string") {
    return true;
  }

  const data = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : null;
  const details = obj.details && typeof obj.details === "object" ? (obj.details as Record<string, unknown>) : null;

  if (data) {
    if (
      typeof data.url === "string" ||
      typeof data.server === "string" ||
      typeof data.serverUrl === "string" ||
      typeof data.portal === "string" ||
      typeof data.portalUrl === "string"
    ) {
      return true;
    }
  }

  if (details) {
    if (
      typeof details.url === "string" ||
      typeof details.server === "string" ||
      typeof details.serverUrl === "string" ||
      typeof details.portal === "string" ||
      typeof details.portalUrl === "string"
    ) {
      return true;
    }
  }

  return false;
}

function collectNestedPlaylistCandidates(
  value: unknown,
  out: unknown[],
  depth: number,
  maxDepth: number
): void {
  if (depth > maxDepth || value === null || value === undefined) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return;
    try {
      collectNestedPlaylistCandidates(JSON.parse(trimmed), out, depth + 1, maxDepth);
    } catch {
      // Ignore non-JSON fragments.
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedPlaylistCandidates(item, out, depth + 1, maxDepth);
    }
    return;
  }

  if (typeof value !== "object") return;

  if (isLikelyPlaylistObject(value)) {
    out.push(value);
  }

  const obj = value as Record<string, unknown>;
  for (const nested of Object.values(obj)) {
    collectNestedPlaylistCandidates(nested, out, depth + 1, maxDepth);
  }
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
        return extractPlaylistCollection(sessionParsed);
      }
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return extractPlaylistCollection(parsed);
  } catch {
    if (key === KEY) {
      try {
        const sessionRaw = sessionStorage.getItem(SESSION_KEY);
        if (!sessionRaw) return [];
        const sessionParsed = JSON.parse(sessionRaw) as unknown;
        return extractPlaylistCollection(sessionParsed);
      } catch {
        return [];
      }
    }
    return [];
  }
}

function parseJsonSafely(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function collectPlaylistsFromStorageArea(area: Storage | null): PlaylistEntry[] {
  if (!area) return [];

  const recovered: PlaylistEntry[] = [];
  const length = Number(area.length || 0);

  for (let index = 0; index < length; index += 1) {
    const key = String(area.key(index) || "");
    if (!key) continue;

    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.includes("playlist")) continue;

    const parsed = parseJsonSafely(area.getItem(key));
    const entries = extractPlaylistCollection(parsed)
      .map(toPlaylistEntry)
      .filter((entry): entry is PlaylistEntry => !!entry);

    if (entries.length > 0) {
      recovered.push(...entries);
    }
  }

  return recovered;
}

function recoverPlaylistsFromAnyStorageKey(): PlaylistEntry[] {
  const fromLocal = collectPlaylistsFromStorageArea(typeof localStorage !== "undefined" ? localStorage : null);
  const fromSession = collectPlaylistsFromStorageArea(typeof sessionStorage !== "undefined" ? sessionStorage : null);
  return dedupePlaylists([...fromLocal, ...fromSession]);
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

  const normalizedType = normalizeType(
    firstNonEmpty([
      readStringField(obj, ["type", "playlisttype", "provider"]),
      String(obj.type ?? obj.playlistType ?? obj.provider ?? "")
    ]),
    firstNonEmpty([
      readStringField(obj, ["source", "kind", "mode"]),
      String(obj.source ?? obj.kind ?? obj.mode ?? "")
    ])
  ) || inferTypeFromShape(obj, details, data);
  if (!normalizedType) return null;

  const id = firstNonEmpty([
    readStringField(obj, ["id", "playlistid", "uuid", "key"]),
    String(obj.id || "")
  ]) || String(Date.now());
  const name = firstNonEmpty([
    readStringField(obj, ["name", "title", "playlistname", "label"]),
    String(obj.name || "")
  ]) || `Playlist ${id}`;

  if (name.trim().toLowerCase().includes(RECOVERY_PLAYLIST_NAME)) return null;

  if (normalizedType === "xtream") {
    const url = firstNonEmpty([
      readStringField(data, ["url", "server", "serverurl", "host"]),
      readStringField(details, ["url", "server", "serverurl", "host"]),
      readStringField(obj, ["url", "server", "serverurl", "host"])
    ]);
    const user = firstNonEmpty([
      readStringField(data, ["user", "username", "login", "userid"]),
      readStringField(details, ["user", "username", "login", "userid"]),
      readStringField(obj, ["user", "username", "login", "userid"])
    ]);
    const pass = firstNonEmpty([
      readStringField(data, ["pass", "password", "pwd", "passwd"]),
      readStringField(details, ["pass", "password", "pwd", "passwd"]),
      readStringField(obj, ["pass", "password", "pwd", "passwd"])
    ]);

    if (!url || !user || !pass) return null;
    return {
      id,
      name,
      type: "xtream",
      data: { url, user, pass }
    };
  }

  if (normalizedType === "m3u") {
    const url = firstNonEmpty([
      readStringField(data, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url"]),
      readStringField(details, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url"]),
      readStringField(obj, ["url", "m3u", "m3uurl", "playlisturl", "playlist", "link", "line", "path", "m3u_plus_url"])
    ]);
    const epg = firstNonEmpty([
      readStringField(data, ["epg", "epgurl", "xmltv", "xmltvurl"]),
      readStringField(details, ["epg", "epgurl", "xmltv", "xmltvurl"]),
      readStringField(obj, ["epg", "epgurl", "xmltv", "xmltvurl"])
    ]);

    if (!url || isRecoveryPlaylistUrl(url) || url.trim() === RECOVERY_PLAYLIST_URL) return null;
    return {
      id,
      name,
      type: "m3u",
      data: { url, epg }
    };
  }

  const portal = firstNonEmpty([
    readStringField(data, ["portal", "portalurl", "url", "server", "serverurl"]),
    readStringField(details, ["portal", "portalurl", "url", "server", "serverurl"]),
    readStringField(obj, ["portal", "portalurl", "url", "server", "serverurl"])
  ]);
  const mac = firstNonEmpty([
    readStringField(data, ["mac", "macaddress", "stbmac"]),
    readStringField(details, ["mac", "macaddress", "stbmac"]),
    readStringField(obj, ["mac", "macaddress", "stbmac"])
  ]);

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

  // One-time compatibility recovery for installs where playlists were saved
  // under provider/version-specific storage keys.
  if (!storageKeyRecoveryAttempted) {
    storageKeyRecoveryAttempted = true;
    const recovered = recoverPlaylistsFromAnyStorageKey();
    if (recovered.length > 0) {
      safeSetPlaylists(recovered);
      return recovered;
    }
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
