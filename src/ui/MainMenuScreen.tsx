import { useEffect, useRef, useState } from "react";

const MAIN_MENU_KEYCODE_MAP: Record<number, string> = {
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown",
  29460: "ArrowLeft",
  29461: "ArrowRight",
  29462: "ArrowUp",
  29463: "ArrowDown",
  461: "Backspace",
  10009: "Backspace"
};

function normalizedMenuKey(event: KeyboardEvent): { key: string; fromFallback: boolean } {
  const raw = String(event.key || "");
  if (raw && raw !== "Unidentified") {
    return { key: raw, fromFallback: false };
  }

  const fallback = MAIN_MENU_KEYCODE_MAP[Number(event.keyCode || 0)] || raw;
  return { key: fallback, fromFallback: true };
}

type Props = {
  visible: boolean;
  hasPlaylists: boolean;
  playlistsHydrationPending: boolean;
  totalCount: number;
  liveCount: number;
  movieCount: number;
  seriesCount: number;
  onStartLive: () => void;
  onOpenPanel: (panel: string) => void;
};

const menuItems = [
  { label: "Add Playlist", panel: "playlist" },
  { label: "Playlist Manager", panel: "playlistManager" },
  { label: "TV Guide Search", panel: "epgSearch" },
  { label: "Setup", panel: "recordings" },
  { label: "Logout", panel: "logout" }
];

function formatCount(count: number) {
  return count.toLocaleString();
}

export default function MainMenuScreen({
  visible,
  hasPlaylists,
  playlistsHydrationPending,
  totalCount,
  liveCount,
  movieCount,
  seriesCount,
  onStartLive,
  onOpenPanel
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastBackHandledAtRef = useRef(0);
  const [hydrationWaitExpired, setHydrationWaitExpired] = useState(false);
  const hasLoadedContent = liveCount > 0 || movieCount > 0 || seriesCount > 0;
  const waitingForPlaylists =
    playlistsHydrationPending &&
    !hydrationWaitExpired &&
    !hasPlaylists &&
    !hasLoadedContent;

  const focusFirstMenuButton = () => {
    const firstBtn = containerRef.current?.querySelector<HTMLButtonElement>(".opening-btn");
    firstBtn?.focus();
  };

  useEffect(() => {
    if (!visible) return;

    const timer = window.setTimeout(focusFirstMenuButton, 0);
    return () => window.clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      setHydrationWaitExpired(false);
      return;
    }

    if (!playlistsHydrationPending) {
      setHydrationWaitExpired(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setHydrationWaitExpired(true);
    }, 3000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [visible, playlistsHydrationPending]);

  useEffect(() => {
    if (!visible) return;

    const timer = window.setTimeout(focusFirstMenuButton, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      const { key, fromFallback } = normalizedMenuKey(event);
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", "Backspace", "Escape"].includes(key)) {
        return;
      }

      if (key === "Backspace" || key === "Escape") {
        const now = Date.now();
        // webOS can emit duplicate back-like events for one button press.
        if (now - lastBackHandledAtRef.current < 350) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        lastBackHandledAtRef.current = now;
        // Let app-level back handler decide navigation instead of forcing exit.
        return;
      }

      const buttons = Array.from(
        containerRef.current?.querySelectorAll<HTMLButtonElement>(".opening-btn") || []
      );
      if (buttons.length === 0) return;

      const active = document.activeElement as HTMLElement | null;
      let index = active ? buttons.indexOf(active as HTMLButtonElement) : -1;
      if (index < 0 && (key === "ArrowDown" || key === "ArrowRight")) {
        buttons[0]?.focus();
        index = 0;
      }
      if (index < 0 && (key === "ArrowUp" || key === "ArrowLeft")) {
        index = buttons.length - 1;
        buttons[index]?.focus();
      }
      if (index < 0) {
        buttons[0]?.focus();
        index = 0;
      }

      if (key === "Enter") {
        // Ignore unreliable fallback Enter to avoid accidental Start Live activation.
        if (fromFallback) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        buttons[index]?.click();
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const delta = key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1;
      const nextIndex = Math.max(0, Math.min(buttons.length - 1, index + delta));
      buttons[nextIndex]?.focus();

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div ref={containerRef} className="opening-screen" role="dialog" aria-modal="true" aria-label="Main menu">
      <div className="opening-glow" />
      <div className="opening-card">
        <div className="opening-badge">Welcome</div>
        <h1 className="opening-title">Toms IPTVmate</h1>
        <p className="opening-subtitle">Choose an action to start your session</p>

        <div className="opening-actions">
          <button className="opening-btn opening-btn-primary" onClick={onStartLive} disabled={waitingForPlaylists}>
            {waitingForPlaylists
              ? "Loading Saved Playlists..."
              : hasPlaylists
                ? `Start Live TV${liveCount > 0 ? ` (${formatCount(liveCount)} live${totalCount > liveCount ? ` / ${formatCount(totalCount)} total` : ""})` : ""}`
                : "Add Your First Playlist"}
          </button>
        </div>

        <div className="opening-quick-actions" aria-label="Content shortcuts">
          <button className="opening-btn opening-btn-secondary opening-btn-quick" onClick={() => onOpenPanel("vod")}>
            Movies{movieCount > 0 ? ` (${formatCount(movieCount)})` : ""}
          </button>
          <button className="opening-btn opening-btn-secondary opening-btn-quick" onClick={() => onOpenPanel("series")}>
            Series{seriesCount > 0 ? ` (${formatCount(seriesCount)})` : ""}
          </button>
        </div>

        {hasLoadedContent && (
          <div className="opening-hint">
            Loaded: {formatCount(totalCount)} total ({formatCount(liveCount)} live, {formatCount(movieCount)} movies, {formatCount(seriesCount)} series).
          </div>
        )}

        {waitingForPlaylists && (
          <div className="opening-hint">
            Checking browser storage for saved playlists.
          </div>
        )}

        {!hasPlaylists && !waitingForPlaylists && (
          <div className="opening-warning">
            No playlists found. Add one first to load channels.
          </div>
        )}

        <div className="opening-menu">
          {menuItems.map((item) => (
            <button
              key={item.panel}
              className="opening-btn opening-btn-secondary"
              onClick={() => onOpenPanel(item.panel)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="opening-hint">Press Esc anytime to reopen this menu.</div>
      </div>
    </div>
  );
}
