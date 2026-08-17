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
  return /WebOSTV|webOS|LG WebOS/i.test(agent) || Boolean(runtime) || Boolean((window as Window & { PalmServiceBridge?: unknown }).PalmServiceBridge);
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

// Debug overlay for webOS TV troubleshooting
function createDebugOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'webos-debug-overlay';
  overlay.style.cssText = 'position:fixed;top:10px;left:10px;background:rgba(0,0,0,0.8);color:#0f0;font-family:monospace;font-size:14px;padding:10px;z-index:999999;max-width:80%;max-height:200px;overflow:auto;pointer-events:none;';
  document.body.appendChild(overlay);
  
  const log = (msg: string) => {
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    overlay.appendChild(line);
    if (overlay.children.length > 25) overlay.removeChild(overlay.firstChild!);
    console.log('[webos-debug]', msg);
  };
  
  log('Debug overlay initialized');
  log(`UA: ${navigator.userAgent.substring(0, 60)}...`);
  log(`webOS detected: ${isWebOsRuntime()}`);
  log(`localStorage: ${typeof localStorage !== 'undefined'}`);
  log(`indexedDB: ${typeof indexedDB !== 'undefined'}`);
  
  // Test localStorage directly
  try {
    const testKey = '__webos_test__';
    localStorage.setItem(testKey, 'ok');
    const testVal = localStorage.getItem(testKey);
    localStorage.removeItem(testKey);
    log(`localStorage test: ${testVal === 'ok' ? 'OK' : 'FAIL'}`);
  } catch (e) {
    log(`localStorage test: ERROR ${e}`);
  }
  
  // Log key events
  window.addEventListener('keydown', (e) => {
    log(`KEY: ${e.key} (code=${e.keyCode})`);
  }, true);
  
  // Make log function globally available
  (window as any).webosDebugLog = log;
  
  // Auto-hide after 60 seconds (longer for debugging)
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 60000);
}

// Initialize debug overlay early
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createDebugOverlay);
} else {
  createDebugOverlay();
}

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
