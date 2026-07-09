import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { getAllChannels } from "./core/channelStore";
import { ProfileProvider } from "./profiles/ProfileContext";
import "./styles/main.css";

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

  window.addEventListener("pointerdown", () => {
    window.setTimeout(keepKeyboardFocus, 0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepKeyboardFocus();
    }
  });

  keepKeyboardFocus();
}

normalizeRemoteKeyEvents();

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
