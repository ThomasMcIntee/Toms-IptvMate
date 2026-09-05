declare const __APP_VERSION__: string;

const REMOTE_KEYCODE_MAP: Record<number, string> = {
  4: "Escape",
  8: "Backspace",
  13: "Enter",
  23: "Enter",
  66: "Enter",
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
  29463: "ArrowDown",
  19: "MediaPause",
  412: "MediaRewind",
  413: "MediaStop",
  415: "MediaPlay",
  417: "MediaFastForward",
  463: "MediaPlayPause",
  10252: "MediaPlayPause"
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
  XF86Back: "Backspace",
  Play: "MediaPlay",
  Pause: "MediaPause",
  PlayPause: "MediaPlayPause",
  Rewind: "MediaRewind",
  FastForward: "MediaFastForward",
  FastFwd: "MediaFastForward",
  Stop: "MediaStop"
};

function isInteractiveRemoteTarget(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return null;
  return el.closest("button, [role='button'], a, input, select, textarea");
}

function enableMagicRemotePointerClicks() {
  // LG Magic Remote pointer often delivers mousedown/mouseup without a click.
  let lastClickAt = 0;
  window.addEventListener(
    "click",
    () => {
      lastClickAt = Date.now();
    },
    true
  );
  window.addEventListener("mouseup", (event) => {
    const control = isInteractiveRemoteTarget(event.target);
    if (!control) return;
    if (control instanceof HTMLButtonElement && control.disabled) return;
    if (control instanceof HTMLInputElement && control.disabled) return;
    window.setTimeout(() => {
      if (Date.now() - lastClickAt <= 250) return;
      control.click();
    }, 260);
  });
}

function normalizeRemoteKeyEvents() {
  const keepKeyboardFocus = () => {
    if (!document.body) return;
    if (!document.body.hasAttribute("tabindex")) {
      document.body.setAttribute("tabindex", "-1");
    }
    const active = document.activeElement as HTMLElement | null;
    if (active instanceof HTMLMediaElement) {
      active.blur();
      document.body.focus();
      return;
    }
    if (!active || active === document.documentElement) {
      document.body.focus();
    }
  };

  window.addEventListener("pointerdown", (event) => {
    const control = isInteractiveRemoteTarget(event.target);
    window.setTimeout(() => {
      if (control && !(control instanceof HTMLMediaElement) && document.contains(control)) {
        try {
          control.focus();
        } catch {
          keepKeyboardFocus();
        }
        return;
      }
      keepKeyboardFocus();
    }, 0);
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLMediaElement) {
      target.blur();
      keepKeyboardFocus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      keepKeyboardFocus();
    }
  });

  window.addEventListener("keydown", (event) => {
    const rawKey = String(event.key || "");
    const keyCode = Number(event.keyCode || 0);
    const normalizedKey = REMOTE_KEY_ALIASES[rawKey] || REMOTE_KEYCODE_MAP[keyCode];
    if (normalizedKey && normalizedKey !== rawKey) {
      try {
        Object.defineProperty(event, "key", { value: normalizedKey, configurable: true });
        Object.defineProperty(event, "code", {
          value: normalizedKey === "Enter" ? "Enter" : normalizedKey,
          configurable: true
        });
      } catch {
        // Some browsers don't allow this.
      }
    }
  }, true);

  window.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;

    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    if (active instanceof HTMLMediaElement) {
      if (active.paused) void active.play();
      else active.pause();
      event.preventDefault();
      return;
    }

    if (active.tagName === "BUTTON" || active.getAttribute("role") === "button") {
      active.click();
      event.preventDefault();
    }
  });

  enableMagicRemotePointerClicks();
  keepKeyboardFocus();
}

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
  const { getAllChannels } = await import("./core/channelStore");
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
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|app)(:\d+)?$/i.test(targetOrigin)) return;
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
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|app)(:\d+)?$/i.test(origin)) return;

    const payload = event.data as { type?: unknown; requestId?: unknown };
    const payloadType = String(payload?.type || "");
    if (!payload || (payloadType !== "iptvmate:request-playlists" && payloadType !== "iptvmate:request-channels")) {
      return;
    }

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

let runtimeInitialized = false;

export function initRuntimeSetup() {
  if (runtimeInitialized) return;
  runtimeInitialized = true;

  normalizeRemoteKeyEvents();
  enablePopupPlaylistExporter();
  enableLocalPlaylistBridgeResponder();
}
