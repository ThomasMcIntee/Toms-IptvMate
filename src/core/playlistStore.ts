export type PlaylistType = "m3u" | "xtream" | "stalker";

export type PlaylistEntry = {
  id: string;
  name: string;
  type: PlaylistType;
  data: any;
};

export type PlaylistBridgeStatus = {
  attempts: number;
  inFlight: boolean;
  lastOrigin: string;
  lastImportedCount: number;
  lastError: string;
  lastAttemptAt: number;
  lastSuccessAt: number;
};

const KEY = "iptvmate_playlists";
const LEGACY_KEY = "streambase_playlists";
const SESSION_KEY = "iptvmate_playlists_session";
const PLAYLISTS_DB = "iptvmate_playlists_cache";
const PLAYLISTS_STORE = "playlists";
const PLAYLISTS_RECORD_KEY = "latest";
const PLAYLISTS_DB_OPEN_TIMEOUT_MS = 1500;
const PLAYLISTS_DB_LOAD_TIMEOUT_MS = 1800;
const PLAYLIST_BRIDGE_TIMEOUT_MS = 3200;
const DEV_PLAYLIST_BRIDGE_RETRY_COOLDOWN_MS = 2000;
const DEV_PLAYLIST_BRIDGE_MAX_ATTEMPTS = 6;
const DEV_PLAYLIST_BRIDGE_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
  "http://localhost:40000",
  "http://127.0.0.1:40000",
  "http://localhost:5137",
  "http://127.0.0.1:5137",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173"
];
const RECOVERY_PLAYLIST_URL = "recovery://cached-channels";
const RECOVERY_PLAYLIST_NAME = "recovered channels";
const WINDOW_NAME_PLAYLIST_PREFIX = "iptvmate_playlists=";
let inMemoryPlaylists: PlaylistEntry[] = [];
let indexedDbHydrationStarted = false;
let indexedDbHydrationCompleted = false;
let storageKeyRecoveryAttempted = false;
let crossOriginImportAttempts = 0;
let crossOriginImportInFlight = false;
let crossOriginImportLastAttemptAt = 0;
let playlistMutationRevision = 0;
let playlistBridgeStatus: PlaylistBridgeStatus = {
  attempts: 0,
  inFlight: false,
  lastOrigin: "",
  lastImportedCount: 0,
  lastError: "",
  lastAttemptAt: 0,
  lastSuccessAt: 0
};

function updatePlaylistBridgeStatus(patch: Partial<PlaylistBridgeStatus>): void {
  playlistBridgeStatus = {
    ...playlistBridgeStatus,
    ...patch
  };
  dispatchPlaylistStoreEvent("playlistsBridgeStatus");
}

export function getPlaylistBridgeStatus(): PlaylistBridgeStatus {
  return { ...playlistBridgeStatus };
}

function isLocalDevOrigin(value: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(value || ""));
}

async function requestPlaylistsFromOrigin(origin: string): Promise<PlaylistEntry[]> {
  if (typeof window === "undefined" || typeof document === "undefined") return [];

  updatePlaylistBridgeStatus({
    lastOrigin: origin,
    lastError: "",
    lastImportedCount: 0
  });

  return new Promise((resolve) => {
    let settled = false;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = `${origin}/`;

    const finish = (entries: PlaylistEntry[]) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      try {
        iframe.remove();
      } catch {
        // Ignore iframe cleanup failures.
      }
      resolve(entries);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const payload = event.data as {
        type?: unknown;
        requestId?: unknown;
        playlists?: unknown;
      };
      if (!payload || payload.type !== "iptvmate:response-playlists") return;
      if (String(payload.requestId || "") !== requestId) return;

      const imported = dedupePlaylists(
        extractPlaylistCollection(payload.playlists)
          .map(toPlaylistEntry)
          .filter((entry): entry is PlaylistEntry => !!entry)
      );
      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastImportedCount: imported.length,
        lastError: imported.length > 0 ? "" : "origin responded with 0 playlists"
      });
      finish(imported);
    };

    const timeout = window.setTimeout(() => {
      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastError: `timeout after ${PLAYLIST_BRIDGE_TIMEOUT_MS}ms`
      });
      finish([]);
    }, PLAYLIST_BRIDGE_TIMEOUT_MS);

    window.addEventListener("message", onMessage);

    iframe.onload = () => {
      try {
        iframe.contentWindow?.postMessage(
          {
            type: "iptvmate:request-playlists",
            requestId
          },
          origin
        );
      } catch {
        finish([]);
      }
    };

    iframe.onerror = () => {
      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastError: "iframe load failed"
      });
      finish([]);
    };

    try {
      (document.body || document.documentElement).appendChild(iframe);
    } catch {
      finish([]);
    }
  });
}

async function requestPlaylistsFromOriginPopup(origin: string): Promise<PlaylistEntry[]> {
  if (typeof window === "undefined") return [];

  const currentOrigin = String(window.location?.origin || "");
  if (!currentOrigin) return [];

  return new Promise((resolve) => {
    let settled = false;
    const requestId = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const exportUrl = `${origin}/?iptvmate_export_target=${encodeURIComponent(currentOrigin)}&iptvmate_export_request=${encodeURIComponent(requestId)}`;
    const popup = window.open(exportUrl, "iptvmate-playlist-export", "width=560,height=560,noopener=no,noreferrer=no");

    const finish = (entries: PlaylistEntry[]) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      try {
        popup?.close();
      } catch {
        // Ignore popup close failures.
      }
      resolve(entries);
    };

    if (!popup) {
      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastError: "popup blocked by browser"
      });
      finish([]);
      return;
    }

    updatePlaylistBridgeStatus({
      lastOrigin: origin,
      lastError: "",
      lastImportedCount: 0
    });

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      const payload = event.data as {
        type?: unknown;
        requestId?: unknown;
        playlists?: unknown;
      };
      if (!payload || payload.type !== "iptvmate:popup-playlists") return;
      if (String(payload.requestId || "") !== requestId) return;

      const imported = dedupePlaylists(
        extractPlaylistCollection(payload.playlists)
          .map(toPlaylistEntry)
          .filter((entry): entry is PlaylistEntry => !!entry)
      );

      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastImportedCount: imported.length,
        lastError: imported.length > 0 ? "" : "popup responded with 0 playlists"
      });
      finish(imported);
    };

    const timeout = window.setTimeout(() => {
      updatePlaylistBridgeStatus({
        lastOrigin: origin,
        lastError: "popup import timeout"
      });
      finish([]);
    }, 9000);

    window.addEventListener("message", onMessage);
  });
}

function tryImportPlaylistsFromDevOrigins() {
  if (crossOriginImportInFlight) return;
  if (typeof window === "undefined") return;

  const currentOrigin = String(window.location?.origin || "");
  if (!isLocalDevOrigin(currentOrigin)) return;
  if (crossOriginImportAttempts >= DEV_PLAYLIST_BRIDGE_MAX_ATTEMPTS) return;

  const now = Date.now();
  if (now - crossOriginImportLastAttemptAt < DEV_PLAYLIST_BRIDGE_RETRY_COOLDOWN_MS) return;

  crossOriginImportInFlight = true;
  crossOriginImportAttempts += 1;
  crossOriginImportLastAttemptAt = now;
  updatePlaylistBridgeStatus({
    attempts: crossOriginImportAttempts,
    inFlight: true,
    lastAttemptAt: now,
    lastError: ""
  });

  const candidates = DEV_PLAYLIST_BRIDGE_ORIGINS.filter((origin) => origin !== currentOrigin);
  if (candidates.length === 0) {
    crossOriginImportInFlight = false;
    updatePlaylistBridgeStatus({
      inFlight: false,
      lastError: "no bridge origin candidates"
    });
    return;
  }

  void (async () => {
    try {
      for (const origin of candidates) {
        const imported = await requestPlaylistsFromOrigin(origin);
        if (imported.length === 0) continue;

        safeSetPlaylists(imported, true);
        updatePlaylistBridgeStatus({
          inFlight: false,
          lastOrigin: origin,
          lastImportedCount: imported.length,
          lastSuccessAt: Date.now(),
          lastError: ""
        });
        return;
      }
      updatePlaylistBridgeStatus({
        inFlight: false,
        lastImportedCount: 0,
        lastError: "all bridge origins returned no playlists"
      });
    } finally {
      crossOriginImportInFlight = false;
      updatePlaylistBridgeStatus({
        inFlight: false
      });
    }
  })();
}

export async function forceImportPlaylistsFromDevOrigins(): Promise<number> {
  if (crossOriginImportInFlight) return 0;
  if (typeof window === "undefined") return 0;

  const currentOrigin = String(window.location?.origin || "");
  if (!isLocalDevOrigin(currentOrigin)) return 0;

  crossOriginImportInFlight = true;
  crossOriginImportAttempts += 1;
  crossOriginImportLastAttemptAt = Date.now();
  updatePlaylistBridgeStatus({
    attempts: crossOriginImportAttempts,
    inFlight: true,
    lastAttemptAt: crossOriginImportLastAttemptAt,
    lastError: ""
  });

  const candidates = DEV_PLAYLIST_BRIDGE_ORIGINS.filter((origin) => origin !== currentOrigin);
  if (candidates.length === 0) {
    crossOriginImportInFlight = false;
    updatePlaylistBridgeStatus({
      inFlight: false,
      lastError: "no bridge origin candidates"
    });
    return 0;
  }

  try {
    for (const origin of candidates) {
      const imported = await requestPlaylistsFromOrigin(origin);
      const resolved = imported.length > 0 ? imported : await requestPlaylistsFromOriginPopup(origin);
      if (resolved.length === 0) continue;

      safeSetPlaylists(resolved, true);
      updatePlaylistBridgeStatus({
        inFlight: false,
        lastOrigin: origin,
        lastImportedCount: resolved.length,
        lastSuccessAt: Date.now(),
        lastError: ""
      });
      return resolved.length;
    }

    updatePlaylistBridgeStatus({
      inFlight: false,
      lastImportedCount: 0,
      lastError: "all bridge origins returned no playlists"
    });
    return 0;
  } finally {
    crossOriginImportInFlight = false;
    updatePlaylistBridgeStatus({
      inFlight: false
    });
  }
}

function dispatchPlaylistStoreEvent(name: string): void {
  if (typeof window === "undefined") return;

  try {
    if (typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent(name));
      return;
    }
  } catch {
    // Fall through to legacy event creation.
  }

  try {
    const legacyEvent = document.createEvent("CustomEvent");
    legacyEvent.initCustomEvent(name, false, false, undefined);
    window.dispatchEvent(legacyEvent);
  } catch {
    // Keep dispatch best-effort so playlist persistence still works.
  }
}

function isRecoveryPlaylistUrl(value: string): boolean {
  return String(value || "").trim().toLowerCase().startsWith("recovery://");
}

function safeSetPlaylists(entries: PlaylistEntry[], emitChangeEvent = true) {
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

  try {
    writePlaylistsToWindowName(entries);
  } catch {
    // Ignore window.name fallback errors.
  }

  void savePlaylistsIndexedDb(entries);

  if (emitChangeEvent) {
    dispatchPlaylistStoreEvent("playlistsChanged");
  }
}

async function openPlaylistsDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };

    const timeout = window.setTimeout(() => {
      finish(null);
    }, PLAYLISTS_DB_OPEN_TIMEOUT_MS);

    try {
      const request = indexedDB.open(PLAYLISTS_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
          db.createObjectStore(PLAYLISTS_STORE);
        }
      };
      request.onsuccess = () => {
        window.clearTimeout(timeout);
        finish(request.result);
      };
      request.onerror = () => {
        window.clearTimeout(timeout);
        finish(null);
      };
      request.onblocked = () => {
        window.clearTimeout(timeout);
        finish(null);
      };
    } catch {
      window.clearTimeout(timeout);
      finish(null);
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
    try {
      const indexedDbPlaylists = dedupePlaylists(
        await Promise.race<PlaylistEntry[]>([
          loadPlaylistsIndexedDb(),
          new Promise<PlaylistEntry[]>((resolve) => {
            window.setTimeout(() => resolve([]), PLAYLISTS_DB_LOAD_TIMEOUT_MS);
          })
        ])
      );
      if (indexedDbPlaylists.length === 0) return;
      if (hydrationRevision !== playlistMutationRevision) return;

      const current = readJsonArray(KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
      const legacy = readJsonArray(LEGACY_KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
      const mergedCurrent = dedupePlaylists([...current, ...legacy]);
      if (mergedCurrent.length > 0) return;

      if (hydrationRevision !== playlistMutationRevision) return;

      safeSetPlaylists(indexedDbPlaylists);
    } finally {
      indexedDbHydrationCompleted = true;
      dispatchPlaylistStoreEvent("playlistsHydrationComplete");
    }
  })();
}

export function isPlaylistsHydrationPending(): boolean {
  return indexedDbHydrationStarted && !indexedDbHydrationCompleted;
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
        if (sessionRaw) {
          const sessionParsed = JSON.parse(sessionRaw) as unknown;
          return extractPlaylistCollection(sessionParsed);
        }
        return readPlaylistsFromWindowName();
      }
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return extractPlaylistCollection(parsed);
  } catch {
    if (key === KEY) {
      try {
        const sessionRaw = sessionStorage.getItem(SESSION_KEY);
        if (sessionRaw) {
          const sessionParsed = JSON.parse(sessionRaw) as unknown;
          return extractPlaylistCollection(sessionParsed);
        }
        return readPlaylistsFromWindowName();
      } catch {
        return readPlaylistsFromWindowName();
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

function writePlaylistsToWindowName(entries: PlaylistEntry[]): void {
  if (typeof window === "undefined") return;

  const encoded = encodeURIComponent(JSON.stringify(entries));
  const current = String(window.name || "");
  const cleaned = current
    .split("|")
    .filter((segment) => !segment.startsWith(WINDOW_NAME_PLAYLIST_PREFIX))
    .join("|");

  const nextSegment = `${WINDOW_NAME_PLAYLIST_PREFIX}${encoded}`;
  window.name = cleaned ? `${cleaned}|${nextSegment}` : nextSegment;
}

function readPlaylistsFromWindowName(): unknown[] {
  if (typeof window === "undefined") return [];

  const raw = String(window.name || "");
  if (!raw) return [];

  const segment = raw
    .split("|")
    .find((part) => part.startsWith(WINDOW_NAME_PLAYLIST_PREFIX));
  if (!segment) return [];

  const encodedPayload = segment.slice(WINDOW_NAME_PLAYLIST_PREFIX.length);
  if (!encodedPayload) return [];

  try {
    const decoded = decodeURIComponent(encodedPayload);
    const parsed = JSON.parse(decoded) as unknown;
    return extractPlaylistCollection(parsed);
  } catch {
    return [];
  }
}

function collectPlaylistsFromStorageArea(area: Storage | null): PlaylistEntry[] {
  if (!area) return [];

  const recovered: PlaylistEntry[] = [];
  const length = Number(area.length || 0);

  for (let index = 0; index < length; index += 1) {
    const key = String(area.key(index) || "");
    if (!key) continue;

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
    safeSetPlaylists(migrated, false);
  }
  return migrated;
}

export function loadPlaylists(): PlaylistEntry[] {
  hydratePlaylistsFromIndexedDb();

  const current = readJsonArray(KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
  const legacy = readJsonArray(LEGACY_KEY).map(toPlaylistEntry).filter((x): x is PlaylistEntry => !!x);
  const merged = dedupePlaylists([...current, ...legacy]);

  if (merged.length > 0) {
    const shouldNormalizePersist = legacy.length > 0 || current.length !== merged.length;
    if (shouldNormalizePersist) {
      safeSetPlaylists(merged, false);
    } else {
      inMemoryPlaylists = [...merged];
    }
    return merged;
  }

  // On localhost dev ports, playlists are origin-scoped by port.
  // If this origin is empty, attempt a one-time import from the common
  // dev origins so localhost:4000 can reuse localhost:5173 data.
  tryImportPlaylistsFromDevOrigins();

  // One-time compatibility recovery for installs where playlists were saved
  // under provider/version-specific storage keys.
  if (!storageKeyRecoveryAttempted) {
    storageKeyRecoveryAttempted = true;
    const recovered = recoverPlaylistsFromAnyStorageKey();
    if (recovered.length > 0) {
      safeSetPlaylists(recovered, false);
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
