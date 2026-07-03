import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { loadPlaylists, savePlaylist } from "../core/playlistStore";

const PLAYLIST_PANEL_KEYCODE_MAP: Record<number, string> = {
  13: "Enter",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  461: "Backspace",
  29460: "ArrowLeft",
  29461: "ArrowRight",
  29462: "ArrowUp",
  29463: "ArrowDown",
  10009: "Backspace"
};

function normalizedPanelKey(event: ReactKeyboardEvent): string {
  const raw = String(event.key || "");
  if (raw && raw !== "Unidentified") return raw;
  return PLAYLIST_PANEL_KEYCODE_MAP[Number(event.keyCode || 0)] || raw;
}

export default function PlaylistInputMenu({ visible, onPlaylistSaved }: { visible: boolean; onPlaylistSaved?: () => void }) {
  const [tab, setTab] = useState<"m3u" | "xtream" | "stalker">("m3u");
  const [validationError, setValidationError] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Shared fields
  const [name, setName] = useState("");

  // M3U
  const [m3uUrl, setM3uUrl] = useState("");
  const [epgUrl, setEpgUrl] = useState("");

  // Xtream
  const [xtreamUrl, setXtreamUrl] = useState("");
  const [xtreamUser, setXtreamUser] = useState("");
  const [xtreamPass, setXtreamPass] = useState("");

  // Stalker
  const [portalUrl, setPortalUrl] = useState("");
  const [mac, setMac] = useState("");

  useEffect(() => {
    if (!visible) return;

    // On TV remotes there is no tab key, so we force an initial focus target.
    const timer = window.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [visible]);

  function getFocusableElements(): HTMLElement[] {
    if (!panelRef.current) return [];
    const selector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");

    return Array.from(panelRef.current.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => {
        const styles = window.getComputedStyle(el);
        if (styles.display === "none" || styles.visibility === "hidden") return false;
        return el.getClientRects().length > 0;
      }
    );
  }

  function onPanelKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    const key = normalizedPanelKey(event);
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;

    const focusables = getFocusableElements();
    if (focusables.length === 0) return;

    const active = document.activeElement as HTMLElement | null;
    let currentIndex = active ? focusables.indexOf(active) : -1;
    if (currentIndex < 0) {
      currentIndex = key === "ArrowUp" || key === "ArrowLeft" ? focusables.length - 1 : 0;
      focusables[currentIndex]?.focus();
    }

    const isTabButton = active?.dataset?.playlistTab === "true";

    if (key === "ArrowRight" || key === "ArrowLeft" || ((key === "ArrowDown" || key === "ArrowUp") && isTabButton)) {
      if (!isTabButton) {
        const next = key === "ArrowDown"
          ? Math.min(focusables.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
        focusables[next]?.focus();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const tabOrder: Array<"m3u" | "xtream" | "stalker"> = ["m3u", "xtream", "stalker"];
      const tabIndex = tabOrder.indexOf(tab);
      const delta = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(tabOrder.length - 1, tabIndex + delta));
      setTab(tabOrder[nextIndex]);

      window.setTimeout(() => {
        const nextTabButton = panelRef.current?.querySelector<HTMLButtonElement>(
          `button[data-tab-name='${tabOrder[nextIndex]}']`
        );
        nextTabButton?.focus();
      }, 0);

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (key === "ArrowDown") {
      const next = Math.min(focusables.length - 1, currentIndex + 1);
      focusables[next]?.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (key === "ArrowUp") {
      const next = Math.max(0, currentIndex - 1);
      focusables[next]?.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (key === "Enter" && active?.tagName === "BUTTON") {
      active.click();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  if (!visible) return null;

  function addPlaylist() {
    setValidationError("");

    if (!name.trim()) {
      setValidationError("Playlist name is required.");
      return;
    }

    const id = Date.now().toString();

    try {
      if (tab === "m3u") {
        const normalizedM3uUrl = normalizeUrlInput(m3uUrl, "M3U URL");
        const normalizedEpgUrl = epgUrl.trim() ? normalizeUrlInput(epgUrl, "EPG URL") : "";

        savePlaylist({
          id,
          name: name.trim(),
          type: "m3u",
          data: { url: normalizedM3uUrl, epg: normalizedEpgUrl }
        });
      }

      if (tab === "xtream") {
        const normalizedXtreamUrl = normalizeUrlInput(xtreamUrl, "Server URL");
        const cleanUser = xtreamUser.trim();
        const cleanPass = xtreamPass.trim();

        if (!cleanUser || !cleanPass) {
          throw new Error("Xtream username and password are required.");
        }

        savePlaylist({
          id,
          name: name.trim(),
          type: "xtream",
          data: {
            url: normalizedXtreamUrl,
            user: cleanUser,
            pass: cleanPass
          }
        });
      }

      if (tab === "stalker") {
        const normalizedPortalUrl = normalizeUrlInput(portalUrl, "Portal URL");
        const cleanMac = mac.trim();

        if (!cleanMac) {
          throw new Error("MAC address is required.");
        }

        savePlaylist({
          id,
          name: name.trim(),
          type: "stalker",
          data: {
            portal: normalizedPortalUrl,
            mac: cleanMac
          }
        });
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

    setName("");
    setM3uUrl("");
    setEpgUrl("");
    setXtreamUrl("");
    setXtreamUser("");
    setXtreamPass("");
    setPortalUrl("");
    setMac("");
    setTab("m3u");
    
    if (onPlaylistSaved) {
      onPlaylistSaved();
    } else {
      alert("Playlist saved!");
    }
  }

  return (
    <div className="side-panel" ref={panelRef} onKeyDownCapture={onPanelKeyDownCapture}>
      <h2>Add Playlist</h2>

      {validationError && <div className="form-error">{validationError}</div>}

      {/* Tabs */}
      <div className="playlist-tabs">
        <button
          className={tab === "m3u" ? "tab-active" : "tab"}
          data-playlist-tab="true"
          data-tab-name="m3u"
          onClick={() => setTab("m3u")}
        >
          M3U
        </button>
        <button
          className={tab === "xtream" ? "tab-active" : "tab"}
          data-playlist-tab="true"
          data-tab-name="xtream"
          onClick={() => setTab("xtream")}
        >
          Xtream
        </button>
        <button
          className={tab === "stalker" ? "tab-active" : "tab"}
          data-playlist-tab="true"
          data-tab-name="stalker"
          onClick={() => setTab("stalker")}
        >
          Stalker
        </button>
      </div>

      <label>Playlist Name</label>
      <input
        ref={nameInputRef}
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
          <input
            type="password"
            placeholder="password"
            value={xtreamPass}
            onChange={(e) => setXtreamPass(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
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
