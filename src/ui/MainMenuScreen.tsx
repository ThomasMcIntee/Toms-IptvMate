type Props = {
  visible: boolean;
  hasPlaylists: boolean;
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
  { label: "Recordings", panel: "recordings" },
  { label: "Timeline Guide", panel: "timeline" }
];

function formatCount(count: number) {
  return count.toLocaleString();
}

export default function MainMenuScreen({
  visible,
  hasPlaylists,
  liveCount,
  movieCount,
  seriesCount,
  onStartLive,
  onOpenPanel
}: Props) {
  if (!visible) return null;

  const hasLoadedContent = liveCount > 0 || movieCount > 0 || seriesCount > 0;

  return (
    <div className="opening-screen" role="dialog" aria-modal="true" aria-label="Main menu">
      <div className="opening-glow" />
      <div className="opening-card">
        <div className="opening-badge">Welcome</div>
        <h1 className="opening-title">Toms IPTVmate</h1>
        <p className="opening-subtitle">Choose an action to start your session</p>

        <div className="opening-actions">
          <button className="opening-btn opening-btn-primary" onClick={onStartLive}>
            {hasPlaylists ? `Start Live TV${liveCount > 0 ? ` (${formatCount(liveCount)})` : ""}` : "Add Your First Playlist"}
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
            Loaded: {formatCount(liveCount)} live, {formatCount(movieCount)} movies, {formatCount(seriesCount)} series.
          </div>
        )}

        {!hasPlaylists && (
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
