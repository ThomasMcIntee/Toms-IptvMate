import { useState } from "react";
import { loadPlaylists, savePlaylist, type PlaylistEntry } from "../core/playlistStore";

type SaveDiagnostics = {
  origin: string;
  playlistId: string;
  totalPlaylists: number;
  localStorageHasPlaylist: boolean;
  sessionStorageHasPlaylist: boolean;
  indexedDbHasPlaylist: boolean;
  indexedDbError: string | null;
  at: string;
};

export default function PlaylistInputMenu({ visible, onPlaylistSaved }: { visible: boolean; onPlaylistSaved?: (playlist: PlaylistEntry) => void }) {
  const [tab, setTab] = useState<"m3u" | "xtream" | "stalker">("m3u");
  const [validationError, setValidationError] = useState("");

  // Shared fields
  const [name, setName] = useState("");

  // M3U
  const [m3uUrl, setM3uUrl] = useState("");
  const [epgUrl, setEpgUrl] = useState("");

  // Xtream
  const [xtreamUrl, setXtreamUrl] = useState("");
  const [xtreamUser, setXtreamUser] = useState("");
  const [xtreamPass, setXtreamPass] = useState("");
  const [showXtreamPass, setShowXtreamPass] = useState(false);

  // Stalker
  const [portalUrl, setPortalUrl] = useState("");
  const [mac, setMac] = useState("");
  const [saveDiagnostics, setSaveDiagnostics] = useState<SaveDiagnostics | null>(null);

  if (!visible) return null;

  async function addPlaylist() {
    setValidationError("");

    if (!name.trim()) {
      setValidationError("Playlist name is required.");
      return;
    }

    const id = Date.now().toString();
    let createdPlaylist: PlaylistEntry | null = null;

    try {
      if (tab === "m3u") {
        const normalizedM3uUrl = normalizeUrlInput(m3uUrl, "M3U URL");
        const normalizedEpgUrl = epgUrl.trim() ? normalizeUrlInput(epgUrl, "EPG URL") : "";

        createdPlaylist = {
          id,
          name: name.trim(),
          type: "m3u",
          data: { url: normalizedM3uUrl, epg: normalizedEpgUrl }
        };
        savePlaylist(createdPlaylist);
      }

      if (tab === "xtream") {
        const normalizedXtreamUrl = normalizeUrlInput(xtreamUrl, "Server URL");
        const cleanUser = xtreamUser.trim();
        const cleanPass = xtreamPass.trim();

        if (!cleanUser || !cleanPass) {
          throw new Error("Xtream username and password are required.");
        }

        createdPlaylist = {
          id,
          name: name.trim(),
          type: "xtream",
          data: {
            url: normalizedXtreamUrl,
            user: cleanUser,
            pass: cleanPass
          }
        };
        savePlaylist(createdPlaylist);
      }

      if (tab === "stalker") {
        const normalizedPortalUrl = normalizeUrlInput(portalUrl, "Portal URL");
        const cleanMac = mac.trim();

        if (!cleanMac) {
          throw new Error("MAC address is required.");
        }

        createdPlaylist = {
          id,
          name: name.trim(),
          type: "stalker",
          data: {
            portal: normalizedPortalUrl,
            mac: cleanMac
          }
        };
        savePlaylist(createdPlaylist);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid playlist details.";
      setValidationError(message);
      return;
    }

    // Reset form and notify parent
    const saved = loadPlaylists().some((playlist) => playlist.id === id);
    if (!saved) {
      setValidationError("Playlist could not be saved. Please try again.");
      return;
    }

    const diagnostics = await collectSaveDiagnostics(id);
    setSaveDiagnostics(diagnostics);

    setName("");
    setM3uUrl("");
    setEpgUrl("");
    setXtreamUrl("");
    setXtreamUser("");
    setXtreamPass("");
    setShowXtreamPass(false);
    setPortalUrl("");
    setMac("");
    setTab("m3u");
    
    if (onPlaylistSaved && createdPlaylist) {
      onPlaylistSaved(createdPlaylist);
    } else {
      alert("Playlist saved!");
    }
  }

  return (
    <div className="side-panel">
      <h2>Add Playlist</h2>

      {validationError && <div className="form-error">{validationError}</div>}

      {saveDiagnostics && (
        <div className="playlist-save-diagnostics" role="status" aria-live="polite">
          <div>
            Save verified at {saveDiagnostics.at} on {saveDiagnostics.origin}
          </div>
          <div>
            Playlist ID: {saveDiagnostics.playlistId} | Total playlists: {saveDiagnostics.totalPlaylists}
          </div>
          <div>
            localStorage: {saveDiagnostics.localStorageHasPlaylist ? "ok" : "missing"} | sessionStorage: {saveDiagnostics.sessionStorageHasPlaylist ? "ok" : "missing"} | IndexedDB: {saveDiagnostics.indexedDbHasPlaylist ? "ok" : "missing"}
          </div>
          {saveDiagnostics.indexedDbError && (
            <div>IndexedDB detail: {saveDiagnostics.indexedDbError}</div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="playlist-tabs">
        <button
          className={tab === "m3u" ? "tab-active" : "tab"}
          onClick={() => setTab("m3u")}
        >
          M3U
        </button>
        <button
          className={tab === "xtream" ? "tab-active" : "tab"}
          onClick={() => setTab("xtream")}
        >
          Xtream
        </button>
        <button
          className={tab === "stalker" ? "tab-active" : "tab"}
          onClick={() => setTab("stalker")}
        >
          Stalker
        </button>
      </div>

      <label>Playlist Name</label>
      <input
        type="text"
        placeholder="My IPTV"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          // Allow all keyboard input - stop propagation to prevent parent handlers
          e.stopPropagation();
        }}
      />

      {/* M3U */}
      {tab === "m3u" && (
        <>
          <label>M3U URL</label>
          <input
            type="text"
            placeholder="http://example.com/playlist.m3u"
            value={m3uUrl}
            onChange={(e) => setM3uUrl(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <label>EPG URL (optional)</label>
          <input
            type="text"
            placeholder="http://example.com/epg.xml"
            value={epgUrl}
            onChange={(e) => setEpgUrl(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </>
      )}

      {/* Xtream */}
      {tab === "xtream" && (
        <>
          <label>Server URL</label>
          <input
            type="text"
            placeholder="http://example.com"
            value={xtreamUrl}
            onChange={(e) => setXtreamUrl(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <label>Username</label>
          <input
            type="text"
            placeholder="username"
            value={xtreamUser}
            onChange={(e) => setXtreamUser(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <label>Password</label>
          <div className="password-input-row">
            <input
              type={showXtreamPass ? "text" : "password"}
              placeholder="password"
              value={xtreamPass}
              onChange={(e) => setXtreamPass(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              className="btn-secondary password-toggle-btn"
              onClick={() => setShowXtreamPass((value) => !value)}
            >
              {showXtreamPass ? "Hide" : "Show"}
            </button>
          </div>
        </>
      )}

      {/* Stalker */}
      {tab === "stalker" && (
        <>
          <label>Portal URL</label>
          <input
            type="text"
            placeholder="http://example.com/c/"
            value={portalUrl}
            onChange={(e) => setPortalUrl(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />

          <label>MAC Address</label>
          <input
            type="text"
            placeholder="00:1A:79:XX:XX:XX"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </>
      )}

      <button className="btn-primary" onClick={addPlaylist}>
        Save Playlist
      </button>
    </div>
  );
}

async function collectSaveDiagnostics(playlistId: string): Promise<SaveDiagnostics> {
  const origin = typeof window !== "undefined" ? window.location.origin : "unknown";

  let localStorageHasPlaylist = false;
  try {
    const raw = localStorage.getItem("iptvmate_playlists");
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        localStorageHasPlaylist = parsed.some((item) => String((item as { id?: unknown })?.id || "") === playlistId);
      }
    }
  } catch {
    localStorageHasPlaylist = false;
  }

  let sessionStorageHasPlaylist = false;
  try {
    const raw = sessionStorage.getItem("iptvmate_playlists_session");
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        sessionStorageHasPlaylist = parsed.some((item) => String((item as { id?: unknown })?.id || "") === playlistId);
      }
    }
  } catch {
    sessionStorageHasPlaylist = false;
  }

  const indexedDb = await readPlaylistFromIndexedDb(playlistId);

  return {
    origin,
    playlistId,
    totalPlaylists: loadPlaylists().length,
    localStorageHasPlaylist,
    sessionStorageHasPlaylist,
    indexedDbHasPlaylist: indexedDb.hasPlaylist,
    indexedDbError: indexedDb.error,
    at: new Date().toLocaleTimeString()
  };
}

async function readPlaylistFromIndexedDb(playlistId: string): Promise<{ hasPlaylist: boolean; error: string | null }> {
  if (typeof indexedDB === "undefined") {
    return { hasPlaylist: false, error: "indexedDB unavailable" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { hasPlaylist: boolean; error: string | null }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timeout = window.setTimeout(() => {
      finish({ hasPlaylist: false, error: "indexedDB read timeout" });
    }, 1600);

    try {
      const openRequest = indexedDB.open("iptvmate_playlists_cache", 1);

      openRequest.onerror = () => {
        window.clearTimeout(timeout);
        finish({ hasPlaylist: false, error: `indexedDB open failed: ${openRequest.error?.message || "unknown"}` });
      };

      openRequest.onblocked = () => {
        window.clearTimeout(timeout);
        finish({ hasPlaylist: false, error: "indexedDB open blocked" });
      };

      openRequest.onsuccess = () => {
        const db = openRequest.result;

        try {
          const tx = db.transaction("playlists", "readonly");
          const getRequest = tx.objectStore("playlists").get("latest");

          getRequest.onerror = () => {
            window.clearTimeout(timeout);
            try {
              db.close();
            } catch {
              // Ignore close failures.
            }
            finish({ hasPlaylist: false, error: `indexedDB read failed: ${getRequest.error?.message || "unknown"}` });
          };

          getRequest.onsuccess = () => {
            const value = getRequest.result as unknown;
            let hasPlaylist = false;

            if (Array.isArray(value)) {
              hasPlaylist = value.some((item) => String((item as { id?: unknown })?.id || "") === playlistId);
            } else if (value && typeof value === "object") {
              const wrapped = value as { playlists?: unknown[] };
              if (Array.isArray(wrapped.playlists)) {
                hasPlaylist = wrapped.playlists.some((item) => String((item as { id?: unknown })?.id || "") === playlistId);
              }
            }

            window.clearTimeout(timeout);
            try {
              db.close();
            } catch {
              // Ignore close failures.
            }
            finish({ hasPlaylist, error: null });
          };
        } catch (err) {
          window.clearTimeout(timeout);
          try {
            db.close();
          } catch {
            // Ignore close failures.
          }
          finish({ hasPlaylist: false, error: `indexedDB transaction failed: ${String(err)}` });
        }
      };
    } catch (err) {
      window.clearTimeout(timeout);
      finish({ hasPlaylist: false, error: `indexedDB exception: ${String(err)}` });
    }
  });
}

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
