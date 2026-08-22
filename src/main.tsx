import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { getAllChannels } from "./core/channelStore";
import { ProfileProvider } from "./profiles/ProfileContext";
import "./styles/main.css";

const REMOTE_KEYCODE_MAP: Record<number, string> = {
  8: "Backspace",
  13: "Enter",
  27: "Escape",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  461: "Backspace",
  10009: "Backspace",
  29443: "Enter",
  29460: "ArrowLeft",
  29461: "ArrowRight",
  29462: "ArrowUp",
  29463: "ArrowDown"
};

const REMOTE_KEY_ALIASES: Record<string, string> = {
  Back: "Backspace",
  BrowserBack: "Backspace",
  Down: "ArrowDown",
  GoBack: "Backspace",
  Left: "ArrowLeft",
  NumpadEnter: "Enter",
  OK: "Enter",
  Return: "Backspace",
  Right: "ArrowRight",
  Select: "Enter",
  Up: "ArrowUp",
  XF86Back: "Backspace"
};

type NormalizedRemoteKeyboardEvent = KeyboardEvent & {
  webOsRemoteNormalized?: boolean;
};

function isWebOsRuntime(): boolean {
  const agent = String(navigator?.userAgent || "");
  const runtime = (window as Window & { webOS?: unknown; PalmServiceBridge?: unknown }).webOS;
  const isAndroid = /Android/i.test(agent);
  return (/WebOSTV|webOS|LG WebOS/i.test(agent) || Boolean(runtime) || Boolean((window as Window & { PalmServiceBridge?: unknown }).PalmServiceBridge)) && !isAndroid;
}

function isRemoteBackEvent(event: KeyboardEvent): boolean {
  const rawKey = String(event.key || "");
  const normalizedKey = REMOTE_KEY_ALIASES[rawKey] ||
    REMOTE_KEYCODE_MAP[Number(event.keyCode || 0)] ||
    rawKey;
  return normalizedKey === "Backspace" || normalizedKey === "Escape";
}

// Simplified key normalization - NO preventDefault here, let React handle events
function normalizeRemoteKeyEvents() {
  const keepKeyboardFocus = () => {
    if (!document.body) return;
    if (!document.body.hasAttribute("tabindex")) {
      document.body.setAttribute("tabindex", "-1");
    }
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.documentElement) {
      document.body.focus();
    }
  };

  // Focus body on pointer events
  window.addEventListener("pointerdown", () => {
    window.setTimeout(keepKeyboardFocus, 0);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepKeyboardFocus();
    }
  });

  // Normalize remote key values so React sees standard key names
  window.addEventListener("keydown", (event) => {
    const rawKey = String(event.key || "");
    const keyCode = Number(event.keyCode || 0);
    
    // Debug log
    const debugLog = (window as any).webosDebugLog;
    if (debugLog) {
      debugLog(`KEY: ${rawKey} code=${keyCode}`);
    }
    
    // Normalize the key property for React to handle
    const normalizedKey = REMOTE_KEY_ALIASES[rawKey] ||
      REMOTE_KEYCODE_MAP[keyCode];
    
    if (normalizedKey && normalizedKey !== rawKey) {
      try {
        Object.defineProperty(event, "key", { value: normalizedKey, configurable: true });
        Object.defineProperty(event, "code", {
          value: normalizedKey === "Enter" ? "Enter" : normalizedKey,
          configurable: true
        });
      } catch {
        // Some browsers don't allow this
      }
    }
  }, true);

  // Handle Enter on focused elements
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    
    // For video elements, handle play/pause
    if (active instanceof HTMLMediaElement) {
      if (active.paused) void active.play();
      else active.pause();
      event.preventDefault();
      return;
    }
    
    // For buttons, click them
    if (active.tagName === "BUTTON" || active.getAttribute("role") === "button") {
      active.click();
      event.preventDefault();
    }
  });

  keepKeyboardFocus();
}

// Hidden diagnostics: an always-on ring-buffer logger (invisible) plus an
// on-demand overlay toggled with the remote's RED button (keyCode 403) or F2.
// Nothing renders on screen unless explicitly toggled.
declare const __APP_VERSION__: string;

(function initHiddenDiagnostics() {
  const buffer: string[] = [];
  const MAX_LINES = 120;
  let overlay: HTMLDivElement | null = null;

  const appVersion = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

  const describeActiveElement = (): string => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    const cls = String(el.className || "").split(" ")[0];
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };

  const storageSnapshot = (): string[] => {
    const lines: string[] = [];
    try {
      const playlistsRaw = localStorage.getItem("iptvmate_playlists");
      lines.push(`ls playlists: ${playlistsRaw === null ? "null" : `${playlistsRaw.length} chars`}`);
      const channelsRaw = localStorage.getItem("iptvmate_channels_cache");
      lines.push(`ls channels: ${channelsRaw === null ? "null" : `${channelsRaw.length} chars`}`);
      lines.push(`ls keys: ${localStorage.length}`);
    } catch (err) {
      lines.push(`localStorage ERROR: ${err}`);
    }
    lines.push(`webOS.service: ${!!(window as any).webOS?.service}`);
    lines.push(`indexedDB: ${typeof indexedDB !== "undefined"}`);
    lines.push(`focus: ${describeActiveElement()}`);
    return lines;
  };

  const renderOverlay = () => {
    if (!overlay) return;
    overlay.textContent = "";

    const header = document.createElement("div");
    header.style.cssText = "color:#fff;font-weight:bold;margin-bottom:4px;";
    header.textContent = `Toms IPTVmate v${appVersion} — diagnostics (5x UP closes)`;
    overlay.appendChild(header);

    for (const line of storageSnapshot()) {
      const div = document.createElement("div");
      div.style.color = "#9ad1ff";
      div.textContent = line;
      overlay.appendChild(div);
    }

    for (const line of buffer.slice(-40)) {
      const div = document.createElement("div");
      div.textContent = line;
      overlay.appendChild(div);
    }

    overlay.scrollTop = overlay.scrollHeight;
  };

  const record = (msg: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    buffer.push(line);
    if (buffer.length > MAX_LINES) buffer.shift();
    console.log("[webos-debug]", msg);
    renderOverlay();
  };

  (window as any).webosDebugLog = record;

  window.addEventListener("error", (event) => {
    const err = event as ErrorEvent;
    record(`ERROR: ${err.message || "unknown"} @${err.filename || "?"}:${err.lineno || 0}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = String((event as PromiseRejectionEvent).reason || "");
    record(`REJECTION: ${reason.slice(0, 200)}`);
  });

  const toggleOverlay = () => {
    if (overlay) {
      overlay.remove();
      overlay = null;
      return;
    }
    overlay = document.createElement("div");
    overlay.id = "webos-diagnostics-overlay";
    overlay.style.cssText =
      "position:fixed;top:10px;left:10px;right:10px;max-height:70%;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:13px;padding:10px;z-index:999999;overflow:auto;pointer-events:none;white-space:pre-wrap;";
    (document.body || document.documentElement).appendChild(overlay);
    renderOverlay();
  };

  // Toggles: RED color button (keyCode 403), F2 (desktop), or five rapid
  // UP presses (works on remotes without color buttons).
  let upPressTimes: number[] = [];
  window.addEventListener(
    "keydown",
    (event) => {
      if (Number(event.keyCode || 0) === 403 || event.key === "F2") {
        toggleOverlay();
        return;
      }

      const isUp = event.key === "ArrowUp" || event.key === "Up" || Number(event.keyCode || 0) === 38;
      if (!isUp) return;
      const now = Date.now();
      upPressTimes = upPressTimes.filter((t) => now - t < 2500);
      upPressTimes.push(now);
      if (upPressTimes.length >= 5) {
        upPressTimes = [];
        toggleOverlay();
      }
    },
    true
  );

  // Record the first raw key events so the overlay shows exactly what the
  // remote sends on this firmware (key name + keyCode).
  let rawKeyLogCount = 0;
  window.addEventListener(
    "keydown",
    (event) => {
      if (rawKeyLogCount >= 30) return;
      rawKeyLogCount += 1;
      record(`key: "${event.key}" code=${event.keyCode}`);
    },
    true
  );

  // Record pointer events too — diagnoses "clicks do nothing" reports by
  // showing whether the Magic Remote press reaches the page and what it hits.
  let pointerLogCount = 0;
  const describeTarget = (target: EventTarget | null): string => {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return "?";
    const cls = String(el.className || "").split(" ")[0];
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };
  (["mousedown", "mouseup", "click"] as const).forEach((type) => {
    window.addEventListener(
      type,
      (event) => {
        if (pointerLogCount >= 45) return;
        pointerLogCount += 1;
        record(`${type}: ${describeTarget(event.target)}`);
      },
      true
    );
  });

  record(`boot v${appVersion} UA:${navigator.userAgent.slice(0, 60)}`);
})();

normalizeRemoteKeyEvents();

// NOTE: Back key handling is done by webOS SDK (webOSTVjs-1.2.4/webOSTV.js)
// which intercepts Back at document level and dispatches 'webosBackKey' event
// App.tsx listens for that event to handle in-app navigation

async function readBridgePlaylistsFromIndexedDb(): Promise<unknown[]> {
  if (typeof indexedDB === "undefined") return [];

  const DB_NAME = "iptvmate_playlists_cache";
  const STORE_NAME = "playlists";
  const RECORD_KEY = "latest";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown[]) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(value) ? value : []);
    };

    let timeout = window.setTimeout(() => finish([]), 1500);

    try {
      const openRequest = indexedDB.open(DB_NAME, 1);

      openRequest.onerror = () => finish([]);
      openRequest.onblocked = () => finish([]);

      openRequest.onsuccess = () => {
        const db = openRequest.result;
        const closeDb = () => {
          try {
            db.close();
          } catch {
            // Ignore DB close failures.
          }
        };

        const fallbackCursor = () => {
          try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const cursorRequest = store.openCursor();
            const recovered: unknown[] = [];

            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) {
                window.clearTimeout(timeout);
                closeDb();
                finish(recovered);
                return;
              }

              const value = cursor.value;
              if (Array.isArray(value)) recovered.push(...value);
              else if (value && typeof value === "object") {
                const entries = (value as { entries?: unknown }).entries;
                if (Array.isArray(entries)) recovered.push(...entries);
              }

              cursor.continue();
            };

            cursorRequest.onerror = () => {
              window.clearTimeout(timeout);
              closeDb();
              finish(recovered);
            };
            tx.onerror = () => {
              window.clearTimeout(timeout);
              closeDb();
              finish(recovered);
            };
            tx.onabort = () => {
              window.clearTimeout(timeout);
              closeDb();
              finish(recovered);
            };
          } catch {
            window.clearTimeout(timeout);
            closeDb();
            finish([]);
          }
        };

        try {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const getRequest = store.get(RECORD_KEY);

          getRequest.onsuccess = () => {
            const record = getRequest.result as unknown;
            const direct = Array.isArray(record)
              ? record
              : record && typeof record === "object" && Array.isArray((record as { entries?: unknown }).entries)
                ? (record as { entries: unknown[] }).entries
                : [];

            if (direct.length > 0) {
              window.clearTimeout(timeout);
              closeDb();
              finish(direct);
              return;
            }

            fallbackCursor();
          };

          getRequest.onerror = () => fallbackCursor();
          tx.onerror = () => fallbackCursor();
          tx.onabort = () => fallbackCursor();
        } catch {
          fallbackCursor();
        }
      };
    } catch {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => finish([]), 0);
    }
  });
}

async function collectBridgePlaylists(): Promise<unknown[]> {
  let playlists: unknown = [];

  try {
    const localRaw = localStorage.getItem("iptvmate_playlists");
    const sessionRaw = sessionStorage.getItem("iptvmate_playlists_session");
    const raw = localRaw || sessionRaw || "[]";
    playlists = JSON.parse(raw) as unknown;
  } catch {
    playlists = [];
  }

  if (!Array.isArray(playlists) || playlists.length === 0) {
    playlists = await readBridgePlaylistsFromIndexedDb();
  }

  return Array.isArray(playlists) ? playlists : [];
}

async function readBridgeChannelsFromIndexedDb(): Promise<unknown[]> {
  if (typeof indexedDB === "undefined") return [];

  const DB_NAME = "iptvmate_cache";
  const STORE_NAME = "channels";
  const RECORD_KEY = "latest";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown[]) => {
      if (settled) return;
      settled = true;
      resolve(Array.isArray(value) ? value : []);
    };

    const timeout = window.setTimeout(() => finish([]), 1800);

    try {
      const openRequest = indexedDB.open(DB_NAME, 1);
      openRequest.onerror = () => {
        window.clearTimeout(timeout);
        finish([]);
      };
      openRequest.onblocked = () => {
        window.clearTimeout(timeout);
        finish([]);
      };

      openRequest.onsuccess = () => {
        const db = openRequest.result;
        const closeDb = () => {
          try {
            db.close();
          } catch {
            // Ignore close failures.
          }
        };

        try {
          const tx = db.transaction(STORE_NAME, "readonly");
          const store = tx.objectStore(STORE_NAME);
          const getRequest = store.get(RECORD_KEY);

          getRequest.onsuccess = () => {
            window.clearTimeout(timeout);
            const record = getRequest.result as unknown;
            closeDb();

            if (Array.isArray(record)) {
              finish(record);
              return;
            }

            if (record && typeof record === "object") {
              const entries = (record as { entries?: unknown }).entries;
              if (Array.isArray(entries)) {
                finish(entries);
                return;
              }
            }

            finish([]);
          };

          getRequest.onerror = () => {
            window.clearTimeout(timeout);
            closeDb();
            finish([]);
          };
          tx.onerror = () => {
            window.clearTimeout(timeout);
            closeDb();
            finish([]);
          };
          tx.onabort = () => {
            window.clearTimeout(timeout);
            closeDb();
            finish([]);
          };
        } catch {
          window.clearTimeout(timeout);
          closeDb();
          finish([]);
        }
      };
    } catch {
      window.clearTimeout(timeout);
      finish([]);
    }
  });
}

async function collectBridgeChannels(): Promise<unknown[]> {
  const inMemoryChannels = getAllChannels();
  if (Array.isArray(inMemoryChannels) && inMemoryChannels.length > 0) {
    return inMemoryChannels;
  }

  let channels: unknown = [];

  try {
    const localRaw = localStorage.getItem("iptvmate_channels_cache");
    channels = localRaw ? (JSON.parse(localRaw) as unknown) : [];
  } catch {
    channels = [];
  }

  if (!Array.isArray(channels) || channels.length === 0) {
    channels = await readBridgeChannelsFromIndexedDb();
  }

  return Array.isArray(channels) ? channels : [];
}

function enablePopupPlaylistExporter() {
  const params = new URLSearchParams(window.location.search);
  const targetOrigin = String(params.get("iptvmate_export_target") || "").trim();
  const requestId = String(params.get("iptvmate_export_request") || "").trim();
  if (!targetOrigin || !requestId) return;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(targetOrigin)) return;
  if (!window.opener || typeof window.opener.postMessage !== "function") return;

  void (async () => {
    const playlists = await collectBridgePlaylists();
    try {
      window.opener.postMessage(
        {
          type: "iptvmate:popup-playlists",
          requestId,
          playlists
        },
        targetOrigin
      );
    } catch {
      // Ignore popup postMessage failures.
    }

    window.setTimeout(() => {
      try {
        window.close();
      } catch {
        // Ignore close failures.
      }
    }, 150);
  })();
}

function enableLocalPlaylistBridgeResponder() {
  window.addEventListener("message", (event) => {
    const origin = String(event.origin || "");
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return;

    const payload = event.data as { type?: unknown; requestId?: unknown };
    const payloadType = String(payload?.type || "");
    if (!payload || (payloadType !== "iptvmate:request-playlists" && payloadType !== "iptvmate:request-channels")) return;

    const requestId = String(payload.requestId || "");
    if (!requestId) return;

    const sourceWindow = event.source as Window | null;
    if (!sourceWindow || typeof sourceWindow.postMessage !== "function") return;

    void (async () => {
      const data = payloadType === "iptvmate:request-channels"
        ? await collectBridgeChannels()
        : await collectBridgePlaylists();

      try {
        sourceWindow.postMessage(
          {
            type: payloadType === "iptvmate:request-channels"
              ? "iptvmate:response-channels"
              : "iptvmate:response-playlists",
            requestId,
            ...(payloadType === "iptvmate:request-channels" ? { channels: data } : { playlists: data })
          },
          origin
        );
      } catch {
        // Ignore cross-origin response failures.
      }
    })();
  });
}

enablePopupPlaylistExporter();
enableLocalPlaylistBridgeResponder();

type RootErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = {
    hasError: false,
    message: "Unexpected error"
  };

  static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
    const message = error instanceof Error ? error.message : String(error || "Unexpected error");
    return {
      hasError: true,
      message
    };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    console.error("[root-error-boundary]", error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="root-crash-shell">
        <div className="root-crash-card">
          <h1 className="root-crash-title">Playback app crashed</h1>
          <p className="root-crash-text">
            A runtime error occurred. Use reload to recover, then share the error details for a permanent fix.
          </p>
          <pre className="root-crash-message">
{this.state.message}
          </pre>
          <button onClick={this.handleReload} className="root-crash-reload-btn">
            Reload App
          </button>
        </div>
      </div>
    );
  }
}

const app = (
  <RootErrorBoundary>
    <ProfileProvider>
      <App />
    </ProfileProvider>
  </RootErrorBoundary>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  import.meta.env.DEV ? app : <React.StrictMode>{app}</React.StrictMode>
);
