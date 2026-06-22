import { useState } from "react";
import { savePlaylist } from "../core/playlistStore";

export default function PlaylistInputMenu({ visible }: { visible: boolean }) {
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

  // Stalker
  const [portalUrl, setPortalUrl] = useState("");
  const [mac, setMac] = useState("");

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

    alert("Playlist saved!");
  }

  return (
    <div className="side-panel">
      <h2>Add Playlist</h2>

      {validationError && <div className="form-error">{validationError}</div>}

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
          />

          <label>EPG URL (optional)</label>
          <input
            type="text"
            placeholder="http://example.com/epg.xml"
            value={epgUrl}
            onChange={(e) => setEpgUrl(e.target.value)}
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
          />

          <label>Username</label>
          <input
            type="text"
            placeholder="username"
            value={xtreamUser}
            onChange={(e) => setXtreamUser(e.target.value)}
          />

          <label>Password</label>
          <input
            type="password"
            placeholder="password"
            value={xtreamPass}
            onChange={(e) => setXtreamPass(e.target.value)}
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
          />

          <label>MAC Address</label>
          <input
            type="text"
            placeholder="00:1A:79:XX:XX:XX"
            value={mac}
            onChange={(e) => setMac(e.target.value)}
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
